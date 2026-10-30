import { describe, expect, it } from 'vitest'
import { opencodeGoAdapter } from '../../core/quota/opencodeGo'
import { deepseekBalanceAdapter } from '../../core/quota/deepseek'
import { commandCodeAdapter } from '../../core/quota/commandcode'
import { createProviderFromPreset } from '../../core/providers/presets'
import type { ProbeFetchFn } from '../../core/quota/types'

const provider = (preset: 'opencode-go' | 'deepseek') => createProviderFromPreset(preset, 'p1')
const now = () => new Date('2026-10-28T00:00:00Z')

describe('opencode quota adapter', () => {
  it('reports exhausted when a window is full', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({
        usage: {
          rolling: { status: 'ok', percent: 10, resetsAt: '2026-10-28T03:00:00.000Z' },
          weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-11-01T00:00:00.000Z' },
          monthly: { status: 'ok', percent: 40, resetsAt: '2026-11-09T00:00:00.000Z' }
        }
      }), { status: 200 })
    const snapshot = await opencodeGoAdapter.probe(provider('opencode-go'), 'k', { fetchFn: fetchFn as never, now })
    expect(snapshot.availability).toBe('exhausted')
    expect(snapshot.windows?.weekly?.percent).toBe(100)
  })

  it('returns auth_error on 401', async () => {
    const fetchFn = async () => new Response('bad key', { status: 401 })
    const snapshot = await opencodeGoAdapter.probe(provider('opencode-go'), 'k', { fetchFn: fetchFn as never, now })
    expect(snapshot.availability).toBe('auth_error')
  })

  it('rejects a usage payload with no recognizable windows', async () => {
    const fetchFn = async () => new Response(JSON.stringify({ usage: {} }), { status: 200 })
    await expect(opencodeGoAdapter.probe(provider('opencode-go'), 'k', { fetchFn: fetchFn as never, now }))
      .rejects.toThrow('usage payload has no recognizable windows')
  })

  it('treats a rate-limited window without percent as exhausted', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({
        usage: { weekly: { status: 'rate-limited', resetsAt: '2026-11-01T00:00:00.000Z' } }
      }), { status: 200 })
    const snapshot = await opencodeGoAdapter.probe(provider('opencode-go'), 'k', { fetchFn: fetchFn as never, now })
    expect(snapshot.availability).toBe('exhausted')
    expect(snapshot.windows?.weekly).toEqual({
      percent: 100,
      status: 'rate-limited',
      resetsAt: '2026-11-01T00:00:00.000Z'
    })
  })
})

describe('deepseek balance adapter', () => {
  it('is exhausted below threshold', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0.10' }] }), { status: 200 })
    const snapshot = await deepseekBalanceAdapter.probe(provider('deepseek'), 'k', { fetchFn: fetchFn as never, now })
    expect(snapshot.availability).toBe('exhausted')
    expect(snapshot.balance).toEqual({ amount: 0.1, currency: 'USD' })
  })

  it('is ok above threshold', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.5' }] }), { status: 200 })
    const snapshot = await deepseekBalanceAdapter.probe(provider('deepseek'), 'k', { fetchFn: fetchFn as never, now })
    expect(snapshot.availability).toBe('ok')
  })

  it('rejects an empty balance_infos payload', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ is_available: true, balance_infos: [] }), { status: 200 })
    await expect(deepseekBalanceAdapter.probe(provider('deepseek'), 'k', { fetchFn: fetchFn as never, now }))
      .rejects.toThrow('balance payload has no usable balance_infos')
  })

  it('rejects a payload with only non-numeric balances', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: 'USD', total_balance: 'n/a' },
          { currency: 'CNY', total_balance: null }
        ]
      }), { status: 200 })
    await expect(deepseekBalanceAdapter.probe(provider('deepseek'), 'k', { fetchFn: fetchFn as never, now }))
      .rejects.toThrow('balance payload has no usable balance_infos')
  })
})

describe('commandcode quota adapter', () => {
  const ccProvider = () => createProviderFromPreset('commandcode', 'cc')
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  const routes = (overrides: Record<string, () => Response> = {}): ProbeFetchFn => async (url) => {
    const path = new URL(url).pathname
    if (overrides[path]) return overrides[path]()
    if (path === '/alpha/billing/credits') {
      return json({
        data: {
          credits: { monthlyCredits: 40, purchasedCredits: 8, freeCredits: 2, planId: 'individual-goat', belowThreshold: false },
          windowLimits: {
            limited: true,
            fiveHour: { used: 7, cap: 14, resetAt: 1767000000000 },
            weekly: { used: 20, cap: 35, resetsAt: '2026-11-02T00:00:00.000Z' }
          }
        }
      })
    }
    if (path === '/alpha/whoami') return json({ user: { userName: 'owner' }, org: { id: 'org-1' } })
    if (path === '/alpha/billing/subscriptions') {
      return json({ data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-11-30T00:00:00.000Z' } })
    }
    return json({ error: 'not found' }, 404)
  }

  it('maps the 5h/weekly/monthly windows and remaining credits', async () => {
    const snapshot = await commandCodeAdapter.probe(ccProvider(), 'k', { fetchFn: routes(), now })
    expect(snapshot.availability).toBe('ok')
    expect(snapshot.windows?.rolling).toEqual({
      percent: 50,
      status: 'ok',
      resetsAt: new Date(1767000000000).toISOString()
    })
    expect(snapshot.windows?.weekly?.percent).toBeCloseTo((20 / 35) * 100)
    expect(snapshot.windows?.weekly?.resetsAt).toBe('2026-11-02T00:00:00.000Z')
    expect(snapshot.windows?.monthly?.percent).toBeCloseTo((30 / 70) * 100)
    expect(snapshot.windows?.monthly?.resetsAt).toBe('2026-11-30T00:00:00.000Z')
    expect(snapshot.balance).toEqual({ amount: 40, currency: 'USD' })
    expect(snapshot.note).toContain('GOAT')
    expect(snapshot.source).toBe('probe')
  })

  it('marks the provider exhausted when a window is used up', async () => {
    const fetchFn = routes({
      '/alpha/billing/credits': () => json({
        data: {
          credits: { monthlyCredits: 40, planId: 'individual-goat' },
          windowLimits: { limited: true, fiveHour: { used: 14, cap: 14, resetAt: 1767000000000 } }
        }
      })
    })
    const snapshot = await commandCodeAdapter.probe(ccProvider(), 'k', { fetchFn, now })
    expect(snapshot.availability).toBe('exhausted')
    expect(snapshot.windows?.rolling).toMatchObject({ percent: 100, status: 'rate-limited' })
  })

  it('treats 401 as an auth error without throwing', async () => {
    const fetchFn = routes({ '/alpha/billing/credits': () => json({ error: 'unauthorized' }, 401) })
    const snapshot = await commandCodeAdapter.probe(ccProvider(), 'k', { fetchFn, now })
    expect(snapshot.availability).toBe('auth_error')
    expect(snapshot.note).toBe('billing 401')
  })

  it('fails the probe on 403 so the scheduler can disable it', async () => {
    const fetchFn = routes({ '/alpha/billing/credits': () => json({ error: 'forbidden' }, 403) })
    await expect(commandCodeAdapter.probe(ccProvider(), 'k', { fetchFn, now }))
      .rejects.toThrow('/alpha/billing/credits 403')
  })

  it('falls back to the $70 monthly cap for unknown plans', async () => {
    const fetchFn = routes({
      '/alpha/billing/credits': () => json({
        data: {
          credits: { monthlyCredits: 12, planId: 'individual-mystery' },
          windowLimits: { limited: true, fiveHour: { used: 1, cap: 5 } }
        }
      }),
      '/alpha/billing/subscriptions': () => json({ data: { planId: 'individual-mystery' } })
    })
    const snapshot = await commandCodeAdapter.probe(ccProvider(), 'k', { fetchFn, now })
    expect(snapshot.windows?.monthly?.percent).toBeCloseTo(((70 - 12) / 70) * 100)
    expect(snapshot.balance).toEqual({ amount: 12, currency: 'USD' })
    expect(snapshot.note).toBe('individual-mystery 套餐')
  })

  it('uses the remaining credits as the cap when they exceed the plan cap', async () => {
    const fetchFn = routes({
      '/alpha/billing/credits': () => json({
        data: {
          credits: { monthlyCredits: 300, planId: 'individual-mystery' },
          windowLimits: { limited: true, fiveHour: { used: 1, cap: 5 } }
        }
      }),
      '/alpha/whoami': () => json({ error: 'boom' }, 500)
    })
    const snapshot = await commandCodeAdapter.probe(ccProvider(), 'k', { fetchFn, now })
    expect(snapshot.windows?.monthly?.percent).toBe(0)
    expect(snapshot.balance).toEqual({ amount: 300, currency: 'USD' })
  })

  it('omits the 5h/weekly windows when the plan is not limited by them', async () => {
    const fetchFn = routes({
      '/alpha/billing/credits': () => json({
        data: {
          credits: { monthlyCredits: 40, planId: 'individual-goat' },
          windowLimits: { limited: false }
        }
      })
    })
    const snapshot = await commandCodeAdapter.probe(ccProvider(), 'k', { fetchFn, now })
    expect(snapshot.windows?.rolling).toBeUndefined()
    expect(snapshot.windows?.weekly).toBeUndefined()
    expect(snapshot.windows?.monthly).toBeDefined()
    expect(snapshot.note).toContain('不受 5 小时/周窗口限制')
  })

  it('keeps credits data when whoami is unavailable', async () => {
    const fetchFn = routes({ '/alpha/whoami': () => json({ error: 'boom' }, 500) })
    const snapshot = await commandCodeAdapter.probe(ccProvider(), 'k', { fetchFn, now })
    expect(snapshot.availability).toBe('ok')
    expect(snapshot.windows?.monthly?.percent).toBeCloseTo((30 / 70) * 100)
    expect(snapshot.windows?.monthly?.resetsAt).toBeNull()
  })

  it('rejects a payload with no recognizable windows', async () => {
    const fetchFn = routes({
      '/alpha/billing/credits': () => json({ data: { credits: {} } }),
      '/alpha/whoami': () => json({ error: 'boom' }, 500)
    })
    await expect(commandCodeAdapter.probe(ccProvider(), 'k', { fetchFn, now }))
      .rejects.toThrow('billing payload has no recognizable windows')
  })
})
