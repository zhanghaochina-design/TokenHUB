import { describe, expect, it } from 'vitest'
import {
  aggregateModelMeta,
  builtinModelMeta,
  effectiveModelMeta,
  normalizeModelMeta
} from '../../core/providers/modelMeta'
import { buildCatalog } from '../../core/providers/catalog'
import { createProviderFromPreset } from '../../core/providers/presets'
import type { EffectiveModelMeta } from '../../core/types'

const unknownMeta: EffectiveModelMeta = { contextLength: null, vision: null, thinking: null }

function provider(id: string, model: string, modelMeta?: ReturnType<typeof normalizeModelMeta>) {
  const config = createProviderFromPreset('custom', id)
  config.models = { cached: [model], manual: [], lastSyncedAt: null }
  if (modelMeta) config.modelMeta = { [model]: modelMeta }
  return config
}

describe('builtinModelMeta', () => {
  it('matches by the last path segment', () => {
    expect(builtinModelMeta('anthropic/claude-sonnet-4-5')).toMatchObject({
      contextLength: 200_000,
      vision: true
    })
    expect(builtinModelMeta('claude-sonnet-4-5')?.thinking?.param).toBe('thinking.budget_tokens')
    expect(builtinModelMeta('models/gemini-2.5-pro')?.contextLength).toBe(1_048_576)
  })

  it('keeps more specific prefixes ahead of generic ones', () => {
    expect(builtinModelMeta('deepseek-v4.1-flash')).toMatchObject({
      contextLength: 1_000_000,
      vision: true,
      thinking: { param: 'effort', values: ['low', 'high', 'max'] }
    })
    expect(builtinModelMeta('deepseek-chat')?.contextLength).toBe(128_000)
    expect(builtinModelMeta('qwen3-vl-plus')?.vision).toBe(true)
  })

  it('returns null for unknown models instead of guessing', () => {
    expect(builtinModelMeta('some-vendor/unknown-model')).toBeNull()
  })
})

describe('effectiveModelMeta', () => {
  it('falls back to the builtin suggestion per field', () => {
    const meta = effectiveModelMeta({ modelMeta: { 'claude-x': { contextLength: 1000, vision: false } } }, 'claude-x')
    expect(meta.contextLength).toBe(1000)
    expect(meta.vision).toBe(false)
    expect(meta.thinking?.param).toBe('thinking.budget_tokens')
  })

  it('treats explicit null as unknown even when a builtin suggestion exists', () => {
    const meta = effectiveModelMeta({ modelMeta: { 'claude-x': { contextLength: null } } }, 'claude-x')
    expect(meta.contextLength).toBeNull()
    expect(meta.vision).toBe(true)
  })

  it('returns all-null meta when neither override nor builtin exists', () => {
    expect(effectiveModelMeta({ modelMeta: {} }, 'unknown-model')).toEqual(unknownMeta)
  })

  it('prefers manual over discovered over builtin per field', () => {
    const meta = effectiveModelMeta(
      {
        modelMeta: { 'claude-x': { contextLength: 1000 } },
        modelDiscovery: { 'claude-x': { contextLength: 500_000, vision: false } }
      },
      'claude-x'
    )
    expect(meta.contextLength).toBe(1000)
    expect(meta.vision).toBe(false)
    expect(meta.thinking?.param).toBe('thinking.budget_tokens')
  })
})

describe('aggregateModelMeta', () => {
  it('takes the minimum context and any vision support', () => {
    const meta = aggregateModelMeta([
      { contextLength: 200_000, vision: true, thinking: null },
      { contextLength: 128_000, vision: false, thinking: null }
    ])
    expect(meta.contextLength).toBe(128_000)
    expect(meta.vision).toBe(true)
  })

  it('reports vision false only when every target rejects images', () => {
    expect(aggregateModelMeta([
      { contextLength: null, vision: false, thinking: null },
      { contextLength: null, vision: false, thinking: null }
    ]).vision).toBe(false)
    expect(aggregateModelMeta([
      { contextLength: null, vision: false, thinking: null },
      { contextLength: null, vision: null, thinking: null }
    ]).vision).toBeNull()
  })

  it('intersects thinking values only when the native param matches', () => {
    const meta = aggregateModelMeta([
      { contextLength: null, vision: null, thinking: { param: 'reasoning_effort', values: ['low', 'medium', 'high'] } },
      { contextLength: null, vision: null, thinking: { param: 'reasoning_effort', values: ['medium', 'high'] } }
    ])
    expect(meta.thinking).toEqual({ param: 'reasoning_effort', values: ['medium', 'high'] })

    const mismatched = aggregateModelMeta([
      { contextLength: null, vision: null, thinking: { param: 'reasoning_effort', values: ['low'] } },
      { contextLength: null, vision: null, thinking: { param: 'thinking.budget_tokens', values: ['1024'] } }
    ])
    expect(mismatched.thinking).toBeNull()
  })

  it('keeps the none marker without values', () => {
    expect(aggregateModelMeta([
      { contextLength: null, vision: null, thinking: { param: 'none', values: [] } },
      { contextLength: null, vision: null, thinking: { param: 'none', values: [] } }
    ]).thinking).toEqual({ param: 'none', values: [] })
  })
})

describe('normalizeModelMeta', () => {
  it('drops invalid fields and deduplicates values', () => {
    expect(normalizeModelMeta({
      contextLength: '200000',
      vision: 'yes',
      thinking: { param: ' reasoning_effort ', values: ['low', ' low ', 5, 'high'] }
    })).toEqual({ thinking: { param: 'reasoning_effort', values: ['low', 'high'] } })
  })

  it('normalizes explicit unknown values and the none marker', () => {
    expect(normalizeModelMeta({ contextLength: null, vision: null, thinking: null })).toEqual({
      contextLength: null,
      vision: null,
      thinking: null
    })
    expect(normalizeModelMeta({ thinking: { param: 'none', values: ['ignored'] } })).toEqual({
      thinking: { param: 'none', values: [] }
    })
  })

  it('returns null when nothing valid is left', () => {
    expect(normalizeModelMeta({ contextLength: -1, vision: 'true', thinking: { param: '' } })).toBeNull()
    expect(normalizeModelMeta(null)).toBeNull()
  })
})

describe('buildCatalog meta', () => {
  it('attaches aggregated capability metadata to merged models', () => {
    const p1 = provider('p1', 'claude-sonnet-4-5', normalizeModelMeta({ contextLength: 50_000 }))
    const p2 = provider('p2', 'claude-sonnet-4-5')
    const catalog = buildCatalog([p1, p2])
    expect(catalog).toHaveLength(1)
    expect(catalog[0].meta.contextLength).toBe(50_000)
    expect(catalog[0].meta.vision).toBe(true)
    expect(catalog[0].meta.thinking?.param).toBe('thinking.budget_tokens')
  })
})