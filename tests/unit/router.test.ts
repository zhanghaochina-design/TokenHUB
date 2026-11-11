import { beforeEach, describe, expect, it } from 'vitest'
import { RuntimeStore } from '../../core/router/runtime'
import { executeWithFailover, resolveCandidates } from '../../core/router/router'
import { buildCatalog } from '../../core/providers/catalog'
import { createProviderFromPreset } from '../../core/providers/presets'
import type { UpstreamFailure } from '../../core/types'

function provider(id: string, models: string[], enabled = true) {
  const p = createProviderFromPreset('custom', id)
  p.name = id
  p.enabled = enabled
  p.models.cached = models
  return p
}

const nowRef = { value: new Date('2026-10-28T00:00:00Z') }
const runtime = () => new RuntimeStore(() => nowRef.value)
beforeEach(() => { nowRef.value = new Date('2026-10-28T00:00:00Z') })
const failure = (kind: UpstreamFailure['kind'], retryAfterMs: number | null = null): UpstreamFailure => ({
  kind, status: 429, message: kind, retryAfterMs
})

describe('resolveCandidates', () => {
  it('orders providers by configured priority and filters disabled', () => {
    const a = provider('a', ['m'])
    const b = provider('b', ['m'])
    const c = provider('c', ['m'], false)
    const providers = [b, a, c]
    const result = resolveCandidates({ requestedModel: 'm', providers, catalog: buildCatalog(providers), runtime: runtime() })
    expect(result.modelKnown).toBe(true)
    expect(result.candidates.map((x) => x.provider.id)).toEqual(['b', 'a'])
  })

  it('pins provider/model and hides exhausted providers', () => {
    const a = provider('a', ['m'])
    const b = provider('b', ['m'])
    const providers = [a, b]
    const rt = runtime()
    rt.markFailure(a, failure('quota'))
    const pinned = resolveCandidates({ requestedModel: 'a/m', providers, catalog: buildCatalog(providers), runtime: rt })
    expect(pinned.candidates).toEqual([])
    const normal = resolveCandidates({ requestedModel: 'm', providers, catalog: buildCatalog(providers), runtime: rt })
    expect(normal.candidates.map((x) => x.provider.id)).toEqual(['b'])
  })

  it('reports unknown models', () => {
    const providers = [provider('a', ['m'])]
    const result = resolveCandidates({ requestedModel: 'nope', providers, catalog: buildCatalog(providers), runtime: runtime() })
    expect(result.modelKnown).toBe(false)
  })

  it('routes a canonical id to each provider upstream id in priority order', () => {
    const a = provider('a', ['opencode-deepseek'])
    const b = provider('b', ['commandcode-deepseek'])
    const providers = [b, a]
    const aliases = [
      {
        id: 'deepseek4.1flash',
        targets: [
          { providerId: 'a', upstreamModel: 'opencode-deepseek' },
          { providerId: 'b', upstreamModel: 'commandcode-deepseek' }
        ]
      }
    ]
    const result = resolveCandidates({
      requestedModel: 'deepseek4.1flash',
      providers,
      catalog: buildCatalog(providers, aliases),
      runtime: runtime()
    })
    expect(result.modelKnown).toBe(true)
    expect(result.candidates).toEqual([
      { provider: b, upstreamModel: 'commandcode-deepseek' },
      { provider: a, upstreamModel: 'opencode-deepseek' }
    ])
  })

  it('supports pinned canonical and pinned upstream ids', () => {
    const a = provider('a', ['opencode-deepseek'])
    const b = provider('b', ['commandcode-deepseek'])
    const providers = [a, b]
    const aliases = [
      {
        id: 'deepseek4.1flash',
        targets: [
          { providerId: 'a', upstreamModel: 'opencode-deepseek' },
          { providerId: 'b', upstreamModel: 'commandcode-deepseek' }
        ]
      }
    ]
    const catalog = buildCatalog(providers, aliases)
    const rt = runtime()
    const canonicalPin = resolveCandidates({ requestedModel: 'a/deepseek4.1flash', providers, catalog, runtime: rt })
    expect(canonicalPin.candidates).toEqual([{ provider: a, upstreamModel: 'opencode-deepseek' }])
    const upstreamPin = resolveCandidates({ requestedModel: 'b/commandcode-deepseek', providers, catalog, runtime: rt })
    expect(upstreamPin.candidates).toEqual([{ provider: b, upstreamModel: 'commandcode-deepseek' }])
    const unknownPin = resolveCandidates({ requestedModel: 'a/not-a-model', providers, catalog, runtime: rt })
    expect(unknownPin.modelKnown).toBe(false)
    expect(unknownPin.candidates).toEqual([])
  })

  it('prefers a canonical id containing slashes over provider pin parsing', () => {
    const p1 = provider('p1', ['raw-model'])
    const aliases = [{ id: 'p1/model-x', targets: [{ providerId: 'p1', upstreamModel: 'raw-model' }] }]
    const result = resolveCandidates({
      requestedModel: 'p1/model-x',
      providers: [p1],
      catalog: buildCatalog([p1], aliases),
      runtime: runtime()
    })
    expect(result.modelKnown).toBe(true)
    expect(result.candidates).toEqual([{ provider: p1, upstreamModel: 'raw-model' }])
  })

  it('reports a zero-target alias as unknown because it has no catalog entry', () => {
    const a = provider('a', ['x'])
    const aliases = [{ id: 'orphan', targets: [] }]
    const result = resolveCandidates({
      requestedModel: 'orphan',
      providers: [a],
      catalog: buildCatalog([a], aliases),
      runtime: runtime()
    })
    expect(result.modelKnown).toBe(false)
  })

  it('reports the remaining cooldown when every target is cooling', () => {
    const a = provider('a', ['m'])
    const rt = runtime()
    rt.markFailure(a, failure('transient'))
    const canonical = resolveCandidates({ requestedModel: 'm', providers: [a], catalog: buildCatalog([a]), runtime: rt })
    expect(canonical.candidates).toEqual([])
    expect(canonical.retryAfterMs).toBe(10_000)
    const pinned = resolveCandidates({ requestedModel: 'a/m', providers: [a], catalog: buildCatalog([a]), runtime: rt })
    expect(pinned.candidates).toEqual([])
    expect(pinned.retryAfterMs).toBe(10_000)
  })

  it('has no retry hint when the only provider is disabled', () => {
    const a = provider('a', ['m'], false)
    const result = resolveCandidates({ requestedModel: 'm', providers: [a], catalog: buildCatalog([a]), runtime: runtime() })
    expect(result.modelKnown).toBe(false)
    expect(result.retryAfterMs).toBeNull()
  })
})

describe('RuntimeStore', () => {
  it('applies cooldowns and trial after expiry', () => {
    const rt = runtime()
    const p = provider('a', ['m'])
    rt.markFailure(p, failure('quota'))
    expect(rt.isRoutable('a')).toBe(false)
    nowRef.value = new Date('2026-10-28T06:00:00Z')
    expect(rt.isRoutable('a')).toBe(true)
  })

  it('marks auth errors until reset', () => {
    const rt = runtime()
    const p = provider('a', ['m'])
    rt.markFailure(p, failure('auth'))
    nowRef.value = new Date('2030-01-01T00:00:00Z')
    expect(rt.isRoutable('a')).toBe(false)
    rt.reset('a')
    expect(rt.isRoutable('a')).toBe(true)
  })

  it('backs transient cooldowns off 10s/20s/40s/60s and ignores client aborts', () => {
    const rt = runtime()
    const p = provider('a', ['m'])
    const remaining = () => Date.parse(rt.get('a').cooldownUntil!) - nowRef.value.getTime()
    rt.markFailure(p, failure('request'))
    rt.markFailure(p, failure('transient'))
    expect(remaining()).toBe(10_000)
    rt.markFailure(p, failure('transient'))
    expect(remaining()).toBe(20_000)
    rt.markFailure(p, failure('transient'))
    expect(remaining()).toBe(40_000)
    rt.markFailure(p, failure('transient'))
    expect(remaining()).toBe(60_000)
    rt.markFailure(p, failure('transient'))
    expect(remaining()).toBe(60_000)
    rt.markSuccess('a')
    rt.markFailure(p, failure('transient'))
    expect(remaining()).toBe(10_000)
  })

  it('reports cooldown remainder and clears it after expiry', () => {
    const rt = runtime()
    const p = provider('a', ['m'])
    rt.markFailure(p, failure('transient'))
    expect(rt.cooldownRemainingMs('a')).toBe(10_000)
    nowRef.value = new Date(nowRef.value.getTime() + 4_000)
    expect(rt.cooldownRemainingMs('a')).toBe(6_000)
    nowRef.value = new Date(nowRef.value.getTime() + 7_000)
    expect(rt.cooldownRemainingMs('a')).toBe(0)
    expect(rt.cooldownRemainingMs('unknown')).toBe(0)
  })
})

describe('executeWithFailover', () => {
  const candidates = [provider('a', ['m']), provider('b', ['m']), provider('c', ['m'])].map((p) => ({ provider: p, upstreamModel: 'm' }))

  it('falls over on quota and succeeds on next provider', async () => {
    const rt = runtime()
    const tried: string[] = []
    const result = await executeWithFailover(candidates, async (c) => {
      tried.push(c.provider.id)
      if (c.provider.id === 'a') return { ok: false, failure: failure('quota') }
      return { ok: true, value: c.provider.id }
    }, rt)
    expect(tried).toEqual(['a', 'b'])
    expect(result).toMatchObject({ ok: true, candidate: { provider: { id: 'b' } } })
    expect(rt.isRoutable('a')).toBe(false)
  })

  it('does not fail over on request errors', async () => {
    const rt = runtime()
    const tried: string[] = []
    const result = await executeWithFailover(candidates, async (c) => {
      tried.push(c.provider.id)
      return { ok: false, failure: failure('request') }
    }, rt)
    expect(tried).toEqual(['a'])
    expect(result.ok).toBe(false)
  })

  it('returns the last failure after all candidates', async () => {
    const rt = runtime()
    const result = await executeWithFailover(candidates, async () => ({ ok: false, failure: failure('transient') }), rt)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.tried).toEqual(['a', 'b', 'c'])
  })

  it('notifies on model_missing', async () => {
    const rt = runtime()
    const seen: string[] = []
    await executeWithFailover(candidates.slice(0, 1), async () => ({ ok: false, failure: failure('model_missing') }), rt, {
      onModelMissing: (id) => seen.push(id)
    })
    expect(seen).toEqual(['a'])
  })

  it('notifies on quota failure so the probe can refresh', async () => {
    const rt = runtime()
    const seen: string[] = []
    await executeWithFailover(candidates.slice(0, 1), async () => ({ ok: false, failure: failure('quota') }), rt, {
      onQuotaFailure: (id) => seen.push(id)
    })
    expect(seen).toEqual(['a'])
  })

  it('retries a rate-limit 429 once before failing over', async () => {
    const rt = runtime()
    const calls: string[] = []
    const result = await executeWithFailover(candidates, async (c) => {
      calls.push(c.provider.id)
      if (c.provider.id === 'a' && calls.filter((id) => id === 'a').length === 1) {
        return { ok: false, failure: failure('rate_limit') }
      }
      return { ok: true, value: c.provider.id }
    }, rt, { rateLimitRetryMs: 0 })

    expect(calls).toEqual(['a', 'a'])
    expect(result).toMatchObject({ ok: true, candidate: { provider: { id: 'a' } } })
    expect(rt.isRoutable('a')).toBe(true)
  })

  it('skips saturated candidates without marking them failed', async () => {
    const rt = runtime()
    const tried: string[] = []
    const result = await executeWithFailover(candidates.slice(0, 2), async (c) => {
      if (c.provider.id === 'a') return { ok: false, saturated: true }
      tried.push(c.provider.id)
      return { ok: true, value: c.provider.id }
    }, rt)
    expect(tried).toEqual(['b'])
    expect(result).toMatchObject({ ok: true, candidate: { provider: { id: 'b' } } })
    expect(rt.isRoutable('a')).toBe(true)
    expect(rt.get('a').consecutiveFailures).toBe(0)
  })

  it('reports saturation when every candidate is full', async () => {
    const rt = runtime()
    const result = await executeWithFailover(candidates, async () => ({ ok: false, saturated: true }), rt)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.saturated).toBe(true)
      expect(result.tried).toEqual([])
    }
    expect(rt.isRoutable('a')).toBe(true)
  })

  it('does not retry quota 429 or a long Retry-After', async () => {
    const rt = runtime()
    const quotaCalls: string[] = []
    const quota = await executeWithFailover(candidates.slice(0, 1), async (c) => {
      quotaCalls.push(c.provider.id)
      return { ok: false, failure: failure('quota') }
    }, rt, { rateLimitRetryMs: 0 })
    expect(quotaCalls).toEqual(['a'])
    expect(quota.ok).toBe(false)

    const longWaitCalls: string[] = []
    const longWait = await executeWithFailover(candidates.slice(0, 1), async (c) => {
      longWaitCalls.push(c.provider.id)
      return { ok: false, failure: failure('rate_limit', 5_000) }
    }, rt, { rateLimitRetryMs: 0 })
    expect(longWaitCalls).toEqual(['a'])
    expect(longWait.ok).toBe(false)
  })

  it('stops the retry wait when the client aborts', async () => {
    const rt = runtime()
    const controller = new AbortController()
    let calls = 0
    const pending = executeWithFailover(candidates.slice(0, 1), async () => {
      calls += 1
      return { ok: false, failure: failure('rate_limit') }
    }, rt, { rateLimitRetryMs: 50, signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    const result = await pending

    expect(calls).toBe(1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('request')
  })
})
