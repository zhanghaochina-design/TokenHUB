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

export type AttemptResult<T> = { ok: true; value: T } | { ok: false; failure: UpstreamFailure }

export type FailoverResult<T> =
  | { ok: true; candidate: Candidate; value: T; tried: string[] }
  | { ok: false; failure: UpstreamFailure; tried: string[] }

export async function executeWithFailover<T>(
  candidates: Candidate[],
  attempt: (candidate: Candidate) => Promise<AttemptResult<T>>,
  runtime: RuntimeStore,
  hooks: { onModelMissing?: (providerId: string) => void; onQuotaFailure?: (providerId: string) => void } = {}
): Promise<FailoverResult<T>> {
  const tried: string[] = []
  let lastFailure: UpstreamFailure | null = null
  for (const candidate of candidates) {
    tried.push(candidate.provider.id)
    const result = await attempt(candidate)
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
  return {
    ok: false,
    failure: lastFailure ?? { kind: 'unknown', status: null, message: 'no candidate providers', retryAfterMs: null },
    tried
  }
}
