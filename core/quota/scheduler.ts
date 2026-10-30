import type { ProviderConfig } from '../types'
import type { RuntimeStore } from '../router/runtime'
import { opencodeGoAdapter } from './opencodeGo'
import { deepseekBalanceAdapter } from './deepseek'
import { commandCodeAdapter } from './commandcode'
import type { ProbeFetchFn, QuotaAdapter } from './types'

const SLOW_PROBE_INTERVAL_MS = 5 * 60 * 1000
const SLOW_PROBE_ADAPTERS = new Set<ProviderConfig['quotaAdapter']>(['deepseek-balance', 'commandcode-usage'])
const PROBE_BACKOFF_BASE_MS = 30 * 1000
const PROBE_BACKOFF_MAX_MS = 15 * 60 * 1000

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  // fetch 的网络错误只有 "fetch failed"，真正原因（DNS/TLS/连接重置）在 cause 里。
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) return `${error.message}: ${cause.message}`
  return cause ? `${error.message}: ${String(cause)}` : error.message
}

// 连续失败按 30s/1m/2m/4m/8m/15m 退避：既不放弃探针，也不在上游抖动时每分钟打一次。
function probeBackoffMs(failures: number): number {
  return Math.min(PROBE_BACKOFF_MAX_MS, PROBE_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(failures - 1, 0), 5))
}

// 定时探针只负责写 runtime 并触发 onUpdate；持久化 quota-cache 由 Hub 的显式刷新路径完成。
export class QuotaScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSlowProbe = new Map<string, number>()
  private nextProbeAt = new Map<string, number>()

  constructor(
    private readonly runtime: RuntimeStore,
    private readonly getProviders: () => ProviderConfig[],
    private readonly getKey: (id: string) => string | null,
    private readonly onUpdate: () => void,
    private readonly now: () => Date = () => new Date(),
    private readonly fetchFn?: ProbeFetchFn,
    private readonly log?: (message: string) => void
  ) {}

  start(intervalMs: number): void {
    this.stop()
    this.timer = setInterval(() => void this.refreshAll(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 手动“恢复”后清掉退避与节流，下一次 tick 立即重试。 */
  resetBackoff(id: string): void {
    this.nextProbeAt.delete(id)
    this.lastSlowProbe.delete(id)
  }

  async refreshAll(force = false): Promise<void> {
    const nowMs = this.now().getTime()
    for (const provider of this.getProviders()) {
      if (!provider.enabled || provider.quotaAdapter === 'none') continue
      const key = this.getKey(provider.id)
      if (!key) continue
      const runtime = this.runtime.get(provider.id)
      // auth_error 只能由用户手动 reset 恢复：继续探测会形成 401 循环。
      if (runtime.availability === 'auth_error') continue
      if (!force) {
        if ((this.nextProbeAt.get(provider.id) ?? 0) > nowMs) continue
        if (SLOW_PROBE_ADAPTERS.has(provider.quotaAdapter)) {
          const last = this.lastSlowProbe.get(provider.id) ?? 0
          if (nowMs - last < SLOW_PROBE_INTERVAL_MS) continue
        }
      }
      const adapter = this.adapterFor(provider)
      if (!adapter) continue
      try {
        const snapshot = await adapter.probe(provider, key, { fetchFn: this.fetchFn, now: this.now })
        this.nextProbeAt.delete(provider.id)
        if (SLOW_PROBE_ADAPTERS.has(provider.quotaAdapter)) this.lastSlowProbe.set(provider.id, nowMs)
        this.runtime.markProbe(provider, snapshot)
      } catch (error) {
        // 探针失败不改变路由状态；只退避重试，绝不永久停用。
        runtime.probeFailures += 1
        const delay = probeBackoffMs(runtime.probeFailures)
        this.nextProbeAt.set(provider.id, nowMs + delay)
        this.log?.(`quota probe failed for ${provider.name} (${runtime.probeFailures}x): ${messageOf(error)}; retry in ${Math.round(delay / 1000)}s`)
      }
      this.onUpdate()
    }
  }

  async refreshOne(provider: ProviderConfig, apiKey: string): Promise<void> {
    const adapter = this.adapterFor(provider)
    if (!adapter) return
    try {
      const snapshot = await adapter.probe(provider, apiKey, { fetchFn: this.fetchFn, now: this.now })
      this.nextProbeAt.delete(provider.id)
      if (SLOW_PROBE_ADAPTERS.has(provider.quotaAdapter)) this.lastSlowProbe.set(provider.id, this.now().getTime())
      this.runtime.markProbe(provider, snapshot)
      this.onUpdate()
    } catch (error) {
      const runtime = this.runtime.get(provider.id)
      runtime.probeFailures += 1
      this.nextProbeAt.set(provider.id, this.now().getTime() + probeBackoffMs(runtime.probeFailures))
      this.onUpdate()
      throw error
    }
  }

  private adapterFor(provider: ProviderConfig): QuotaAdapter | null {
    if (provider.quotaAdapter === 'opencode-go') return opencodeGoAdapter
    if (provider.quotaAdapter === 'deepseek-balance') return deepseekBalanceAdapter
    if (provider.quotaAdapter === 'commandcode-usage') return commandCodeAdapter
    return null
  }
}
