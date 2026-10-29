import { APP_NAME, APP_VERSION } from '../appInfo'
import type { ModelProtocolSupport, Preset, Protocol, ProviderConfig } from '../types'

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

type SupportState = Pick<ModelProtocolSupport, 'anthropic' | 'openai'>

// 没有扫描数据时的预设默认：CommandCode 按模型只提供一个形状；OpenCode Go 两个入口都可用；
// 其它预设只对 Chat 做保证，Anthropic 入口需先扫描确认。
function defaultProtocolSupport(preset: Preset, model: string): SupportState {
  if (preset === 'commandcode') {
    return /^claude/i.test(model) ? { anthropic: true, openai: false } : { anthropic: false, openai: true }
  }
  if (preset === 'opencode-go') return { anthropic: true, openai: true }
  return { anthropic: false, openai: true }
}

/** 能力表未覆盖时回退到预设默认；null 表示无法判定。 */
export function protocolSupported(
  preset: Preset,
  model: string,
  protocol: Protocol,
  support?: SupportState
): boolean | null {
  const defaults = defaultProtocolSupport(preset, model)
  const scanned = support?.[protocol]
  return scanned !== undefined ? scanned : defaults[protocol]
}

/** 优先使用与客户端一致的上游形状；能力表明确不支持时改用另一形状。 */
export function upstreamProtocol(
  preset: Preset,
  model: string,
  clientProtocol: Protocol,
  support?: SupportState
): Protocol {
  const other: Protocol = clientProtocol === 'openai' ? 'anthropic' : 'openai'
  const preferred = protocolSupported(preset, model, clientProtocol, support)
  const alternate = protocolSupported(preset, model, other, support)
  if (preferred === true) return clientProtocol
  if (preferred === false) return alternate === false ? clientProtocol : other
  return alternate === true ? other : clientProtocol
}

/** OpenCode Go 要求稳定的会话头与可识别的 User-Agent，缺失时上游直接 400。 */
export function upstreamExtraHeaders(provider: ProviderConfig, sessionId: string): Record<string, string> {
  if (provider.preset !== 'opencode-go') return {}
  return { 'x-opencode-session': sessionId, 'user-agent': `${APP_NAME}/${APP_VERSION}` }
}

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
