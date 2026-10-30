import type { ProviderConfig } from '../types'
import type { RuntimeStore } from '../router/runtime'
import { opencodeGoAdapter } from './opencodeGo'
import { deepseekBalanceAdapter } from './deepseek'
import { commandCodeAdapter } from './commandcode'
import type { ProbeFetchFn, QuotaAdapter } from './types'

const DEEPSEEK_INTERVAL_MS = 5 * 60 * 1000

// 定时探针只负责写 runtime 并触发 onUpdate；持久化 quota-cache 由 Hub 的显式刷新路径完成。
export class QuotaScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastDeepSeek = new Map<string, number>()

  constructor(
    private readonly runtime: RuntimeStore,
    private readonly getProviders: () => ProviderConfig[],
    private readonly getKey: (id: string) => string | null,
    private readonly onUpdate: () => void,
    private readonly now: () => Date = () => new Date(),
    private readonly fetchFn?: ProbeFetchFn
  ) {}

  start(intervalMs: number): void {
    this.stop()
    this.timer = setInterval(() => void this.refreshAll(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async refreshAll(force = false): Promise<void> {
    for (const provider of this.getProviders()) {
      if (!provider.enabled || provider.quotaAdapter === 'none') continue
      const key = this.getKey(provider.id)
      if (!key) continue
      const runtime = this.runtime.get(provider.id)
      // auth_error 只能由用户手动 reset 恢复：继续探测会形成 401 循环。
      if (runtime.probeDisabled || runtime.availability === 'auth_error') continue
      if (provider.quotaAdapter === 'deepseek-balance' && !force) {
        const last = this.lastDeepSeek.get(provider.id) ?? 0
        if (this.now().getTime() - last < DEEPSEEK_INTERVAL_MS) continue
      }
      const adapter = this.adapterFor(provider)
      if (!adapter) continue
      try {
        const snapshot = await adapter.probe(provider, key, { fetchFn: this.fetchFn, now: this.now })
        runtime.probeFailures = 0
        this.runtime.markProbe(provider, snapshot)
        if (provider.quotaAdapter === 'deepseek-balance') this.lastDeepSeek.set(provider.id, this.now().getTime())
      } catch {
        // 探针失败不改变路由状态；连续 3 次后停用探针，回退到错误码模式。
        runtime.probeFailures += 1
        if (runtime.probeFailures >= 3) runtime.probeDisabled = true
      }
      this.onUpdate()
    }
  }

  async refreshOne(provider: ProviderConfig, apiKey: string): Promise<void> {
    const adapter = this.adapterFor(provider)
    if (!adapter) return
    const snapshot = await adapter.probe(provider, apiKey, { fetchFn: this.fetchFn, now: this.now })
    this.runtime.markProbe(provider, snapshot)
    this.onUpdate()
  }

  private adapterFor(provider: ProviderConfig): QuotaAdapter | null {
    if (provider.quotaAdapter === 'opencode-go') return opencodeGoAdapter
    if (provider.quotaAdapter === 'deepseek-balance') return deepseekBalanceAdapter
    if (provider.quotaAdapter === 'commandcode-usage') return commandCodeAdapter
    return null
  }
}
