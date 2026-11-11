import type { MergedModel, ProviderConfig, UpstreamFailure } from '../types'
import { parseRequestedModel, providerSupports } from '../providers/catalog'
import type { RuntimeStore } from './runtime'

export interface Candidate {
  provider: ProviderConfig
  upstreamModel: string
}

export interface Resolution {
  model: string
  modelKnown: boolean
  candidates: Candidate[]
  // 候选全被冷却挡掉时的最短剩余冷却；用于 503 的 Retry-After。
  retryAfterMs: number | null
}

function shortestCooldown(runtime: RuntimeStore, providerIds: string[]): number | null {
  let shortest: number | null = null
  for (const id of providerIds) {
    const remaining = runtime.cooldownRemainingMs(id)
    if (remaining <= 0) continue
    shortest = shortest === null ? remaining : Math.min(shortest, remaining)
  }
  return shortest
}

export function resolveCandidates(input: {
  requestedModel: string
  providers: ProviderConfig[]
  catalog: MergedModel[]
  runtime: RuntimeStore
}): Resolution {
  const { requestedModel, providers, catalog, runtime } = input
  // canonical 模型 ID 优先于 provider/model 拆解：统一 ID 本身可以包含斜杠。
  const direct = catalog.find((model) => model.id === requestedModel)
  const parsed = direct ? { providerId: null, model: requestedModel } : parseRequestedModel(requestedModel, providers)
  if (parsed.providerId) {
    const provider = providers.find((p) => p.id === parsed.providerId)
    if (!provider) return { model: parsed.model, modelKnown: false, candidates: [], retryAfterMs: null }
    const canonicalTarget = catalog
      .find((model) => model.id === parsed.model)
      ?.targets.find((target) => target.providerId === provider.id)
    const aliasTarget = catalog.find((model) =>
      model.targets.some((target) => target.providerId === provider.id && target.upstreamModel === parsed.model)
    )
    const upstreamModel = canonicalTarget?.upstreamModel ?? (aliasTarget || providerSupports(provider, parsed.model) ? parsed.model : null)
    const known = Boolean(upstreamModel) && provider.enabled
    const candidates = known && runtime.isRoutable(provider.id) ? [{ provider, upstreamModel: upstreamModel! }] : []
    return {
      model: parsed.model,
      modelKnown: known,
      candidates,
      retryAfterMs: candidates.length === 0 ? shortestCooldown(runtime, [provider.id]) : null
    }
  }
  const entry = catalog.find((m) => m.id === parsed.model)
  if (!entry) return { model: parsed.model, modelKnown: false, candidates: [], retryAfterMs: null }
  const providerOrder = new Map(providers.map((provider, index) => [provider.id, index]))
  const targets = [...entry.targets].sort(
    (a, b) => (providerOrder.get(a.providerId) ?? Number.MAX_SAFE_INTEGER) - (providerOrder.get(b.providerId) ?? Number.MAX_SAFE_INTEGER)
  )
  const candidates: Candidate[] = []
  const cooling: string[] = []
  for (const target of targets) {
    const provider = providers.find((p) => p.id === target.providerId)
    if (!provider || !provider.enabled) continue
    if (!runtime.isRoutable(provider.id)) {
      cooling.push(provider.id)
      continue
    }
    candidates.push({ provider, upstreamModel: target.upstreamModel })
  }
  return {
    model: parsed.model,
    modelKnown: true,
    candidates,
    retryAfterMs: candidates.length === 0 ? shortestCooldown(runtime, cooling) : null
  }
}

export type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: UpstreamFailure }
  // 供应商并发已满：从未发往上游，不算故障，直接尝试下一个候选。
  | { ok: false; saturated: true }

export type FailoverResult<T> =
  | { ok: true; candidate: Candidate; value: T; tried: string[] }
  | { ok: false; failure: UpstreamFailure; tried: string[]; saturated?: true }

export interface FailoverOptions {
  onModelMissing?: (providerId: string) => void
  onQuotaFailure?: (providerId: string) => void
  signal?: AbortSignal
  // 429 短退避时长；测试传 0 可立即重试。Retry-After 更长时以 Retry-After 为准，
  // 但超过上限就直接切换，避免把客户端拖在冷却窗口里。
  rateLimitRetryMs?: number
}

const RATE_LIMIT_RETRY_DEFAULT_MS = 1_500
const RATE_LIMIT_RETRY_MAX_WAIT_MS = 3_000

function rateLimitRetryDelay(failure: UpstreamFailure, configuredMs: number | undefined): number | null {
  if (failure.kind !== 'rate_limit' || failure.status !== 429) return null
  const wait = failure.retryAfterMs ?? configuredMs ?? RATE_LIMIT_RETRY_DEFAULT_MS
  if (wait > RATE_LIMIT_RETRY_MAX_WAIT_MS) return null
  return Math.max(0, wait)
}

function waitBeforeRetry(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (ms <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve(true)
    }, ms)
    const onAbort = () => {
      cleanup()
      resolve(false)
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function executeWithFailover<T>(
  candidates: Candidate[],
  attempt: (candidate: Candidate) => Promise<AttemptResult<T>>,
  runtime: RuntimeStore,
  hooks: FailoverOptions = {}
): Promise<FailoverResult<T>> {
  const tried: string[] = []
  let lastFailure: UpstreamFailure | null = null
  let saturatedCount = 0
  for (const candidate of candidates) {
    let result = await attempt(candidate)
    if (!result.ok && 'saturated' in result) {
      saturatedCount += 1
      continue
    }
    tried.push(candidate.provider.id)
    if (!result.ok) {
      const retryDelay = rateLimitRetryDelay(result.failure, hooks.rateLimitRetryMs)
      if (retryDelay !== null) {
        const alive = await waitBeforeRetry(retryDelay, hooks.signal)
        if (!alive) {
          return {
            ok: false,
            failure: { kind: 'request', status: null, message: 'client aborted the request', retryAfterMs: null },
            tried
          }
        }
        const retried = await attempt(candidate)
        if (retried.ok) {
          runtime.markSuccess(candidate.provider.id)
          return { ok: true, candidate, value: retried.value, tried }
        }
        if ('saturated' in retried) {
          // 退避期间槽位被其他请求抢走：保留原失败，继续尝试下一个候选。
          lastFailure = result.failure
          continue
        }
        result = retried
      }
    }
    if (result.ok) {
      runtime.markSuccess(candidate.provider.id)
      return { ok: true, candidate, value: result.value, tried }
    }
    lastFailure = result.failure
    if (result.failure.kind === 'model_missing') hooks.onModelMissing?.(candidate.provider.id)
    if (result.failure.kind === 'quota') hooks.onQuotaFailure?.(candidate.provider.id)
    runtime.markFailure(candidate.provider, result.failure)
    if (result.failure.kind === 'request') break
  }
  if (tried.length === 0 && saturatedCount > 0) {
    // 全部候选并发已满且没有一个真正发往上游：交给上层按最高优先级排队。
    return {
      ok: false,
      failure: { kind: 'unknown', status: 503, message: 'all candidate providers are at their concurrency limit', retryAfterMs: null },
      tried,
      saturated: true
    }
  }
  return {
    ok: false,
    failure: lastFailure ?? { kind: 'unknown', status: null, message: 'no candidate providers', retryAfterMs: null },
    tried
  }
}
