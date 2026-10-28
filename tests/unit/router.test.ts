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
})
