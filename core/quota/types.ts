import type { ProviderConfig, QuotaSnapshot } from '../types'

export type ProbeFetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface ProbeOptions {
  fetchFn?: ProbeFetchFn
  now?: () => Date
}

export interface QuotaAdapter {
  id: Exclude<ProviderConfig['quotaAdapter'], 'none'>
  probe(provider: ProviderConfig, apiKey: string, options?: ProbeOptions): Promise<QuotaSnapshot>
}
