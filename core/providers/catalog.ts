import type { MergedModel, MergedModelTarget, ModelAlias, ProviderConfig } from '../types'
import { aggregateModelMeta, effectiveModelMeta } from './modelMeta'

export function providerSupports(provider: ProviderConfig, model: string): boolean {
  return provider.models.cached.includes(model) || provider.models.manual.includes(model)
}

// 生效隐藏 = (手动隐藏 ∪ 扫描自动隐藏) − 用户显式恢复。
function hiddenSetOf(provider: ProviderConfig | undefined): Set<string> {
  const hidden = new Set(provider?.models.hidden ?? [])
  for (const model of provider?.models.scanHidden ?? []) hidden.add(model)
  for (const model of provider?.models.shown ?? []) hidden.delete(model)
  return hidden
}

/** 展示层隐藏：只影响模型页与 /v1/models，providerSupports 与路由仍视其为可用。 */
export function isTargetHidden(provider: ProviderConfig | undefined, upstreamModel: string): boolean {
  return hiddenSetOf(provider).has(upstreamModel)
}

/** 合并模型只有在全部目标都隐藏时才从本地列表消失；部分隐藏的模型照常列出。 */
export function listedCatalog(catalog: MergedModel[], providers: ProviderConfig[]): MergedModel[] {
  const hiddenByProvider = new Map(providers.map((provider) => [provider.id, hiddenSetOf(provider)]))
  return catalog.filter((model) =>
    model.targets.some((target) => !hiddenByProvider.get(target.providerId)?.has(target.upstreamModel))
  )
}

export function buildCatalog(providers: ProviderConfig[], aliases: ModelAlias[] = []): MergedModel[] {
  const enabled = providers.filter((provider) => provider.enabled)
  const providerOrder = new Map(enabled.map((provider, index) => [provider.id, index]))
  const providerById = new Map(enabled.map((provider) => [provider.id, provider]))
  const aliasById = new Map<string, ModelAlias>()
  for (const alias of aliases) {
    if (!aliasById.has(alias.id)) aliasById.set(alias.id, alias)
  }

  const targets = new Map<string, Map<string, MergedModelTarget>>()
  const hidden = new Set<string>()
  const pairKey = (providerId: string, upstreamModel: string) => `${providerId}\u0000${upstreamModel}`

  const addTarget = (id: string, providerId: string, upstreamModel: string, source: MergedModelTarget['source']) => {
    if (!providerOrder.has(providerId)) return
    const map = targets.get(id) ?? new Map<string, MergedModelTarget>()
    if (!map.has(providerId)) map.set(providerId, { providerId, upstreamModel, source })
    targets.set(id, map)
  }

  for (const alias of aliasById.values()) {
    for (const target of alias.targets) {
      addTarget(alias.id, target.providerId, target.upstreamModel, 'alias')
      if (providerOrder.has(target.providerId)) hidden.add(pairKey(target.providerId, target.upstreamModel))
    }
  }

  for (const provider of enabled) {
    for (const model of new Set([...provider.models.cached, ...provider.models.manual])) {
      const pair = pairKey(provider.id, model)
      const alias = aliasById.get(model)
      if (alias) {
        // 统一 ID 恰好等于原始模型名：原始名不再单独出现；没有显式映射的供应商自动纳入。
        hidden.add(pair)
        addTarget(alias.id, provider.id, model, 'exact')
        continue
      }
      if (hidden.has(pair)) continue
      addTarget(model, provider.id, model, 'exact')
    }
  }

  const catalog: MergedModel[] = []
  for (const [id, map] of targets) {
    if (map.size === 0) continue
    const list = [...map.values()].sort(
      (a, b) => providerOrder.get(a.providerId)! - providerOrder.get(b.providerId)!
    )
    const model: MergedModel = {
      id,
      providers: [...new Set(list.map((target) => target.providerId))],
      targets: list,
      meta: aggregateModelMeta(
        list.map((target) => effectiveModelMeta(providerById.get(target.providerId)!, target.upstreamModel))
      )
    }
    if (aliasById.has(id)) model.isAlias = true
    catalog.push(model)
  }
  return catalog.sort((a, b) => a.id.localeCompare(b.id))
}

export function parseRequestedModel(raw: string, providers: ProviderConfig[]): { providerId: string | null; model: string } {
  const slash = raw.indexOf('/')
  if (slash > 0) {
    const prefix = raw.slice(0, slash)
    if (providers.some((p) => p.id === prefix)) return { providerId: prefix, model: raw.slice(slash + 1) }
  }
  return { providerId: null, model: raw }
}
