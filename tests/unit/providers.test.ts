import { describe, expect, it } from 'vitest'
import { APP_VERSION } from '../../core/appInfo'
import { PROVIDER_PRESETS, anthropicBaseUrlFor, createProviderFromPreset, defaultAnthropicBaseUrl, defaultMaxConcurrency, providerConcurrencyLimit, protocolSupported, upstreamExtraHeaders, upstreamProtocol } from '../../core/providers/presets'
import { buildCatalog, isTargetHidden, listedCatalog, parseRequestedModel, providerSupports } from '../../core/providers/catalog'
import { discoverModels, modelEndpointsFromUpstream, modelMetaFromUpstream } from '../../core/providers/discover'
import { resolveCandidates } from '../../core/router/router'
import { RuntimeStore } from '../../core/router/runtime'

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
    expect(provider.maxConcurrency).toBe(3)
    expect(createProviderFromPreset('commandcode', 'p2').quotaAdapter).toBe('commandcode-usage')
    expect(createProviderFromPreset('commandcode', 'p2').maxConcurrency).toBe(3)
  })
})

describe('provider concurrency', () => {
  it('defaults OpenCode Go to 3 and treats invalid values as the preset default', () => {
    expect(defaultMaxConcurrency('opencode-go')).toBe(3)
    expect(defaultMaxConcurrency('custom')).toBe(0)
    const provider = createProviderFromPreset('opencode-go', 'p1')
    expect(providerConcurrencyLimit(provider)).toBe(3)
    provider.maxConcurrency = 7
    expect(providerConcurrencyLimit(provider)).toBe(7)
    provider.maxConcurrency = -1
    expect(providerConcurrencyLimit(provider)).toBe(3)
    provider.maxConcurrency = 0
    expect(providerConcurrencyLimit(provider)).toBe(0)
  })
})

describe('anthropic base url', () => {
  it('derives the DeepSeek Anthropic base under /anthropic/v1', () => {
    const deepseek = createProviderFromPreset('deepseek', 'd1')
    expect(anthropicBaseUrlFor(deepseek)).toBe('https://api.deepseek.com/anthropic/v1')
    expect(defaultAnthropicBaseUrl('deepseek', deepseek.baseUrl)).toBe('https://api.deepseek.com/anthropic/v1')
  })

  it('keeps OpenCode Go and CommandCode on the shared base', () => {
    expect(anthropicBaseUrlFor(createProviderFromPreset('opencode-go', 'o1'))).toBe('https://opencode.ai/zen/go/v1')
    expect(anthropicBaseUrlFor(createProviderFromPreset('commandcode', 'c1'))).toBe('https://api.commandcode.ai/provider/v1')
    expect(defaultAnthropicBaseUrl('commandcode', 'https://api.commandcode.ai/provider/v1')).toBe('')
  })

  it('honours an explicit override and custom DeepSeek hosts', () => {
    const custom = createProviderFromPreset('custom', 'x1')
    custom.baseUrl = 'https://proxy.test/v1'
    custom.anthropicBaseUrl = 'https://proxy.test/claude/v1/'
    expect(anthropicBaseUrlFor(custom)).toBe('https://proxy.test/claude/v1')

    const proxied = createProviderFromPreset('deepseek', 'd2')
    proxied.baseUrl = 'https://proxy.test/deepseek/v1'
    expect(anthropicBaseUrlFor(proxied)).toBe('https://proxy.test/deepseek/v1')
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

  it('falls back to upstream endpoint declarations when a probe is indeterminate', () => {
    const declared = { anthropic: true, openai: false }
    const unknownAnthropic = { anthropic: null, openai: false }
    expect(protocolSupported('commandcode', 'claude-fable-5', 'anthropic', unknownAnthropic, declared)).toBe(true)
    expect(protocolSupported('commandcode', 'claude-fable-5', 'openai', unknownAnthropic, declared)).toBe(false)
    expect(upstreamProtocol('commandcode', 'claude-fable-5', 'openai', unknownAnthropic, declared)).toBe('anthropic')
    // 没有上游元数据时保持“未知”，不能拿预设默认冒充结论。
    expect(protocolSupported('custom', 'm', 'anthropic', { anthropic: null, openai: true })).toBeNull()
  })

  it('adds OpenCode session headers only for the opencode-go preset', () => {
    expect(upstreamExtraHeaders(createProviderFromPreset('opencode-go', 'p1'), 'sess-1')).toEqual({
      'x-opencode-session': 'sess-1',
      'user-agent': `TokenHUB/${APP_VERSION}`
    })
    expect(upstreamExtraHeaders(createProviderFromPreset('commandcode', 'p2'), 'sess-1')).toEqual({})
  })
})

describe('discoverModels', () => {
  it('dedupes and sorts ids', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }), { status: 200 })
    await expect(discoverModels('https://x/v1', 'k', fetchFn as never)).resolves.toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('reads OpenCode Go capability metadata', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({
        data: [{
          id: 'm1',
          limit: { context: 1_000_000, output: 384_000 },
          modalities: { input: ['text', 'image/png'] },
          capabilities: { reasoning: { supported: true, effort: ['low', 'high', 'max'] } }
        }]
      }), { status: 200 })
    await expect(discoverModels('https://x/v1', 'k', fetchFn as never)).resolves.toEqual([{
      id: 'm1',
      meta: {
        contextLength: 1_000_000,
        vision: true,
        thinking: { param: 'effort', values: ['low', 'high', 'max'] }
      }
    }])
  })

  it('maps CommandCode supported_endpoints to protocol shapes', () => {
    expect(modelEndpointsFromUpstream({ supported_endpoints: ['/messages'] })).toEqual({ anthropic: true, openai: false })
    expect(modelEndpointsFromUpstream({ supported_endpoints: ['/chat/completions', '/responses'] }))
      .toEqual({ anthropic: false, openai: true })
    expect(modelEndpointsFromUpstream({ supported_endpoints: [] })).toBeUndefined()
    expect(modelEndpointsFromUpstream({})).toBeUndefined()
  })

  it('exposes supported endpoints from discovery', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({
        data: [{ id: 'claude-fable-5', context_length: 1_000_000, supported_endpoints: ['/messages'] }]
      }), { status: 200 })
    await expect(discoverModels('https://x/v1', 'k', fetchFn as never)).resolves.toEqual([{
      id: 'claude-fable-5',
      meta: { contextLength: 1_000_000 },
      endpoints: { anthropic: true, openai: false }
    }])
  })

  it('reads CommandCode context length and keeps missing fields unknown', () => {
    expect(modelMetaFromUpstream({ context_length: 200_000 })).toEqual({ contextLength: 200_000 })
    expect(modelMetaFromUpstream({ modalities: { input: ['text'] }, capabilities: { reasoning: { supported: false } } }))
      .toEqual({ vision: false, thinking: { param: 'none', values: [] } })
    expect(modelMetaFromUpstream({ id: 'plain' })).toBeUndefined()
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
    models: {
      cached: models,
      manual: [] as string[],
      hidden: [] as string[],
      scanHidden: [] as string[],
      shown: [] as string[],
      lastSyncedAt: null
    }
  })
  // 本组只关心路由与合并；能力元数据另有 modelMeta 测试覆盖。
  const withoutMeta = (models: ReturnType<typeof buildCatalog>) =>
    models.map((model) => {
      const { meta, ...rest } = model
      void meta
      return rest
    })

  it('merges same model across providers preserving provider order', () => {
    const catalog = buildCatalog([p('a', ['glm-5.1']), p('b', ['glm-5.1', 'deepseek-chat']), p('c', ['glm-5.1'], false)])
    expect(withoutMeta(catalog)).toEqual([
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
    expect(withoutMeta(buildCatalog([provider]))).toEqual([
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
    expect(withoutMeta(catalog)).toEqual([
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
    expect(withoutMeta(catalog)).toEqual([
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
    expect(withoutMeta(catalog)).toEqual([
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
    expect(withoutMeta(catalog)).toEqual([
      {
        id: 'x',
        providers: ['a'],
        targets: [{ providerId: 'a', upstreamModel: 'x', source: 'alias' }],
        isAlias: true
      }
    ])
  })

  it('hides targets from the local listing without affecting routing', () => {
    const provider = p('a', ['m1', 'm2'])
    provider.models.scanHidden = ['m2']
    const catalog = buildCatalog([provider])
    expect(listedCatalog(catalog, [provider]).map((model) => model.id)).toEqual(['m1'])
    expect(isTargetHidden(provider, 'm2')).toBe(true)
    expect(providerSupports(provider, 'm2')).toBe(true)

    provider.models.shown = ['m2']
    expect(isTargetHidden(provider, 'm2')).toBe(false)
    expect(listedCatalog(catalog, [provider]).map((model) => model.id)).toEqual(['m1', 'm2'])

    // 隐藏只影响展示：隐藏期间按统一 ID 仍可正常解析路由。
    provider.models.shown = []
    const resolution = resolveCandidates({
      requestedModel: 'm2',
      providers: [provider],
      catalog,
      runtime: new RuntimeStore()
    })
    expect(resolution.modelKnown).toBe(true)
    expect(resolution.candidates.map((candidate) => candidate.upstreamModel)).toEqual(['m2'])

    provider.models.hidden = ['m1']
    provider.models.scanHidden = []
    expect(listedCatalog(catalog, [provider]).map((model) => model.id)).toEqual(['m2'])
    expect(catalog.map((model) => model.id)).toEqual(['m1', 'm2'])
  })

  it('drops a merged model only when every target is hidden', () => {
    const a = p('a', ['m'])
    const b = p('b', ['m'])
    a.models.hidden = ['m']
    const catalog = buildCatalog([a, b])
    expect(listedCatalog(catalog, [a, b]).map((model) => model.id)).toEqual(['m'])
    b.models.hidden = ['m']
    expect(listedCatalog(catalog, [a, b])).toEqual([])
  })

  it('only treats a slash as provider pin when prefix is a known id', () => {
    const providers = [p('p1', ['glm-5.1'])]
    expect(parseRequestedModel('p1/glm-5.1', providers)).toEqual({ providerId: 'p1', model: 'glm-5.1' })
    expect(parseRequestedModel('zai-org/glm-5.1', providers)).toEqual({ providerId: null, model: 'zai-org/glm-5.1' })
  })
})
