import type { ProviderConfig, ProviderRuntime, QuotaSnapshot, UpstreamFailure } from '../types'

// 首字节前的瞬时故障通常 10s 内可恢复；仍失败说明上游/网络持续异常，再逐级退避到 1 分钟。
const TRANSIENT_COOLDOWN_BASE_MS = 10_000
const TRANSIENT_COOLDOWN_MAX_MS = 60_000

function transientCooldownMs(streak: number): number {
  const exponent = Math.min(Math.max(streak - 1, 0), 3)
  return Math.min(TRANSIENT_COOLDOWN_MAX_MS, TRANSIENT_COOLDOWN_BASE_MS * 2 ** exponent)
}

export class RuntimeStore {
  private states = new Map<string, ProviderRuntime>()

  constructor(private readonly now: () => Date = () => new Date()) {}

  get(id: string): ProviderRuntime {
    let state = this.states.get(id)
    if (!state) {
      state = {
        providerId: id,
        availability: 'unknown',
        cooldownUntil: null,
        lastErrorKind: null,
        consecutiveFailures: 0,
        transientFailures: 0,
        quota: null,
        probeFailures: 0,
        probeDisabled: false
      }
      this.states.set(id, state)
    }
    return state
  }

  all(): ProviderRuntime[] {
    return [...this.states.values()]
  }

  isRoutable(id: string): boolean {
    const state = this.get(id)
    if (state.availability === 'auth_error') return false
    if (state.cooldownUntil && Date.parse(state.cooldownUntil) > this.now().getTime()) return false
    return true
  }

  /** 冷却剩余毫秒；未冷却返回 0。用于无候选时给客户端下发 Retry-After。 */
  cooldownRemainingMs(id: string): number {
    const state = this.states.get(id)
    if (!state?.cooldownUntil) return 0
    const until = Date.parse(state.cooldownUntil)
    if (Number.isNaN(until)) return 0
    return Math.max(0, until - this.now().getTime())
  }

  markSuccess(id: string): void {
    const state = this.get(id)
    state.availability = 'ok'
    state.cooldownUntil = null
    state.lastErrorKind = null
    state.consecutiveFailures = 0
    state.transientFailures = 0
  }

  markFailure(provider: ProviderConfig, failure: UpstreamFailure): void {
    const state = this.get(provider.id)
    state.lastErrorKind = failure.kind
    state.consecutiveFailures += 1
    const now = this.now().getTime()
    if (failure.kind === 'quota') {
      state.availability = 'exhausted'
      state.cooldownUntil = new Date(now + provider.quota.quotaCooldownMs).toISOString()
    } else if (failure.kind === 'rate_limit') {
      state.availability = 'rate_limited'
      state.cooldownUntil = new Date(now + (failure.retryAfterMs ?? TRANSIENT_COOLDOWN_MAX_MS)).toISOString()
    } else if (failure.kind === 'auth') {
      state.availability = 'auth_error'
      state.cooldownUntil = null
    } else if (failure.kind === 'transient') {
      // 客户端中断（kind=request）不进来；只有真实上游/网络故障才升级退避。
      state.transientFailures += 1
      state.availability = 'unknown'
      state.cooldownUntil = new Date(now + transientCooldownMs(state.transientFailures)).toISOString()
    }
  }

  markProbe(provider: ProviderConfig, snapshot: QuotaSnapshot): void {
    const state = this.get(provider.id)
    state.quota = snapshot
    if (snapshot.availability === 'auth_error') {
      state.availability = 'auth_error'
      state.cooldownUntil = null
      return
    }
    if (snapshot.availability === 'exhausted') {
      state.availability = 'exhausted'
      const windows = [snapshot.windows?.rolling, snapshot.windows?.weekly, snapshot.windows?.monthly]
      const resets = windows
        .filter((w) => w && (w.percent >= 100 || w.status === 'rate-limited'))
        .map((w) => w!.resetsAt)
        .filter((v): v is string => Boolean(v))
      const latest = resets.sort().at(-1)
      const until = latest ? Date.parse(latest) : this.now().getTime() + provider.quota.quotaCooldownMs
      state.cooldownUntil = new Date(Math.max(until, this.now().getTime())).toISOString()
      return
    }
    state.availability = 'ok'
    state.cooldownUntil = null
    state.lastErrorKind = null
  }

  reset(id: string): void {
    const state = this.get(id)
    state.availability = 'ok'
    state.cooldownUntil = null
    state.lastErrorKind = null
    state.consecutiveFailures = 0
    state.transientFailures = 0
    state.probeFailures = 0
    state.probeDisabled = false
  }

  remove(id: string): void {
    this.states.delete(id)
  }
}
