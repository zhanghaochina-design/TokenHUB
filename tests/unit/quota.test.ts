import { describe, expect, it } from 'vitest'
import { opencodeGoAdapter } from '../../core/quota/opencodeGo'
import { deepseekBalanceAdapter } from '../../core/quota/deepseek'
import { createProviderFromPreset } from '../../core/providers/presets'

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
