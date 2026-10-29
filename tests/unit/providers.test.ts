import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS, createProviderFromPreset, protocolSupported, upstreamExtraHeaders, upstreamProtocol } from '../../core/providers/presets'
import { buildCatalog, parseRequestedModel, providerSupports } from '../../core/providers/catalog'
import { discoverModels } from '../../core/providers/discover'

describe('presets', () => {
  it('ships the three providers with correct endpoints', () => {
    expect(PROVIDER_PRESETS.map((p) => p.baseUrl)).toEqual([
      'https://opencode.ai/zen/go/v1',
      'https://api.commandcode.ai/provider/v1',
      'https://api.deepseek.com/v1'
    ])
    const provider = createProviderFromPreset('opencode-go', 'p1')
    expect(provider.quotaAdapter).toBe('opencode-go')
    expect(provider.id).toBe('p1')
  })
})

describe('upstream protocol', () => {
  it('keeps CommandCode model-based routing regardless of the client protocol', () => {
    expect(upstreamProtocol('commandcode', 'claude-opus-5-5', 'openai')).toBe('anthropic')
    expect(upstreamProtocol('commandcode', 'Claude-Sonnet-5', 'anthropic')).toBe('anthropic')
    expect(upstreamProtocol('commandcode', 'deepseek/deepseek-v4-pro', 'anthropic')).toBe('openai')
    expect(upstreamProtocol('opencode-go', 'claude-haiku-5-5', 'openai')).toBe('openai')
    expect(upstreamProtocol('custom', 'claude-opus-5-5', 'anthropic')).toBe('openai')
  })

  it('prefers the client protocol when the provider supports both shapes', () => {
    expect(upstreamProtocol('opencode-go', 'deepseek-v4.1-flash', 'anthropic')).toBe('anthropic')
    expect(upstreamProtocol('opencode-go', 'deepseek-v4.1-flash', 'openai')).toBe('openai')
  })

  it('honours scanned support and falls back to the only available shape', () => {
    expect(
      upstreamProtocol('opencode-go', 'longcat-2.0', 'anthropic', { anthropic: false, openai: true })
    ).toBe('openai')
    expect(
      upstreamProtocol('opencode-go', 'gemini-4-argon', 'openai', { anthropic: true, openai: false })
    ).toBe('anthropic')
    expect(
      upstreamProtocol('commandcode', 'claude-opus-5-5', 'openai', { anthropic: true, openai: false })
    ).toBe('anthropic')
    expect(
      upstreamProtocol('commandcode', 'z-ai/glm-5.3', 'anthropic', { anthropic: false, openai: true })
    ).toBe('openai')
  })

  it('exposes the resolved support state used by the fallback guard', () => {
    expect(protocolSupported('opencode-go', 'm', 'openai')).toBe(true)
    expect(protocolSupported('opencode-go', 'm', 'anthropic')).toBe(true)
    expect(protocolSupported('commandcode', 'claude-opus-5-5', 'openai')).toBe(false)
    expect(protocolSupported('commandcode', 'deepseek/deepseek-v4-pro', 'anthropic')).toBe(false)
    expect(protocolSupported('custom', 'claude-opus-5-5', 'anthropic')).toBe(false)
    expect(protocolSupported('custom', 'm', 'anthropic', { anthropic: null, openai: true })).toBeNull()
  })

  it('adds OpenCode session headers only for the opencode-go preset', () => {
    expect(upstreamExtraHeaders(createProviderFromPreset('opencode-go', 'p1'), 'sess-1')).toEqual({
      'x-opencode-session': 'sess-1',
      'user-agent': 'TokenHUB/0.1.0'
    })
    expect(upstreamExtraHeaders(createProviderFromPreset('commandcode', 'p2'), 'sess-1')).toEqual({})
  })
})

describe('discoverModels', () => {
  it('dedupes and sorts ids', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }), { status: 200 })
    await expect(discoverModels('https://x/v1', 'k', fetchFn as never)).resolves.toEqual(['a', 'b'])
  })

  it('throws on non-2xx', async () => {
    const fetchFn = async () => new Response('nope', { status: 401 })
    await expect(discoverModels('https://x/v1', 'k', fetchFn as never)).rejects.toThrow('models 401')
  })
})

describe('catalog', () => {
  const p = (id: string, models: string[], enabled = true) => ({
    ...createProviderFromPreset('custom', id),
    enabled,
    models: { cached: models, manual: [] as string[], lastSyncedAt: null }
  })

  it('merges same model across providers preserving provider order', () => {
    const catalog = buildCatalog([p('a', ['glm-5.1']), p('b', ['glm-5.1', 'deepseek-chat']), p('c', ['glm-5.1'], false)])
    expect(catalog).toEqual([
      {
        id: 'deepseek-chat',
        providers: ['b'],
        targets: [{ providerId: 'b', upstreamModel: 'deepseek-chat', source: 'exact' }]
      },
      {
        id: 'glm-5.1',
        providers: ['a', 'b'],
        targets: [
          { providerId: 'a', upstreamModel: 'glm-5.1', source: 'exact' },
          { providerId: 'b', upstreamModel: 'glm-5.1', source: 'exact' }
        ]
      }
    ])
  })

  it('includes manual models', () => {
    const provider = p('a', [])
    provider.models.manual = ['m1']
    expect(buildCatalog([provider])).toEqual([
      { id: 'm1', providers: ['a'], targets: [{ providerId: 'a', upstreamModel: 'm1', source: 'exact' }] }
    ])
    expect(providerSupports(provider, 'm1')).toBe(true)
  })

  it('maps one canonical id to different upstream ids and hides the raw targets', () => {
    const a = p('a', ['deepseek-v4.1-flash'])
    const b = p('b', ['deepseek/deepseek-v4.1-flash'])
    const catalog = buildCatalog([a, b], [
      {
        id: 'deepseek4.1flash',
        targets: [
          { providerId: 'a', upstreamModel: 'deepseek-v4.1-flash' },
          { providerId: 'b', upstreamModel: 'deepseek/deepseek-v4.1-flash' }
        ]
      }
    ])
    expect(catalog).toEqual([
      {
        id: 'deepseek4.1flash',
        providers: ['a', 'b'],
        targets: [
          { providerId: 'a', upstreamModel: 'deepseek-v4.1-flash', source: 'alias' },
          { providerId: 'b', upstreamModel: 'deepseek/deepseek-v4.1-flash', source: 'alias' }
        ],
        isAlias: true
      }
    ])
  })

  it('lets an explicit alias target win over a raw model with the same canonical id', () => {
    const a = p('a', ['m'])
    const catalog = buildCatalog([a], [{ id: 'm', targets: [{ providerId: 'a', upstreamModel: 'm-real' }] }])
    expect(catalog).toEqual([
      {
        id: 'm',
        providers: ['a'],
        targets: [{ providerId: 'a', upstreamModel: 'm-real', source: 'alias' }],
        isAlias: true
      }
    ])
  })

  it('implicitly includes a provider whose raw model equals the canonical id', () => {
    const a = p('a', ['m'])
    const b = p('b', ['b-real'])
    const catalog = buildCatalog([a, b], [{ id: 'm', targets: [{ providerId: 'b', upstreamModel: 'b-real' }] }])
    expect(catalog).toEqual([
      {
        id: 'm',
        providers: ['a', 'b'],
        targets: [
          { providerId: 'a', upstreamModel: 'm', source: 'exact' },
          { providerId: 'b', upstreamModel: 'b-real', source: 'alias' }
        ],
        isAlias: true
      }
    ])
  })

  it('ignores disabled, missing and zero-target aliases', () => {
    const a = p('a', ['x'])
    const disabled = p('c', ['c-model'], false)
    const catalog = buildCatalog([a, disabled], [
      { id: 'x', targets: [{ providerId: 'a', upstreamModel: 'x' }, { providerId: 'c', upstreamModel: 'c-model' }, { providerId: 'missing', upstreamModel: 'z' }] },
      { id: 'orphan', targets: [] }
    ])
    expect(catalog).toEqual([
      {
        id: 'x',
        providers: ['a'],
        targets: [{ providerId: 'a', upstreamModel: 'x', source: 'alias' }],
        isAlias: true
      }
    ])
  })

  it('only treats a slash as provider pin when prefix is a known id', () => {
    const providers = [p('p1', ['glm-5.1'])]
    expect(parseRequestedModel('p1/glm-5.1', providers)).toEqual({ providerId: 'p1', model: 'glm-5.1' })
    expect(parseRequestedModel('zai-org/glm-5.1', providers)).toEqual({ providerId: null, model: 'zai-org/glm-5.1' })
  })
})
