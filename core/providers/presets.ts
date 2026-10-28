import type { Preset, ProviderConfig } from '../types'

export interface PresetDefinition {
  preset: Exclude<Preset, 'custom'>
  name: string
  baseUrl: string
  quotaAdapter: ProviderConfig['quotaAdapter']
}

export const PROVIDER_PRESETS: PresetDefinition[] = [
  { preset: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', quotaAdapter: 'opencode-go' },
  { preset: 'commandcode', name: 'CommandCode Goat', baseUrl: 'https://api.commandcode.ai/provider/v1', quotaAdapter: 'none' },
  { preset: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', quotaAdapter: 'deepseek-balance' }
]

export function createProviderFromPreset(preset: Preset, id: string = crypto.randomUUID()): ProviderConfig {
  const found = PROVIDER_PRESETS.find((p) => p.preset === preset)
  return {
    id,
    name: found?.name ?? 'Custom',
    preset,
    baseUrl: found?.baseUrl ?? '',
    quotaAdapter: found?.quotaAdapter ?? 'none',
    enabled: true,
    models: { cached: [], manual: [], lastSyncedAt: null },
    quota: { lowBalanceThreshold: 0.5, quotaCooldownMs: 5 * 60 * 60 * 1000, injectStreamUsage: true }
  }
}
