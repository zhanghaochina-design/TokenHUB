import { describe, expect, it } from 'vitest'
import { QuotaScheduler } from '../../core/quota/scheduler'
import { RuntimeStore } from '../../core/router/runtime'
import { createProviderFromPreset } from '../../core/providers/presets'
import type { ProbeFetchFn } from '../../core/quota/types'

const creditsPayload = {
  data: {
    credits: { monthlyCredits: 40, planId: 'individual-goat' },
    windowLimits: { limited: true, fiveHour: { used: 1, cap: 14 }, weekly: { used: 1, cap: 35 } }
  }
}

function setup() {
  const nowRef = { value: new Date('2026-10-30T00:00:00Z') }
  const runtime = new RuntimeStore(() => nowRef.value)
  const provider = createProviderFromPreset('commandcode', 'cc')
  provider.name = 'CC'
  let failing = true
  let creditsCalls = 0
  const fetchFn: ProbeFetchFn = async (url) => {
    if (String(url).includes('/alpha/billing/credits')) {
      creditsCalls += 1
      return failing ? new Response('boom', { status: 500 }) : new Response(JSON.stringify(creditsPayload), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  const logs: string[] = []
  const scheduler = new QuotaScheduler(
    runtime,
    () => [provider],
    () => 'k',
    () => {},
    () => nowRef.value,
    fetchFn,
    (message) => logs.push(message)
  )
  return {
    runtime,
    provider,
    scheduler,
    logs,
    nowRef,
    setFailing: (value: boolean) => { failing = value },
    creditsCalls: () => creditsCalls
  }
}

describe('quota scheduler', () => {
  it('backs off after a failure and recovers on the next successful probe', async () => {
    const ctx = setup()
    await ctx.scheduler.refreshAll()
    expect(ctx.runtime.get('cc').probeFailures).toBe(1)
    expect(ctx.runtime.get('cc').quota).toBeNull()
    expect(ctx.logs[0]).toContain('quota probe failed for CC (1x): /alpha/billing/credits 500; retry in 30s')
    expect(ctx.creditsCalls()).toBe(1)

    // 退避期内不再打上游。
    await ctx.scheduler.refreshAll()
    expect(ctx.creditsCalls()).toBe(1)

    ctx.nowRef.value = new Date(ctx.nowRef.value.getTime() + 30_000)
    ctx.setFailing(false)
    await ctx.scheduler.refreshAll()
    expect(ctx.runtime.get('cc').probeFailures).toBe(0)
    expect(ctx.runtime.get('cc').quota?.balance).toEqual({ amount: 40, currency: 'USD' })
    expect(ctx.creditsCalls()).toBe(2)
  })

  it('caps the backoff at 15 minutes without permanently disabling the probe', async () => {
    const ctx = setup()
    for (let i = 0; i < 6; i += 1) await ctx.scheduler.refreshAll(true)
    const retries = ctx.logs.map((entry) => Number(/retry in (\d+)s/.exec(entry)?.[1]))
    expect(retries).toEqual([30, 60, 120, 240, 480, 900])
    expect(ctx.runtime.get('cc').probeFailures).toBe(6)

    // 成功一次立即清零，之后恢复正常节奏。
    ctx.setFailing(false)
    await ctx.scheduler.refreshAll(true)
    expect(ctx.runtime.get('cc').probeFailures).toBe(0)
    expect(ctx.runtime.get('cc').quota).not.toBeNull()
  })

  it('retries immediately after a manual reset clears the backoff', async () => {
    const ctx = setup()
    await ctx.scheduler.refreshAll()
    expect(ctx.creditsCalls()).toBe(1)
    await ctx.scheduler.refreshAll()
    expect(ctx.creditsCalls()).toBe(1)
    ctx.scheduler.resetBackoff('cc')
    await ctx.scheduler.refreshAll()
    expect(ctx.creditsCalls()).toBe(2)
  })

  it('clears the failure count on any successful probe', () => {
    const runtime = new RuntimeStore(() => new Date('2026-10-30T00:00:00Z'))
    const provider = createProviderFromPreset('commandcode', 'cc')
    runtime.get('cc').probeFailures = 4
    runtime.markProbe(provider, {
      providerId: 'cc',
      availability: 'ok',
      balance: { amount: 40, currency: 'USD' },
      source: 'probe',
      fetchedAt: '2026-10-30T00:00:00.000Z'
    })
    expect(runtime.get('cc').probeFailures).toBe(0)
  })
})
