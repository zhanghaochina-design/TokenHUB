import type { ModelAlias, ModelAliasTarget, ProviderConfig } from '../types'

export interface ModelSuggestion {
  id: string
  targets: ModelAliasTarget[]
}

// 只看最后一个路径段并去掉标点：deepseek-v4.1-flash 与 deepseek/deepseek-v4.1-flash 得到同一签名。
export function modelSignature(raw: string): string {
  const last = raw.slice(raw.lastIndexOf('/') + 1)
  return last.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function suggestModelAliases(providers: ProviderConfig[], aliases: ModelAlias[]): ModelSuggestion[] {
  const enabled = providers.filter((provider) => provider.enabled)
  const providerOrder = new Map(enabled.map((provider, index) => [provider.id, index]))
  const aliasIds = new Set(aliases.map((alias) => alias.id))
  const mapped = new Set(
    aliases.flatMap((alias) => alias.targets.map((target) => `${target.providerId}\u0000${target.upstreamModel}`))
  )
  const owners = new Map<string, Set<string>>()
  for (const provider of enabled) {
    for (const model of new Set([...provider.models.cached, ...provider.models.manual])) {
      const set = owners.get(model) ?? new Set<string>()
      set.add(provider.id)
      owners.set(model, set)
    }
  }

  const groups = new Map<string, ModelAliasTarget[]>()
  for (const provider of enabled) {
    for (const upstreamModel of new Set([...provider.models.cached, ...provider.models.manual])) {
      if (aliasIds.has(upstreamModel) || mapped.has(`${provider.id}\u0000${upstreamModel}`)) continue
      const signature = modelSignature(upstreamModel)
      if (!signature) continue
      const list = groups.get(signature) ?? []
      list.push({ providerId: provider.id, upstreamModel })
      groups.set(signature, list)
    }
  }

  const suggestions: ModelSuggestion[] = []
  for (const list of groups.values()) {
    const providerIds = new Set(list.map((target) => target.providerId))
    if (providerIds.size < 2) continue
    const perProvider = new Map<string, number>()
    for (const target of list) perProvider.set(target.providerId, (perProvider.get(target.providerId) ?? 0) + 1)
    // 同一供应商出现多个同签名模型时不猜，避免要求用户在一组里二选一却不知道选哪个。
    if ([...perProvider.values()].some((count) => count > 1)) continue
    if (new Set(list.map((target) => target.upstreamModel)).size < 2) continue

    const id = chooseCanonical(list, providerIds, owners, aliasIds)
    if (!id) continue
    suggestions.push({
      id,
      targets: [...list].sort((a, b) => providerOrder.get(a.providerId)! - providerOrder.get(b.providerId)!)
    })
  }
  return suggestions.sort((a, b) => a.id.localeCompare(b.id))
}

function chooseCanonical(
  list: ModelAliasTarget[],
  groupProviders: Set<string>,
  owners: Map<string, Set<string>>,
  aliasIds: Set<string>
): string | null {
  const counts = new Map<string, number>()
  for (const target of list) counts.set(target.upstreamModel, (counts.get(target.upstreamModel) ?? 0) + 1)
  const candidates = [...counts.keys()].sort((a, b) => {
    const byCount = counts.get(b)! - counts.get(a)!
    if (byCount) return byCount
    if (a.length !== b.length) return a.length - b.length
    return a.localeCompare(b)
  })
  for (const candidate of candidates) {
    if (aliasIds.has(candidate)) continue
    // 若 canonical 恰好是组外供应商的模型，创建别名会隐式多出 target；换下一个候选或放弃建议。
    const outside = [...(owners.get(candidate) ?? [])].some((providerId) => !groupProviders.has(providerId))
    if (!outside) return candidate
  }
  return null
}
