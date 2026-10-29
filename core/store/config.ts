import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppConfig, ModelAlias, ModelProtocolSupport, ProviderConfig } from '../types'
import { readText, writeFileAtomic } from './fsUtil'

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    providers: [],
    modelAliases: [],
    settings: {
      port: 8787,
      localKeyEnabled: false,
      autoStart: false,
      startMinimized: false,
      closeToTray: true,
      retentionDays: 30,
      quotaRefreshSec: 60
    }
  }
}

// 手改过的配置可能带 NaN/负数/非数字字符串；这些值进入 Date 运算会抛出 RangeError，
// 所以在读取时统一归一化，宁可回退默认值也不让应用起不来。
function finiteValue(raw: unknown, fallback: number, min: number): number {
  if (raw === null || raw === undefined || raw === '') return fallback
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value >= min ? value : fallback
}

function integerValue(raw: unknown, fallback: number, min: number, max: number): number {
  const value = finiteValue(raw, fallback, min)
  return Number.isInteger(value) && value <= max ? value : fallback
}

export function normalizeConfig(raw: unknown): AppConfig {
  const input = (raw ?? {}) as Partial<AppConfig>
  const base = defaultConfig()
  const merged = { ...base.settings, ...(input.settings ?? {}) }
  const settings = {
    ...merged,
    port: integerValue(merged.port, base.settings.port, 1, 65535),
    quotaRefreshSec: integerValue(merged.quotaRefreshSec, base.settings.quotaRefreshSec, 10, 3600),
    retentionDays: integerValue(merged.retentionDays, base.settings.retentionDays, 0, 3650)
  }
  const providers = Array.isArray(input.providers) ? input.providers.map(normalizeProvider) : []
  return { version: 1, providers, modelAliases: normalizeAliases(input.modelAliases), settings }
}

function normalizeAliases(raw: unknown): ModelAlias[] {
  if (!Array.isArray(raw)) return []
  const aliases: ModelAlias[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const value = (item ?? {}) as Partial<ModelAlias>
    const id = String(value.id ?? '').trim()
    if (!id || seen.has(id)) continue
    const byProvider = new Map<string, string>()
    for (const target of Array.isArray(value.targets) ? value.targets : []) {
      const providerId = String(target?.providerId ?? '').trim()
      const upstreamModel = String(target?.upstreamModel ?? '').trim()
      if (!providerId || !upstreamModel || byProvider.has(providerId)) continue
      byProvider.set(providerId, upstreamModel)
    }
    seen.add(id)
    // 零 target 的别名保留下来供 UI 提示/修复，不静默删除用户的 canonical 名称。
    aliases.push({ id, targets: [...byProvider].map(([providerId, upstreamModel]) => ({ providerId, upstreamModel })) })
  }
  return aliases
}

function normalizeProtocolSupport(raw: unknown): Record<string, ModelProtocolSupport> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, ModelProtocolSupport> = {}
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!model || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    out[model] = {
      anthropic: entry.anthropic === true ? true : entry.anthropic === false ? false : null,
      openai: entry.openai === true ? true : entry.openai === false ? false : null,
      checkedAt: typeof entry.checkedAt === 'string' ? entry.checkedAt : ''
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeProvider(raw: unknown): ProviderConfig {
  const p = (raw ?? {}) as Partial<ProviderConfig>
  return {
    id: String(p.id ?? crypto.randomUUID()),
    name: String(p.name ?? 'Unnamed'),
    preset: p.preset ?? 'custom',
    baseUrl: String(p.baseUrl ?? '').replace(/\/+$/, ''),
    quotaAdapter: p.quotaAdapter ?? 'none',
    enabled: p.enabled !== false,
    models: {
      cached: Array.isArray(p.models?.cached) ? p.models.cached.map(String) : [],
      manual: Array.isArray(p.models?.manual) ? p.models.manual.map(String) : [],
      lastSyncedAt: p.models?.lastSyncedAt ?? null
    },
    protocolSupport: normalizeProtocolSupport(p.protocolSupport),
    quota: {
      lowBalanceThreshold: finiteValue(p.quota?.lowBalanceThreshold, 0.5, 0),
      // 冷却时长会直接参与 new Date(now + ms)，非有限值会让冷却与 UI 倒计时崩掉。
      quotaCooldownMs: finiteValue(p.quota?.quotaCooldownMs, 5 * 60 * 60 * 1000, 0),
      injectStreamUsage: p.quota?.injectStreamUsage !== false
    }
  }
}

export async function loadConfig(dir: string): Promise<AppConfig> {
  const file = join(dir, 'config.json')
  const text = await readText(file)
  if (text === null) return defaultConfig()
  try {
    return normalizeConfig(JSON.parse(text))
  } catch {
    await rename(file, join(dir, `config.corrupt-${Date.now()}.json`)).catch(() => {})
    return defaultConfig()
  }
}

export async function saveConfig(dir: string, config: AppConfig): Promise<void> {
  await writeFileAtomic(join(dir, 'config.json'), JSON.stringify(config, null, 2))
}
