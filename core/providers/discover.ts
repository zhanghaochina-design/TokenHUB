export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export async function discoverModels(baseUrl: string, apiKey: string, fetchFn: FetchFn = fetch): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`models ${res.status}`)
  const json = (await res.json()) as { data?: Array<{ id?: unknown }> }
  const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
  return [...new Set(ids)].sort()
}
