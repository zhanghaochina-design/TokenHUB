import { describe, expect, it } from 'vitest'
import { modelSignature, suggestModelAliases } from '../../core/providers/aliases'
import { createProviderFromPreset } from '../../core/providers/presets'

const p = (id: string, models: string[]) => ({
  ...createProviderFromPreset('custom', id),
  models: { cached: models, manual: [] as string[], lastSyncedAt: null }
})

describe('modelSignature', () => {
  it('uses the last path segment and strips punctuation/case', () => {
    expect(modelSignature('deepseek-v4.1-flash')).toBe('deepseekv41flash')
    expect(modelSignature('deepseek/deepseek-v4.1-flash')).toBe('deepseekv41flash')
    expect(modelSignature('zai-org/GLM 5.1')).toBe('glm51')
  })
})

describe('suggestModelAliases', () => {
  it('suggests one group across providers with different raw ids', () => {
    const suggestions = suggestModelAliases(
      [p('a', ['deepseek-v4.1-flash']), p('b', ['deepseek/deepseek-v4.1-flash'])],
      []
    )
    expect(suggestions).toEqual([
      {
        id: 'deepseek-v4.1-flash',
        targets: [
          { providerId: 'a', upstreamModel: 'deepseek-v4.1-flash' },
          { providerId: 'b', upstreamModel: 'deepseek/deepseek-v4.1-flash' }
        ]
      }
    ])
  })

  it('does not suggest models that already share the same raw id', () => {
    expect(suggestModelAliases([p('a', ['m']), p('b', ['m'])], [])).toEqual([])
  })

  it('skips groups where one provider has multiple same-signature candidates', () => {
    expect(
      suggestModelAliases(
        [p('a', ['deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash']), p('b', ['deepseek/deepseek-v4.1-flash'])],
        []
      )
    ).toEqual([])
  })

  it('skips raw models already used as alias targets or canonical ids', () => {
    const aliases = [{ id: 'existing', targets: [{ providerId: 'a', upstreamModel: 'deepseek-v4.1-flash' }] }]
    expect(
      suggestModelAliases(
        [p('a', ['deepseek-v4.1-flash']), p('b', ['deepseek/deepseek-v4.1-flash'])],
        aliases
      )
    ).toEqual([])
    expect(
      suggestModelAliases([p('a', ['deepseek-v4.1-flash']), p('b', ['deepseek/deepseek-v4.1-flash'])], [
        { id: 'deepseek-v4.1-flash', targets: [] }
      ])
    ).toEqual([])
  })
})
