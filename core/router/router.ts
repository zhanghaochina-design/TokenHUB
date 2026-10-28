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
}

export function resolveCandidates(input: {
  requestedModel: string
  providers: ProviderConfig[]
  catalog: MergedModel[]
  runtime: RuntimeStore
}): Resolution {
  const { requestedModel, providers, catalog, runtime } = input
  const parsed = parseRequestedModel(requestedModel, providers)
  if (parsed.providerId) {
    const provider = providers.find((p) => p.id === parsed.providerId)!
    const known = provider.enabled && providerSupports(provider, parsed.model)
    const candidates = known && runtime.isRoutable(provider.id) ? [{ provider, upstreamModel: parsed.model }] : []
    return { model: parsed.model, modelKnown: known, candidates }
  }
  const entry = catalog.find((m) => m.id === parsed.model)
  if (!entry) return { model: parsed.model, modelKnown: false, candidates: [] }
  const candidates: Candidate[] = []
  for (const id of entry.providers) {
    const provider = providers.find((p) => p.id === id)
    if (!provider || !provider.enabled || !providerSupports(provider, parsed.model) || !runtime.isRoutable(id)) continue
    candidates.push({ provider, upstreamModel: parsed.model })
  }
  return { model: parsed.model, modelKnown: true, candidates }
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
