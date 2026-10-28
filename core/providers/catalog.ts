import type { MergedModel, ProviderConfig } from '../types'

export function providerSupports(provider: ProviderConfig, model: string): boolean {
  return provider.models.cached.includes(model) || provider.models.manual.includes(model)
}

export function buildCatalog(providers: ProviderConfig[]): MergedModel[] {
  const map = new Map<string, string[]>()
  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of new Set([...provider.models.cached, ...provider.models.manual])) {
      map.set(model, [...(map.get(model) ?? []), provider.id])
    }
  }
  return [...map.entries()].map(([id, ids]) => ({ id, providers: ids })).sort((a, b) => a.id.localeCompare(b.id))
}

export function parseRequestedModel(raw: string, providers: ProviderConfig[]): { providerId: string | null; model: string } {
  const slash = raw.indexOf('/')
  if (slash > 0) {
    const prefix = raw.slice(0, slash)
    if (providers.some((p) => p.id === prefix)) return { providerId: prefix, model: raw.slice(slash + 1) }
  }
  return { providerId: null, model: raw }
}
