import type { QuotaAdapter, ProbeOptions } from './types'
import type { ProviderConfig, QuotaSnapshot, QuotaWindow } from '../types'

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

function toWindow(value: unknown): QuotaWindow | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as { percent?: unknown; status?: unknown; resetsAt?: unknown }
  const status = typeof v.status === 'string' ? v.status : 'ok'
  const hasPercent = typeof v.percent === 'number' && Number.isFinite(v.percent)
  // A rate-limited window is recognisable without a percent; treat it as full so the exhaustion rule fires.
  if (!hasPercent && status !== 'rate-limited') return undefined
  return {
    percent: hasPercent ? (v.percent as number) : 100,
    status,
    resetsAt: typeof v.resetsAt === 'string' ? v.resetsAt : null
  }
}

export const opencodeGoAdapter: QuotaAdapter = {
  id: 'opencode-go',
  async probe(provider: ProviderConfig, apiKey: string, options: ProbeOptions = {}): Promise<QuotaSnapshot> {
    const now = options.now ?? (() => new Date())
    const fetchFn = options.fetchFn ?? fetch
    const res = await fetchFn(USAGE_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    })
    const fetchedAt = now().toISOString()
    if (res.status === 401) {
      return { providerId: provider.id, availability: 'auth_error', source: 'probe', fetchedAt, note: 'usage 401' }
    }
    if (!res.ok) throw new Error(`usage ${res.status}`)
    const json = (await res.json()) as { usage?: Record<string, unknown> }
    const windows = {
      rolling: toWindow(json.usage?.rolling),
      weekly: toWindow(json.usage?.weekly),
      monthly: toWindow(json.usage?.monthly)
    }
    const list = [windows.rolling, windows.weekly, windows.monthly].filter((w): w is QuotaWindow => Boolean(w))
    // An unrecognisable payload must fail the probe (scheduler counts failures) instead of silently clearing cooldowns.
    if (list.length === 0) throw new Error('usage payload has no recognizable windows')
    const exhausted = list.some((w) => w.percent >= 100 || w.status === 'rate-limited')
    return {
      providerId: provider.id,
      availability: exhausted ? 'exhausted' : 'ok',
      windows,
      source: 'probe',
      fetchedAt
    }
  }
}
