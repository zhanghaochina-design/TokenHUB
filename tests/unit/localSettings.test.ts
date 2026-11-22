import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCAL_SETTINGS, hfBaseUrl, normalizeLocalSettings } from '../../core/local/settings'

describe('local settings', () => {
  it('falls back to defaults for garbage input', () => {
    const settings = normalizeLocalSettings({ localPort: 'abc', backend: 'metal', defaultContext: 1, hfEndpoint: 'x' })
    expect(settings).toEqual(DEFAULT_LOCAL_SETTINGS)
  })

  it('keeps valid values and trims paths/urls', () => {
    const settings = normalizeLocalSettings({
      modelsDir: '  E:\\models  ',
      localPort: 9000,
      backend: 'vulkan',
      hfEndpoint: 'custom',
      hfEndpointCustom: 'https://hf.example.com/',
      githubMirror: 'https://ghfast.top/',
      defaultContext: 16384
    })
    expect(settings).toEqual({
      modelsDir: 'E:\\models',
      localPort: 9000,
      backend: 'vulkan',
      hfEndpoint: 'custom',
      hfEndpointCustom: 'https://hf.example.com',
      githubMirror: 'https://ghfast.top/',
      defaultContext: 16384
    })
  })

  it('resolves the HF base per endpoint kind', () => {
    expect(hfBaseUrl({ hfEndpoint: 'official', hfEndpointCustom: '' })).toBe('https://huggingface.co')
    expect(hfBaseUrl({ hfEndpoint: 'mirror', hfEndpointCustom: '' })).toBe('https://hf-mirror.com')
    expect(hfBaseUrl({ hfEndpoint: 'custom', hfEndpointCustom: 'https://hf.example.com' })).toBe('https://hf.example.com')
    expect(hfBaseUrl({ hfEndpoint: 'custom', hfEndpointCustom: '' })).toBe('https://huggingface.co')
  })
})