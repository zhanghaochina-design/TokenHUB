import { describe, expect, it } from 'vitest'
import { createProviderFromPreset, providerConcurrencyLimit, protocolSupported } from '../../core/providers/presets'

describe('local preset', () => {
  it('defaults to one concurrent request, no quota adapter and OpenAI-only upstream shape', () => {
    const provider = createProviderFromPreset('local', 'local')
    expect(provider.quotaAdapter).toBe('none')
    expect(providerConcurrencyLimit(provider)).toBe(1)
    expect(protocolSupported('local', 'm', 'openai')).toBe(true)
    expect(protocolSupported('local', 'm', 'anthropic')).toBe(false)
  })
})