import { describe, expect, it } from 'vitest'
import type { HistoryRecord } from '../../core/types'
import { computeSpeedStats } from '../../core/speed'

const record = (overrides: Partial<HistoryRecord> = {}): HistoryRecord => ({
  ts: '2026-11-06T00:00:00.000Z',
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

describe('computeSpeedStats', () => {
  it('picks the newest valid streaming request as latest', () => {
    const [stats] = computeSpeedStats([
      record({ ts: '2026-11-06T00:00:00.000Z' }),
      record({ ts: '2026-11-06T01:00:00.000Z', completionTokens: 200 })
    ])

    expect(stats.latestTps).toBe(200)
    expect(stats.latestAt).toBe('2026-11-06T01:00:00.000Z')
  })

  it('computes the daily weighted average from total tokens over total generation time', () => {
    const [stats] = computeSpeedStats([
      record({ completionTokens: 100, latencyMs: 1100, firstByteMs: 100 }),
      record({ completionTokens: 300, latencyMs: 600, firstByteMs: 100 })
    ])

    expect(stats.averageTps).toBeCloseTo(266.67, 2)
    expect(stats.samples).toBe(2)
  })

  it('ignores errors, non-stream requests, missing usage and invalid timing', () => {
    const [stats] = computeSpeedStats([
      record(),
      record({ outcome: 'error' }),
      record({ stream: false }),
      record({ completionTokens: null }),
      record({ completionTokens: 0 }),
      record({ firstByteMs: null }),
      record({ latencyMs: 150, firstByteMs: 100 }),
      record({ providerId: null })
    ])

    expect(stats.samples).toBe(1)
    expect(stats.averageTps).toBe(100)
    expect(stats.latestTps).toBe(100)
  })

  it('does not let a newer invalid request replace the latest valid speed', () => {
    const [stats] = computeSpeedStats([
      record({ ts: '2026-11-06T00:00:00.000Z' }),
      record({ ts: '2026-11-06T01:00:00.000Z', outcome: 'error' })
    ])

    expect(stats.latestAt).toBe('2026-11-06T00:00:00.000Z')
    expect(stats.latestTps).toBe(100)
  })

  it('ignores implausible speeds above the sanity cap', () => {
    const [stats] = computeSpeedStats([
      record(),
      record({ completionTokens: 300, latencyMs: 200, firstByteMs: 100 })
    ])

    expect(stats.samples).toBe(1)
    expect(stats.averageTps).toBe(100)
  })

  it('groups by provider', () => {
    const stats = computeSpeedStats([
      record({ providerId: 'p1' }),
      record({ providerId: 'p2', completionTokens: 200 })
    ])

    expect(stats.map((item) => item.providerId).sort()).toEqual(['p1', 'p2'])
    expect(stats.find((item) => item.providerId === 'p2')?.latestTps).toBe(200)
  })

  it('returns no stats without records', () => {
    expect(computeSpeedStats([])).toEqual([])
  })
})
