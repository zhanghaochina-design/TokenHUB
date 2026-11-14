import type { ModelMeta } from '../types'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface DiscoveredModel {
  id: string
  // 上游返回的能力字段；缺失表示该上游没有提供，交给下一步（手动/内置）兜底。
  meta?: ModelMeta
}

interface RawModel {
  id?: unknown
  // OpenCode Go：limit.context + modalities.input + capabilities.reasoning。
  limit?: { context?: unknown }
  modalities?: { input?: unknown }
  capabilities?: { reasoning?: { supported?: unknown; effort?: unknown } }
  // CommandCode：只给 context_length 与 supported_endpoints。
  context_length?: unknown
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

export function modelMetaFromUpstream(raw: RawModel): ModelMeta | undefined {
  const meta: ModelMeta = {}
  const context = positiveNumber(raw.limit?.context) ?? positiveNumber(raw.context_length)
  if (context !== null) meta.contextLength = context

  const inputs = Array.isArray(raw.modalities?.input) ? raw.modalities.input : null
  if (inputs) meta.vision = inputs.some((item) => typeof item === 'string' && item.toLowerCase().startsWith('image/'))

  const reasoning = raw.capabilities?.reasoning
  if (reasoning && reasoning.supported === false) {
    meta.thinking = { param: 'none', values: [] }
  } else if (reasoning && reasoning.supported === true) {
    const effort = Array.isArray(reasoning.effort)
      ? reasoning.effort.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
    // OpenCode Go 目录把思考档位叫 effort；这里只如实记录，具体请求字段由用户按上游文档填写。
    meta.thinking = { param: 'effort', values: [...new Set(effort)] }
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}

export async function discoverModels(baseUrl: string, apiKey: string, fetchFn: FetchFn = fetch): Promise<DiscoveredModel[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`models ${res.status}`)
  const json = (await res.json()) as { data?: RawModel[] }
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const raw of json.data ?? []) {
    const id = typeof raw.id === 'string' ? raw.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const meta = modelMetaFromUpstream(raw)
    models.push(meta ? { id, meta } : { id })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}
