import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS, createProviderFromPreset } from '../../core/providers/presets'
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
      { id: 'deepseek-chat', providers: ['b'] },
      { id: 'glm-5.1', providers: ['a', 'b'] }
    ])
  })

  it('includes manual models', () => {
    const provider = p('a', [])
    provider.models.manual = ['m1']
    expect(buildCatalog([provider])).toEqual([{ id: 'm1', providers: ['a'] }])
    expect(providerSupports(provider, 'm1')).toBe(true)
  })

  it('only treats a slash as provider pin when prefix is a known id', () => {
    const providers = [p('p1', ['glm-5.1'])]
    expect(parseRequestedModel('p1/glm-5.1', providers)).toEqual({ providerId: 'p1', model: 'glm-5.1' })
    expect(parseRequestedModel('zai-org/glm-5.1', providers)).toEqual({ providerId: null, model: 'zai-org/glm-5.1' })
  })
})
