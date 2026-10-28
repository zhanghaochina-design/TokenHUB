import type { QuotaAdapter, ProbeOptions } from './types'
import type { ProviderConfig, QuotaSnapshot } from '../types'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'

// Only a real number or a non-empty numeric string is a usable balance; null/undefined/''/'n/a' are not.
function toAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export const deepseekBalanceAdapter: QuotaAdapter = {
  id: 'deepseek-balance',
  async probe(provider: ProviderConfig, apiKey: string, options: ProbeOptions = {}): Promise<QuotaSnapshot> {
    const now = options.now ?? (() => new Date())
    const fetchFn = options.fetchFn ?? fetch
    const res = await fetchFn(BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    })
    const fetchedAt = now().toISOString()
    if (res.status === 401) {
      return { providerId: provider.id, availability: 'auth_error', source: 'probe', fetchedAt, note: 'balance 401' }
    }
    if (!res.ok) throw new Error(`balance ${res.status}`)
    const json = (await res.json()) as {
      is_available?: boolean
      balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }>
    }
    const infos: Array<{ currency: string; amount: number }> = []
    for (const info of Array.isArray(json.balance_infos) ? json.balance_infos : []) {
      const amount = toAmount(info?.total_balance)
      if (amount === null) continue
      infos.push({ currency: typeof info?.currency === 'string' ? info.currency : 'UNKNOWN', amount })
    }
    // No usable amount must fail the probe (scheduler counts failures) instead of faking an exhausted balance.
    if (infos.length === 0) throw new Error('balance payload has no usable balance_infos')
    const best = infos.reduce((max, b) => (b.amount > max.amount ? b : max))
    const available = json.is_available !== false && best.amount >= provider.quota.lowBalanceThreshold
    return {
      providerId: provider.id,
      availability: available ? 'ok' : 'exhausted',
      balance: best,
      source: 'probe',
      fetchedAt
    }
  }
}
