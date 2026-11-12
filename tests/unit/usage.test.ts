import { describe, expect, it } from 'vitest'
import type { HistoryRecord, QuotaSnapshot, UsageWindowBound } from '../../core/types'
import { computeUsageStats, resolveUsageWindows } from '../../core/usage'

const NOW = '2026-11-06T12:00:00.000Z'
const now = () => new Date(NOW)

const record = (overrides: Partial<HistoryRecord> = {}): HistoryRecord => ({
  ts: '2026-11-06T10:00:00.000Z',
  requestId: 'r',
  protocol: 'anthropic',
  model: 'claude-sonnet-4-5',
  providerId: 'p1',
  upstreamModel: 'deepseek-v4.1-flash',
  stream: true,
  httpStatus: 200,
  outcome: 'ok',
  promptTokens: 10,
  completionTokens: 100,
  latencyMs: 1100,
  firstByteMs: 100,
  errorKind: null,
  ...overrides
})

const snapshot = (windows: QuotaSnapshot['windows']): QuotaSnapshot => ({
  providerId: 'p1',
  availability: 'ok',
  windows,
  source: 'probe',
  fetchedAt: NOW
})

const bound = (key: UsageWindowBound['key'], start: string, overrides: Partial<UsageWindowBound> = {}): UsageWindowBound => ({
  key,
  start,
  end: NOW,
  aligned: false,
  partial: false,
  ...overrides
})

describe('resolveUsageWindows', () => {
  it('falls back to rolling 5h/7d/30d windows without a quota snapshot', () => {
    const windows = resolveUsageWindows(null, now(), 30)
    expect(windows.map((w) => w.key)).toEqual(['rolling', 'weekly', 'monthly'])
    expect(windows.every((w) => w.aligned === false)).toBe(true)
    expect(windows[0].start).toBe('2026-11-06T07:00:00.000Z')
    expect(windows[1].start).toBe('2026-10-30T12:00:00.000Z')
    expect(windows[2].start).toBe('2026-10-07T12:00:00.000Z')
    expect(windows.every((w) => w.end === NOW)).toBe(true)
  })

  it('aligns a window to the probe reset time when it is in the future', () => {
    const windows = resolveUsageWindows(
      snapshot({ rolling: { percent: 40, status: 'ok', resetsAt: '2026-11-06T14:00:00.000Z' } }),
      now(),
      30
    )
    expect(windows[0].aligned).toBe(true)
    // reset 14:00 − 5h = 09:00
    expect(windows[0].start).toBe('2026-11-06T09:00:00.000Z')
    expect(windows[1].aligned).toBe(false)
  })

  it('falls back to rolling when the reset time is already past', () => {
    const windows = resolveUsageWindows(
      snapshot({ rolling: { percent: 40, status: 'ok', resetsAt: '2026-11-06T10:00:00.000Z' } }),
      now(),
      30
    )
    expect(windows[0].aligned).toBe(false)
    expect(windows[0].start).toBe('2026-11-06T07:00:00.000Z')
  })

  it('treats a balance-only snapshot (DeepSeek) as rolling windows', () => {
    const windows = resolveUsageWindows(
      { providerId: 'p1', availability: 'ok', balance: { amount: 10, currency: 'USD' }, source: 'probe', fetchedAt: NOW },
      now(),
      30
    )
    expect(windows.every((w) => w.aligned === false)).toBe(true)
  })

  it('flags windows longer than the retained history as partial', () => {
    const windows = resolveUsageWindows(null, now(), 7)
    expect(windows[0].partial).toBe(false)
    expect(windows[1].partial).toBe(false)
    expect(windows[2].partial).toBe(true)
  })

  it('never flags partial when retention is unlimited (0)', () => {
    const windows = resolveUsageWindows(null, now(), 0)
    expect(windows.every((w) => w.partial === false)).toBe(true)
  })
})

describe('computeUsageStats', () => {
  const providers = [
    {
      providerId: 'p1',
      windows: [bound('rolling', '2026-11-06T07:00:00.000Z'), bound('monthly', '2026-10-07T12:00:00.000Z')]
    },
    { providerId: 'p2', windows: [bound('rolling', '2026-11-06T07:00:00.000Z')] }
  ]

  it('sums input and output tokens per window for the matching provider', () => {
    const stats = computeUsageStats(
      [
        record({ ts: '2026-11-06T10:00:00.000Z', promptTokens: 10, completionTokens: 100 }),
        record({ ts: '2026-11-06T06:00:00.000Z', promptTokens: 5, completionTokens: 50 }),
        record({ ts: '2026-11-01T00:00:00.000Z', promptTokens: 1, completionTokens: 1 }),
        record({ ts: '2026-11-06T10:00:00.000Z', providerId: 'p2', promptTokens: 7, completionTokens: 70 })
      ],
      providers
    )
    const p1 = stats.find((s) => s.providerId === 'p1')!
    const rolling = p1.windows.find((w) => w.key === 'rolling')!
    const monthly = p1.windows.find((w) => w.key === 'monthly')!
    expect(rolling).toMatchObject({ promptTokens: 10, completionTokens: 100, totalTokens: 110, requests: 1 })
    expect(monthly).toMatchObject({ promptTokens: 16, completionTokens: 151, totalTokens: 167, requests: 3 })
    const p2 = stats.find((s) => s.providerId === 'p2')!
    expect(p2.windows[0]).toMatchObject({ promptTokens: 7, completionTokens: 70, totalTokens: 77, requests: 1 })
  })

  it('includes records exactly at the window start and excludes errors', () => {
    const stats = computeUsageStats(
      [
        record({ ts: '2026-11-06T07:00:00.000Z', promptTokens: 3, completionTokens: 30 }),
        record({ ts: '2026-11-06T10:00:00.000Z', outcome: 'error', promptTokens: null, completionTokens: null })
      ],
      providers
    )
    const rolling = stats.find((s) => s.providerId === 'p1')!.windows[0]
    expect(rolling).toMatchObject({ promptTokens: 3, completionTokens: 30, totalTokens: 33, requests: 1 })
  })

  it('treats null token counts as zero', () => {
    const stats = computeUsageStats([record({ promptTokens: null, completionTokens: null })], providers)
    expect(stats.find((s) => s.providerId === 'p1')!.windows[0]).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requests: 1
    })
  })

  it('returns zeroed windows for a provider with no records', () => {
    const stats = computeUsageStats([], providers)
    expect(stats).toHaveLength(2)
    expect(stats[0].windows.every((w) => w.totalTokens === 0 && w.requests === 0)).toBe(true)
  })

  it('returns no stats without providers', () => {
    expect(computeUsageStats([record()], [])).toEqual([])
  })
})