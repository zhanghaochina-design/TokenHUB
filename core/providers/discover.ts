import type { ModelEndpointSupport, ModelMeta } from '../types'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface DiscoveredModel {
  id: string
  // 上游返回的能力字段；缺失表示该上游没有提供，交给下一步（手动/内置）兜底。
  meta?: ModelMeta
  // 上游声明该模型提供哪些请求入口；缺失表示上游未声明。
  endpoints?: ModelEndpointSupport
}

interface RawModel {
  id?: unknown
  // OpenCode Go：limit.context + modalities.input + capabilities.reasoning。
  limit?: { context?: unknown }
  modalities?: { input?: unknown }
  capabilities?: { reasoning?: { supported?: unknown; effort?: unknown } }
  // CommandCode：context_length + supported_endpoints。
  context_length?: unknown
  supported_endpoints?: unknown
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

/** CommandCode 的 supported_endpoints 形如 ["/chat/completions", "/responses"]；只映射网关认识的两个形状。 */
export function modelEndpointsFromUpstream(raw: RawModel): ModelEndpointSupport | undefined {
  if (!Array.isArray(raw.supported_endpoints)) return undefined
  const endpoints = raw.supported_endpoints.filter((item): item is string => typeof item === 'string')
  if (endpoints.length === 0) return undefined
  const normalized = endpoints.map((item) => item.toLowerCase())
  return {
    anthropic: normalized.some((item) => item.endsWith('/messages')),
    openai: normalized.some((item) => item.endsWith('/chat/completions'))
  }
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
    const endpoints = modelEndpointsFromUpstream(raw)
    models.push({
      id,
      ...(meta ? { meta } : {}),
      ...(endpoints ? { endpoints } : {})
    })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}
