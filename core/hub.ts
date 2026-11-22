import { join } from 'node:path'
import type {
  AppConfig,
  AppState,
  HistoryRecord,
  HistorySink,
  ModelAlias,
  ModelEndpointSupport,
  ModelMeta,
  ProtocolScanResult,
  ProviderConfig,
  ProviderSpeedStats,
  ProviderUsageStats,
  QuotaSnapshot,
  Settings,
  TodayStats
} from './types'
import { defaultConfig, loadConfig, saveConfig } from './store/config'
import { readText, writeFileAtomic } from './store/fsUtil'
import { SecretStore, type CipherPort } from './store/secrets'
import { HistoryStore } from './history/store'
import { computeSpeedStats } from './speed'
import { computeUsageStats, resolveUsageWindows } from './usage'
import { Logger } from './store/logger'
import { RuntimeStore } from './router/runtime'
import { buildCatalog } from './providers/catalog'
import { normalizeModelMeta } from './providers/modelMeta'
import { createProviderFromPreset, providerConcurrencyLimit } from './providers/presets'
import { ProviderGate } from './server/gate'
import { discoverModels } from './providers/discover'
import { scanProviderProtocols } from './providers/scan'
import { startServer } from './server/start'
import { QuotaScheduler } from './quota/scheduler'
import { opencodeGoAdapter } from './quota/opencodeGo'
import { deepseekBalanceAdapter } from './quota/deepseek'
import { commandCodeAdapter } from './quota/commandcode'
import type { QuotaAdapter } from './quota/types'
import type { AppDeps } from './server/app'
import type { ProviderInput, ProviderPatch, TestResult } from './ipc-types'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MODEL_STALE_MS = DAY_MS
// 未知模型的发现刷新限流：与上游 404 共用，60s 内最多一次，避免每次失败都打一遍所有供应商。
const MODEL_REFRESH_THROTTLE_MS = 60 * 1000
const QUOTA_CACHE_FILE = 'quota-cache.json'
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface HubOptions {
  dataDir: string
  cipher: CipherPort
  // 与 AppDeps 同型：同一份注入的 fetch 既供发现/探针使用，也供 /v1 转发使用。
  fetchFn?: AppDeps['fetchFn']
  now?: () => Date
  portOverride?: number
  onStateChange?: (state: AppState) => void
}

function emptyStats(): TodayStats {
  return { requests: 0, promptTokens: 0, completionTokens: 0, failures: 0 }
}

function localDay(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  // fetch 的网络错误只有 "fetch failed"，真正原因（DNS/TLS/连接重置）在 cause 里。
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) return `${error.message}: ${cause.message}`
  return cause ? `${error.message}: ${String(cause)}` : error.message
}

// 上游只允许 https；明文 http 仅限本机回环，避免把 Key 发给局域网/公网。
function validateBaseUrl(raw: string): string {
  const baseUrl = raw.trim().replace(/\/+$/, '')
  const https = /^https:\/\/[^\s/]+/i.test(baseUrl)
  const localHttp = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(baseUrl)
  if (!https && !localHttp) throw new Error('baseUrl must use https (http is only allowed for 127.0.0.1 or localhost)')
  return baseUrl
}

function validateOptionalBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || !raw.trim()) return undefined
  return validateBaseUrl(raw)
}

function normalizeModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))]
}

function validateMaxConcurrency(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0 || value > 64) {
    throw new Error('maxConcurrency must be an integer between 0 and 64')
  }
  return value
}

// 比较用序列化：对象键排序，避免同一份元数据因键序不同被判成变化。
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner
  )
}

/** 本地供应商同步前的内容比对：模型集合无序，元数据按键序无关比较。 */
function localProviderUnchanged(
  provider: ProviderConfig,
  baseUrl: string,
  models: string[],
  meta: Record<string, ModelMeta> | undefined
): boolean {
  if (provider.preset !== 'local' || provider.quotaAdapter !== 'none' || provider.maxConcurrency !== 1) return false
  if (provider.baseUrl !== baseUrl || provider.models.manual.length > 0) return false
  const cached = provider.models.cached
  if (cached.length !== models.length || !cached.every((model) => models.includes(model))) return false
  return stableJson(provider.modelDiscovery ?? {}) === stableJson(meta ?? {})
}

function isQuotaSnapshot(value: unknown): value is QuotaSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Record<string, unknown>
  return typeof snapshot.providerId === 'string' && typeof snapshot.availability === 'string' && typeof snapshot.fetchedAt === 'string'
}

export class Hub {
  readonly runtime: RuntimeStore
  // 端口切换时新旧服务共用同一份并发计数；额度卡也直接读它。
  private readonly gate = new ProviderGate()
  private gateEmitTimer: ReturnType<typeof setTimeout> | null = null
  private gateEmitAt = 0
  private config: AppConfig = defaultConfig()
  private secrets!: SecretStore
  private history!: HistoryStore
  private historySink!: HistorySink
  private logger!: Logger
  private scheduler!: QuotaScheduler
  private server: { port: number; close(): Promise<void> } | null = null
  // 启动监听失败不阻断 Hub：界面据此提示用户改端口，服务可由 updateSettings 重新拉起。
  private serverError: string | null = null
  private recoveryWarning: string | null = null
  private modelRefreshInFlight = false
  private lastModelRefreshAt = 0
  private closingServers: Promise<void>[] = []
  private paused = false
  private catalog: AppState['catalog'] = []
  private timers: ReturnType<typeof setInterval>[] = []
  private listeners: Array<(state: AppState) => void> = []
  private quotaCache = new Map<string, QuotaSnapshot>()
  private scanState: AppState['scan'] = null
  private cacheWrite: Promise<void> = Promise.resolve()
  private configWrite: Promise<void> = Promise.resolve()
  private todayStats: TodayStats = emptyStats()
  private statsDay = ''
  private readonly now: () => Date
  private readonly fetchFn?: AppDeps['fetchFn']

  constructor(private readonly options: HubOptions) {
    this.now = options.now ?? (() => new Date())
    this.fetchFn = options.fetchFn
    this.runtime = new RuntimeStore(this.now)
    this.gate.onChange(() => this.scheduleGateEmit())
  }

  async init(): Promise<void> {
    this.config = await loadConfig(this.options.dataDir)
    this.secrets = await SecretStore.open(join(this.options.dataDir, 'secrets.bin'), this.options.cipher)
    this.logger = new Logger(join(this.options.dataDir, 'logs', 'app.log'))
    this.recoveryWarning = this.secrets.getRecoveryWarning()
    if (this.recoveryWarning) await this.logger.error(this.recoveryWarning)
    // 标志只镜像密钥存在性：secrets.bin 缺失/损坏时必须降级为禁用，
    // 否则界面显示“已启用”，而服务端读到 null Key 后实际不校验任何请求。
    if (this.config.settings.localKeyEnabled && !this.secrets.getLocalApiKey()) {
      this.config.settings.localKeyEnabled = false
      await this.persistConfig()
      await this.logger.warn('local api key disabled: localKeyEnabled was true but the secrets store has no key')
    }
    await this.loadQuotaCache()
    this.history = new HistoryStore(join(this.options.dataDir, 'history'), this.now)
    this.historySink = {
      append: async (record) => {
        this.accumulate(record)
        await this.history.append(record)
      }
    }
    await this.history.prune(this.config.settings.retentionDays)
    const today = this.history.today()
    this.todayStats = await this.history.statsFor(today)
    this.statsDay = today
    this.rebuildCatalog()
    // portOverride 只影响本次监听的端口，不写回配置，避免测试/冒烟端口被持久化。
    const listenPort = this.options.portOverride ?? this.config.settings.port
    try {
      this.server = await startServer(this.deps(), listenPort)
      this.serverError = null
    } catch (error) {
      // 端口被占用不是致命错误：应用照常起窗口，用户在设置页换端口后 updateSettings 会重新监听。
      this.server = null
      this.serverError = `端口 ${listenPort} 监听失败：${messageOf(error)}`
      await this.logger.error(this.serverError)
    }
    this.scheduler = new QuotaScheduler(
      this.runtime,
      () => this.config.providers,
      (id) => this.secrets.getProviderKey(id),
      () => this.schedulerUpdate(),
      this.now,
      this.fetchFn,
      (message) => void this.logger.warn(message)
    )
    this.scheduler.start(this.config.settings.quotaRefreshSec * 1000)
    this.timers.push(setInterval(() => void this.refreshStaleModels(), HOUR_MS))
    this.timers.push(setInterval(() => void this.pruneHistory(), DAY_MS))
    void this.refreshStaleModels()
    await this.logger.info(
      this.server ? `hub started on 127.0.0.1:${this.server.port}` : 'hub started without listener; waiting for a valid port'
    )
  }

  async shutdown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    if (this.gateEmitTimer) {
      clearTimeout(this.gateEmitTimer)
      this.gateEmitTimer = null
    }
    this.scheduler?.stop()
    const server = this.server
    this.server = null
    if (server) await server.close().catch(() => {})
    // 端口切换时旧服务是后台关闭的；退出前等它们收尾，避免残留监听。
    await Promise.allSettled(this.closingServers)
    this.closingServers = []
    await this.configWrite.catch(() => {})
    await this.cacheWrite.catch(() => {})
    if (this.logger) await this.logger.info('hub stopped')
  }

  getState(): AppState {
    return {
      settings: { ...this.config.settings },
      providers: this.config.providers.map((provider) => ({
        ...provider,
        models: {
          ...provider.models,
          cached: [...provider.models.cached],
          manual: [...provider.models.manual],
          hidden: provider.models.hidden ? [...provider.models.hidden] : [],
          scanHidden: provider.models.scanHidden ? [...provider.models.scanHidden] : [],
          shown: provider.models.shown ? [...provider.models.shown] : []
        },
        protocolSupport: provider.protocolSupport
          ? Object.fromEntries(
              Object.entries(provider.protocolSupport).map(([model, support]) => [model, { ...support }])
            )
          : undefined,
        modelMeta: provider.modelMeta ? structuredClone(provider.modelMeta) : undefined,
        modelDiscovery: provider.modelDiscovery ? structuredClone(provider.modelDiscovery) : undefined,
        endpointDiscovery: provider.endpointDiscovery ? structuredClone(provider.endpointDiscovery) : undefined,
        quota: { ...provider.quota },
        hasKey: this.secrets?.hasProviderKey(provider.id) ?? false
      })),
      runtime: this.config.providers.map((provider) => this.runtime.get(provider.id)),
      concurrency: this.config.providers.map((provider) => ({
        providerId: provider.id,
        active: this.gate.activeCount(provider.id),
        limit: providerConcurrencyLimit(provider)
      })),
      catalog: this.catalog,
      aliases: this.config.modelAliases.map((alias) => ({
        id: alias.id,
        targets: alias.targets.map((target) => ({ ...target }))
      })),
      server: { running: Boolean(this.server), port: this.server?.port ?? 0, paused: this.paused, error: this.serverError },
      stats: { ...this.todayStats },
      scan: this.scanState ? { ...this.scanState } : null,
      recoveryWarning: this.recoveryWarning
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    this.emit()
  }

  /** 本地模型的加载状态是唯一事实来源：models 为空时本地供应商立即退出路由。 */
  async syncLocalProvider(input: { baseUrl: string; models: string[]; meta?: Record<string, ModelMeta> }): Promise<void> {
    const baseUrl = input.baseUrl.replace(/\/+$/, '')
    const models = [...new Set(input.models)]
    const meta = input.meta && Object.keys(input.meta).length > 0 ? structuredClone(input.meta) : undefined
    let provider = this.config.providers.find((candidate) => candidate.id === 'local')
    if (!provider) {
      provider = createProviderFromPreset('local', 'local')
      provider.name = '本地模型'
      provider.enabled = true
      this.config.providers.push(provider)
    } else if (localProviderUnchanged(provider, baseUrl, models, meta)) {
      // 每次加载状态变化都会同步一次：内容没变就不写盘、不重建目录、不广播，避免刷新时间被无意义推进。
      return
    }
    provider.preset = 'local'
    provider.quotaAdapter = 'none'
    provider.maxConcurrency = 1
    provider.baseUrl = baseUrl
    provider.models.cached = models
    provider.models.manual = []
    provider.models.lastSyncedAt = this.now().toISOString()
    provider.modelDiscovery = meta
    await this.persistConfig()
    this.rebuildCatalog()
    this.emit()
  }

  async addProvider(input: ProviderInput): Promise<void> {
    // 本地供应商只能由 Hub 按本地服务状态创建；放进来会得到第二个无 Key、不可删、永不同步的本地供应商。
    if (input.preset === 'local') throw new Error('local provider is managed automatically')
    const name = input.name.trim()
    if (!name) throw new Error('provider name is required')
    const apiKey = input.apiKey.trim()
    if (!apiKey) throw new Error('apiKey is required')
    const baseUrl = validateBaseUrl(input.baseUrl)

    const provider = createProviderFromPreset(input.preset)
    provider.name = name
    provider.baseUrl = baseUrl
    provider.anthropicBaseUrl = validateOptionalBaseUrl(input.anthropicBaseUrl)
    if (input.quotaAdapter) provider.quotaAdapter = input.quotaAdapter
    if (input.quota) provider.quota = { ...provider.quota, ...input.quota }
    const maxConcurrency = validateMaxConcurrency(input.maxConcurrency)
    if (maxConcurrency !== undefined) provider.maxConcurrency = maxConcurrency
    if (input.manualModels) provider.models.manual = normalizeModels(input.manualModels)

    this.config.providers.push(provider)
    await this.secrets.setProviderKey(provider.id, apiKey)
    await this.persistConfig()
    this.rebuildCatalog()
    this.emit()

    // 发现失败不阻断保存：Key 已入库，供应商仍可用手动模型。
    await this.discoverProvider(provider)
    await this.persistConfig()
    this.rebuildCatalog()
    void this.refreshProviderQuota(provider.id)
    this.emit()
  }

  async updateProvider(id: string, patch: ProviderPatch): Promise<void> {
    const provider = this.requireProvider(id)
    // 本地供应商的地址/并发/模型/额度都由本地服务同步维护，手改会被下一次同步覆盖。
    if (
      provider.preset === 'local' &&
      (patch.baseUrl !== undefined ||
        patch.apiKey !== undefined ||
        patch.quotaAdapter !== undefined ||
        patch.manualModels !== undefined ||
        patch.maxConcurrency !== undefined)
    ) {
      throw new Error('local provider is managed automatically')
    }
    // 先完成全部校验再改字段：baseUrl 非法时不能留下半截改名。
    const nextName = patch.name === undefined ? undefined : patch.name.trim()
    if (nextName !== undefined && !nextName) throw new Error('provider name is required')
    const nextBaseUrl = patch.baseUrl === undefined ? undefined : validateBaseUrl(patch.baseUrl)
    const nextAnthropicBaseUrl = patch.anthropicBaseUrl === undefined ? undefined : validateOptionalBaseUrl(patch.anthropicBaseUrl)
    const nextMaxConcurrency = validateMaxConcurrency(patch.maxConcurrency)
    let discover = false
    if (nextName !== undefined) provider.name = nextName
    if (nextBaseUrl !== undefined) {
      if (nextBaseUrl !== provider.baseUrl) discover = true
      provider.baseUrl = nextBaseUrl
    }
    if (patch.anthropicBaseUrl !== undefined) provider.anthropicBaseUrl = nextAnthropicBaseUrl
    if (patch.apiKey !== undefined && patch.apiKey.trim()) {
      await this.secrets.setProviderKey(id, patch.apiKey.trim())
      // 旧 Key 导致的 auth_error 必须随新 Key 一起清除，否则只能等手动 reset。
      this.runtime.reset(id)
    }
    if (patch.quotaAdapter !== undefined) provider.quotaAdapter = patch.quotaAdapter
    if (patch.quota) provider.quota = { ...provider.quota, ...patch.quota }
    if (nextMaxConcurrency !== undefined) provider.maxConcurrency = nextMaxConcurrency
    if (patch.manualModels !== undefined) {
      provider.models.manual = normalizeModels(patch.manualModels)
      discover = true
    }
    if (patch.enabled !== undefined) provider.enabled = patch.enabled

    if (discover) await this.discoverProvider(provider)
    await this.persistConfig()
    this.rebuildCatalog()
    this.emit()
  }

  async deleteProvider(id: string): Promise<void> {
    const provider = this.requireProvider(id)
    // 本地供应商由 Hub 随加载状态自动增删，删掉会与本地服务状态脱节。
    if (provider.preset === 'local') throw new Error('local provider cannot be deleted')
    this.config.providers = this.config.providers.filter((provider) => provider.id !== id)
    this.config.modelAliases = this.config.modelAliases.map((alias) => ({
      ...alias,
      targets: alias.targets.filter((target) => target.providerId !== id)
    }))
    await this.secrets.removeProviderKey(id)
    this.runtime.remove(id)
    this.quotaCache.delete(id)
    this.rebuildCatalog()
    await this.persistConfig()
    this.emit()
  }

  async reorderProviders(ids: string[]): Promise<void> {
    const existing = new Set(this.config.providers.map((provider) => provider.id))
    const unique = new Set(ids)
    if (ids.length !== existing.size || unique.size !== ids.length || !ids.every((id) => existing.has(id))) {
      throw new Error('reorder ids must match the configured providers')
    }
    const byId = new Map(this.config.providers.map((provider) => [provider.id, provider]))
    this.config.providers = ids.map((id) => byId.get(id)!)
    await this.persistConfig()
    this.rebuildCatalog()
    this.emit()
  }

  async setProviderEnabled(id: string, enabled: boolean): Promise<void> {
    const provider = this.requireProvider(id)
    provider.enabled = enabled
    await this.persistConfig()
    this.rebuildCatalog()
    this.emit()
  }

  async saveModelAlias(alias: ModelAlias, previousId?: string): Promise<void> {
    const id = alias.id.trim()
    if (!id) throw new Error('model alias id is required')
    const previous = previousId?.trim() || null
    if (this.config.modelAliases.some((candidate) => candidate.id === id && candidate.id !== previous)) {
      throw new Error(`model alias already exists: ${id}`)
    }
    const providerIds = new Set(this.config.providers.map((provider) => provider.id))
    const targets = new Map<string, string>()
    for (const target of alias.targets) {
      const providerId = target.providerId.trim()
      const upstreamModel = target.upstreamModel.trim()
      if (!providerId || !upstreamModel) continue
      if (!providerIds.has(providerId)) throw new Error(`unknown provider for model alias: ${providerId}`)
      targets.set(providerId, upstreamModel)
    }
    if (targets.size === 0) throw new Error('model alias needs at least one provider target')
    const next = this.config.modelAliases.filter((candidate) => candidate.id !== previous && candidate.id !== id)
    next.push({
      id,
      targets: [...targets].map(([providerId, upstreamModel]) => ({ providerId, upstreamModel }))
    })
    this.config.modelAliases = next.sort((a, b) => a.id.localeCompare(b.id))
    await this.persistConfig()
    this.rebuildCatalog()
    this.emit()
  }

  // meta 为 null 时删除手动覆盖，回退内置建议；空字段不落盘，避免 config.json 堆积空对象。
  async saveModelMeta(providerId: string, upstreamModel: string, meta: ModelMeta | null): Promise<void> {
    const provider = this.requireProvider(providerId)
    const model = upstreamModel.trim()
    if (!model) throw new Error('model is required')
    if (meta === null) {
      if (!provider.modelMeta || !(model in provider.modelMeta)) return
      const next = { ...provider.modelMeta }
      delete next[model]
      provider.modelMeta = Object.keys(next).length > 0 ? next : undefined
    } else {
      const normalized = normalizeModelMeta(meta)
      if (!normalized) throw new Error('model meta is empty')
      provider.modelMeta = { ...(provider.modelMeta ?? {}), [model]: normalized }
    }
    await this.persistConfig()
    this.rebuildCatalog()
    this.emit()
  }

  // 展示层隐藏：不改 catalog、不重建路由，只影响模型页与 /v1/models。
  async setModelHidden(providerId: string, upstreamModel: string, hidden: boolean): Promise<void> {
    const provider = this.requireProvider(providerId)
    const model = upstreamModel.trim()
    if (!model) throw new Error('model is required')
    const next = new Set(provider.models.hidden ?? [])
    if (hidden) {
      next.add(model)
      // 手动隐藏优先于扫描自动隐藏的显式恢复记录。
      provider.models.shown = (provider.models.shown ?? []).filter((candidate) => candidate !== model)
    } else {
      next.delete(model)
      if ((provider.models.scanHidden ?? []).includes(model)) {
        provider.models.shown = [...new Set([...(provider.models.shown ?? []), model])].sort()
      }
    }
    provider.models.hidden = [...next].sort()
    await this.persistConfig()
    this.emit()
  }

  async deleteModelAlias(id: string): Promise<void> {
    if (!this.config.modelAliases.some((alias) => alias.id === id)) throw new Error(`unknown model alias: ${id}`)
    this.config.modelAliases = this.config.modelAliases.filter((alias) => alias.id !== id)
    await this.persistConfig()
    this.rebuildCatalog()
    this.emit()
  }

  async testProvider(input: ProviderInput, id?: string): Promise<TestResult> {
    let baseUrl: string
    try {
      baseUrl = validateBaseUrl(input.baseUrl)
    } catch (error) {
      return { models: [], quota: null, error: messageOf(error) }
    }
    const provider = createProviderFromPreset(input.preset, id ?? crypto.randomUUID())
    provider.name = input.name.trim() || provider.name
    provider.baseUrl = baseUrl
    if (input.quotaAdapter) provider.quotaAdapter = input.quotaAdapter
    if (input.quota) provider.quota = { ...provider.quota, ...input.quota }

    const apiKey = input.apiKey.trim() || (id ? this.secrets.getProviderKey(id) : null)
    if (!apiKey) return { models: [], quota: null, error: 'api key is required' }

    const errors: string[] = []
    let models: string[] = []
    try {
      models = (await discoverModels(provider.baseUrl, apiKey, this.fetchFn ?? fetch)).map((model) => model.id)
    } catch (error) {
      errors.push(`models: ${messageOf(error)}`)
    }
    let quota: QuotaSnapshot | null = null
    const adapter = this.adapterFor(provider)
    if (adapter) {
      try {
        quota = await adapter.probe(provider, apiKey, { fetchFn: this.fetchFn, now: this.now })
      } catch (error) {
        errors.push(`quota: ${messageOf(error)}`)
      }
    }
    const result: TestResult = { models, quota }
    if (errors.length > 0) result.error = errors.join('; ')
    return result
  }

  async refreshModels(id?: string): Promise<void> {
    const targets = id === undefined ? [...this.config.providers] : this.config.providers.filter((provider) => provider.id === id)
    if (id !== undefined && targets.length === 0) {
      await this.logger.error(`model refresh skipped: unknown provider ${id}`)
      return
    }
    for (const provider of targets) await this.discoverProvider(provider)
    await this.persistConfig()
    this.rebuildCatalog()
    this.emit()
  }

  async scanProviderProtocols(id: string): Promise<ProtocolScanResult> {
    const provider = this.requireProvider(id)
    // 本地供应商只有 OpenAI 形状且没有 Key，协议扫描没有意义。
    if (provider.preset === 'local') throw new Error('local provider has no protocol scan')
    if (this.scanState) throw new Error('a protocol scan is already running')
    const apiKey = this.secrets.getProviderKey(id)
    if (!apiKey) throw new Error('api key is required')
    // 旧配置没有入口声明时先补一次模型发现，让扫描只打上游实际提供的入口；失败按无声明继续。
    if (provider.preset === 'commandcode' && !provider.endpointDiscovery) {
      if (await this.discoverProvider(provider)) {
        await this.persistConfig()
        this.rebuildCatalog()
      }
    }
    const models = normalizeModels([...provider.models.cached, ...provider.models.manual])
    this.scanState = { providerId: provider.id, providerName: provider.name, done: 0, total: models.length }
    this.emit()
    let lastEmit = 0
    try {
      const outcome = await scanProviderProtocols({
        provider,
        apiKey,
        models,
        endpointSupport: provider.endpointDiscovery,
        fetchFn: this.fetchFn,
        now: this.now,
        onProgress: (done, total) => {
          if (!this.scanState) return
          this.scanState.done = done
          this.scanState.total = total
          const stamp = Date.now()
          if (done === total || stamp - lastEmit >= 200) {
            lastEmit = stamp
            this.emit()
          }
        }
      })
      if (outcome.rows.length > 0) {
        const support = { ...(provider.protocolSupport ?? {}) }
        for (const row of outcome.rows) {
          support[row.model] = { anthropic: row.anthropic, openai: row.openai, checkedAt: row.checkedAt }
        }
        provider.protocolSupport = support
        // 两端都明确不通才自动隐藏；任一入口恢复即自动显示；null（超时/限流）保持原状。
        const scanHidden = new Set(provider.models.scanHidden ?? [])
        for (const row of outcome.rows) {
          if (row.anthropic === false && row.openai === false) scanHidden.add(row.model)
          else if (row.anthropic === true || row.openai === true) scanHidden.delete(row.model)
        }
        provider.models.scanHidden = [...scanHidden].sort()
        provider.models.shown = (provider.models.shown ?? []).filter((model) => scanHidden.has(model))
        await this.persistConfig()
      }
      return {
        providerId: provider.id,
        providerName: provider.name,
        rows: outcome.rows,
        endpointSupport: provider.endpointDiscovery ? structuredClone(provider.endpointDiscovery) : undefined,
        error: outcome.error
      }
    } finally {
      this.scanState = null
      this.emit()
    }
  }

  async refreshQuotas(force = false): Promise<void> {
    if (!this.scheduler) return
    await this.scheduler.refreshAll(force)
    try {
      await this.syncQuotaCache()
    } catch (error) {
      await this.logger.error(`quota cache write failed: ${messageOf(error)}`)
    }
    this.emit()
  }

  async refreshProviderQuota(id: string): Promise<void> {
    const provider = this.config.providers.find((candidate) => candidate.id === id)
    if (!provider) {
      await this.logger.error(`quota refresh skipped: unknown provider ${id}`)
      return
    }
    if (provider.quotaAdapter === 'none' || !this.scheduler) return
    const apiKey = this.secrets.getProviderKey(id)
    if (!apiKey) return
    // 探针异常不得冒泡到 IPC：手动刷新只影响展示，不影响路由。
    try {
      await this.scheduler.refreshOne(provider, apiKey)
      await this.syncQuotaCache()
      this.emit()
    } catch (error) {
      await this.logger.error(`quota probe failed for ${id}: ${messageOf(error)}`)
    }
  }

  async resetProvider(id: string): Promise<void> {
    this.requireProvider(id)
    this.runtime.reset(id)
    this.scheduler?.resetBackoff(id)
    this.emit()
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    // localKeyEnabled 只由 setLocalKey 随密钥存在性维护；忽略补丁可避免标志与密钥脱节。
    const settingsPatch = { ...patch }
    delete settingsPatch.localKeyEnabled
    if (settingsPatch.port !== undefined && (!Number.isInteger(settingsPatch.port) || settingsPatch.port < 1 || settingsPatch.port > 65535)) {
      throw new Error('port must be an integer between 1 and 65535')
    }
    if (settingsPatch.quotaRefreshSec !== undefined && (!Number.isFinite(settingsPatch.quotaRefreshSec) || settingsPatch.quotaRefreshSec < 10)) {
      throw new Error('quotaRefreshSec must be at least 10 seconds')
    }
    const next: Settings = { ...this.config.settings, ...settingsPatch }
    const requestedPort = settingsPatch.port
    // 端口变化，或上次启动失败后用户重新提交端口：两条路径都要重新监听。
    const shouldListen = requestedPort !== undefined && (requestedPort !== this.config.settings.port || this.server === null)
    if (shouldListen) {
      // 先起新服务；失败时设置不变、旧服务继续可用（启动失败时则保持无服务状态并把错误抛给界面）。
      let server: Awaited<ReturnType<typeof startServer>>
      try {
        server = await startServer(this.deps(), requestedPort)
      } catch (error) {
        if (!this.server) {
          // 无服务可回退时把最新原因留在 AppState，概览页与设置页显示同一条信息。
          this.serverError = `端口 ${requestedPort} 监听失败：${messageOf(error)}`
          this.emit()
        }
        throw error
      }
      const old = this.server
      this.server = server
      this.serverError = null
      this.config.settings = next
      // 先落盘并广播，再后台关闭旧服务：一个进行中的 SSE 不能把设置保存与界面刷新卡住。
      await this.persistConfig()
      this.restartSchedulerIfNeeded(settingsPatch)
      await this.logger.info(`hub listening on 127.0.0.1:${server.port}`)
      this.emit()
      if (old) {
        this.closingServers.push(
          old.close().catch((error) => {
            this.logAsyncError('old server close failed', error)
          })
        )
      }
      return
    }
    this.config.settings = next
    await this.persistConfig()
    this.restartSchedulerIfNeeded(settingsPatch)
    this.emit()
  }

  async setLocalKey(key: string | null): Promise<void> {
    const normalized = key && key.trim() ? key.trim() : null
    await this.secrets.setLocalApiKey(normalized)
    this.config.settings.localKeyEnabled = normalized !== null
    await this.persistConfig()
    this.emit()
  }

  async getHistory(day: string, limit?: number): Promise<HistoryRecord[]> {
    if (!DAY_PATTERN.test(day)) throw new Error('day must be formatted as YYYY-MM-DD')
    return this.history.list(day, limit)
  }

  async getSpeedStats(day: string): Promise<ProviderSpeedStats[]> {
    if (!DAY_PATTERN.test(day)) throw new Error('day must be formatted as YYYY-MM-DD')
    return computeSpeedStats(await this.history.list(day, Number.MAX_SAFE_INTEGER))
  }

  async getUsageStats(): Promise<ProviderUsageStats[]> {
    const now = this.now()
    const retentionDays = this.config.settings.retentionDays
    const providers = this.config.providers.map((provider) => ({
      providerId: provider.id,
      windows: resolveUsageWindows(this.runtime.get(provider.id).quota, now, retentionDays)
    }))
    if (providers.length === 0) return []
    // 只读覆盖最早周期起点到今天的历史文件；聚合再按精确时间边界过滤。
    let earliestMs = now.getTime()
    for (const provider of providers) {
      for (const window of provider.windows) earliestMs = Math.min(earliestMs, Date.parse(window.start))
    }
    const records = await this.history.listRange(localDay(new Date(earliestMs)), localDay(now))
    return computeUsageStats(records, providers)
  }

  onStateChange(cb: (state: AppState) => void): void {
    this.listeners.push(cb)
  }

  private deps(): AppDeps {
    return {
      getConfig: () => this.config,
      getProviderKey: (id) => this.secrets.getProviderKey(id),
      getLocalApiKey: () => (this.config.settings.localKeyEnabled ? this.secrets.getLocalApiKey() : null),
      getCatalog: () => this.catalog,
      runtime: this.runtime,
      gate: this.gate,
      history: this.historySink,
      isPaused: () => this.paused,
      getPort: () => this.server?.port ?? 0,
      // 上游 404 与“本地完全不认识的模型名”共用同一次限流刷新，避免重复打满发现接口。
      onModelMissing: () => {
        this.requestModelRefresh()
      },
      onUnknownModel: () => {
        this.requestModelRefresh()
      },
      onQuotaFailure: (id) => {
        void this.refreshProviderQuota(id)
      },
      onDisableStreamUsage: (id) => {
        const provider = this.config.providers.find((candidate) => candidate.id === id)
        if (!provider || !provider.quota.injectStreamUsage) return
        provider.quota.injectStreamUsage = false
        void this.persistConfig().catch((error) => this.logAsyncError(`failed to persist stream usage setting for ${id}`, error))
      },
      now: this.now,
      fetchFn: this.fetchFn
    }
  }

  // 串行落盘 config.json：并发保存共用同一目标文件，后写者必须等前写者完成；
  // 入队时快照，防止后续内存变更渗入更早排队的写入。
  private persistConfig(): Promise<void> {
    const snapshot = structuredClone(this.config)
    const write = async (): Promise<void> => {
      await saveConfig(this.options.dataDir, snapshot)
    }
    const run = this.configWrite.then(write, write)
    this.configWrite = run.catch(() => {})
    return run
  }

  private rebuildCatalog(): void {
    this.catalog = buildCatalog(this.config.providers, this.config.modelAliases)
  }

  private requireProvider(id: string): ProviderConfig {
    const provider = this.config.providers.find((candidate) => candidate.id === id)
    if (!provider) throw new Error(`unknown provider: ${id}`)
    return provider
  }

  private adapterFor(provider: ProviderConfig): QuotaAdapter | null {
    if (provider.quotaAdapter === 'opencode-go') return opencodeGoAdapter
    if (provider.quotaAdapter === 'deepseek-balance') return deepseekBalanceAdapter
    if (provider.quotaAdapter === 'commandcode-usage') return commandCodeAdapter
    return null
  }

  private async discoverProvider(provider: ProviderConfig): Promise<boolean> {
    const apiKey = this.secrets.getProviderKey(provider.id)
    if (!apiKey) return false
    try {
      const models = await discoverModels(provider.baseUrl, apiKey, this.fetchFn ?? fetch)
      provider.models.cached = models.map((model) => model.id)
      // 发现值整体重写：上游不再返回元数据时同步清空，避免展示过时的能力。
      const discovered: Record<string, ModelMeta> = {}
      const endpoints: Record<string, ModelEndpointSupport> = {}
      for (const model of models) {
        if (model.meta) discovered[model.id] = model.meta
        if (model.endpoints) endpoints[model.id] = model.endpoints
      }
      provider.modelDiscovery = Object.keys(discovered).length > 0 ? discovered : undefined
      provider.endpointDiscovery = Object.keys(endpoints).length > 0 ? endpoints : undefined
      provider.models.lastSyncedAt = this.now().toISOString()
      return true
    } catch (error) {
      // 发现失败保留旧缓存，不影响已保存的供应商。
      await this.logger.error(`model discovery failed for ${provider.id}: ${messageOf(error)}`)
      return false
    }
  }

  // 未知/缺失模型触发的发现刷新：在途合并；距上次尝试不足 60s 也跳过。
  private requestModelRefresh(): void {
    if (this.config.providers.length === 0) return
    if (this.modelRefreshInFlight) return
    const now = this.now().getTime()
    if (now - this.lastModelRefreshAt < MODEL_REFRESH_THROTTLE_MS) return
    this.modelRefreshInFlight = true
    this.lastModelRefreshAt = now
    void this.refreshModels()
      .catch((error) => this.logAsyncError('model refresh failed', error))
      .finally(() => {
        this.modelRefreshInFlight = false
      })
  }

  private async refreshStaleModels(): Promise<void> {
    try {
      const cutoff = this.now().getTime() - MODEL_STALE_MS
      const stale = this.config.providers.filter((provider) => {
        // 本地供应商的模型列表由本地服务同步，不能走上游发现（也没有 Key 可发）。
        if (provider.preset === 'local') return false
        const syncedAt = provider.models.lastSyncedAt
        const at = syncedAt ? Date.parse(syncedAt) : Number.NaN
        return !Number.isFinite(at) || at < cutoff
      })
      if (stale.length === 0) return
      let changed = false
      for (const provider of stale) {
        if (await this.discoverProvider(provider)) changed = true
      }
      if (!changed) return
      await this.persistConfig()
      this.rebuildCatalog()
      this.emit()
    } catch (error) {
      await this.logger.error(`stale model refresh failed: ${messageOf(error)}`)
    }
  }

  private async pruneHistory(): Promise<void> {
    try {
      await this.history.prune(this.config.settings.retentionDays)
    } catch (error) {
      await this.logger.error(`history prune failed: ${messageOf(error)}`)
    }
  }

  private accumulate(record: HistoryRecord): void {
    const day = localDay(new Date(record.ts))
    if (day !== this.statsDay) {
      this.statsDay = day
      this.todayStats = emptyStats()
    }
    this.todayStats.requests += 1
    this.todayStats.promptTokens += record.promptTokens ?? 0
    this.todayStats.completionTokens += record.completionTokens ?? 0
    if (record.outcome === 'error') this.todayStats.failures += 1
    this.emit()
  }

  private async loadQuotaCache(): Promise<void> {
    try {
      const text = await readText(join(this.options.dataDir, QUOTA_CACHE_FILE))
      if (text === null) return
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const provider of this.config.providers) {
        const snapshot = (parsed as Record<string, unknown>)[provider.id]
        if (!isQuotaSnapshot(snapshot) || snapshot.providerId !== provider.id) continue
        // auth_error 不能回放：重启后继续不可路由会让供应商“凭空消失”，恢复入口应走手动 reset/换 Key。
        if (snapshot.availability === 'auth_error') continue
        this.quotaCache.set(provider.id, snapshot)
        this.runtime.markProbe(provider, snapshot)
      }
    } catch (error) {
      // 额度缓存只用于首屏展示，损坏时忽略即可，不能让应用起不来。
      await this.logger.error(`quota cache ignored: ${messageOf(error)}`)
    }
  }

  private syncQuotaCache(): Promise<void> {
    const snapshots: Record<string, QuotaSnapshot> = {}
    for (const provider of this.config.providers) {
      const snapshot = this.runtime.get(provider.id).quota
      if (!snapshot) continue
      this.quotaCache.set(provider.id, snapshot)
      snapshots[provider.id] = snapshot
    }
    const content = JSON.stringify(snapshots, null, 2)
    // 多次探针可能并发返回，串行落盘避免共用 tmp 文件互相覆盖。
    const write = async (): Promise<void> => {
      await writeFileAtomic(join(this.options.dataDir, QUOTA_CACHE_FILE), content)
    }
    this.cacheWrite = this.cacheWrite.then(write, write)
    return this.cacheWrite
  }

  private restartSchedulerIfNeeded(patch: Partial<Settings>): void {
    if (patch.quotaRefreshSec !== undefined && this.scheduler) {
      this.scheduler.start(this.config.settings.quotaRefreshSec * 1000)
    }
  }

  // 定时探针同样要写回 quota-cache，重启后才能显示最近一次额度而不只是添加时的快照。
  private schedulerUpdate(): void {
    this.emit()
    void this.syncQuotaCache().catch((error) => this.logAsyncError('quota cache write failed', error))
  }

  // 并发数每次请求起止都会变化：立即推动一次，随后 500ms 内合并，避免高频 IPC。
  private scheduleGateEmit(): void {
    if (this.gateEmitTimer) return
    const elapsed = Date.now() - this.gateEmitAt
    if (elapsed >= 500) {
      this.gateEmitAt = Date.now()
      this.emit()
      return
    }
    this.gateEmitTimer = setTimeout(() => {
      this.gateEmitTimer = null
      this.gateEmitAt = Date.now()
      this.emit()
    }, 500 - elapsed)
  }

  private emit(): void {
    const state = this.getState()
    try {
      this.options.onStateChange?.(state)
    } catch {
      // 推送失败不影响主流程。
    }
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch {
        // 订阅方异常不能中断 Hub。
      }
    }
  }

  private logAsyncError(message: string, error: unknown): void {
    void this.logger.error(`${message}: ${messageOf(error)}`)
  }
}
