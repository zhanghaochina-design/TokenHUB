export type Preset = 'opencode-go' | 'commandcode' | 'deepseek' | 'custom'
export type QuotaAdapterId = 'opencode-go' | 'deepseek-balance' | 'none'
export type Availability = 'ok' | 'exhausted' | 'rate_limited' | 'auth_error' | 'unknown'
export type ErrorKind = 'quota' | 'rate_limit' | 'auth' | 'transient' | 'model_missing' | 'request' | 'unknown'
export type Protocol = 'openai' | 'anthropic'

// 扫描得到的入口兼容性：true=可用，false=明确不支持，null=本次无法判定（超时/限流/5xx）。
export interface ModelProtocolSupport {
  anthropic: boolean | null
  openai: boolean | null
  checkedAt: string
}

export interface ProtocolScanRow {
  model: string
  anthropic: boolean | null
  openai: boolean | null
  checkedAt: string
  note?: string
}

export interface ProtocolScanResult {
  providerId: string
  providerName: string
  rows: ProtocolScanRow[]
  error?: string
}

export interface ProviderQuotaConfig {
  lowBalanceThreshold: number
  quotaCooldownMs: number
  injectStreamUsage: boolean
}

export interface ProviderConfig {
  id: string
  name: string
  preset: Preset
  baseUrl: string
  quotaAdapter: QuotaAdapterId
  enabled: boolean
  models: { cached: string[]; manual: string[]; lastSyncedAt: string | null }
  // 键为上游模型 ID；缺失表示尚未扫描，路由回退到预设默认。
  protocolSupport?: Record<string, ModelProtocolSupport>
  quota: ProviderQuotaConfig
}

export interface ModelAliasTarget {
  providerId: string
  upstreamModel: string
}

// 本地统一模型 ID（canonical）到各供应商真实模型 ID 的映射；不自动合并，只按用户确认的映射路由。
export interface ModelAlias {
  id: string
  targets: ModelAliasTarget[]
}

export interface Settings {
  port: number
  localKeyEnabled: boolean
  autoStart: boolean
  startMinimized: boolean
  closeToTray: boolean
  retentionDays: number
  quotaRefreshSec: number
}

export interface AppConfig {
  version: 1
  providers: ProviderConfig[]
  modelAliases: ModelAlias[]
  settings: Settings
}

export interface QuotaWindow {
  percent: number
  status: string
  resetsAt: string | null
}

export interface QuotaSnapshot {
  providerId: string
  availability: Availability
  windows?: { rolling?: QuotaWindow; weekly?: QuotaWindow; monthly?: QuotaWindow }
  balance?: { amount: number; currency: string }
  source: 'probe' | 'error' | 'manual' | 'initial'
  fetchedAt: string
  note?: string
}

export interface ProviderRuntime {
  providerId: string
  availability: Availability
  cooldownUntil: string | null
  lastErrorKind: ErrorKind | null
  consecutiveFailures: number
  // 连续瞬时故障数，仅用于指数退避；客户端中断不计入。
  transientFailures: number
  quota: QuotaSnapshot | null
  probeFailures: number
  probeDisabled: boolean
}

export interface MergedModelTarget {
  providerId: string
  upstreamModel: string
  source: 'exact' | 'alias'
}

export interface MergedModel {
  id: string
  providers: string[]
  targets: MergedModelTarget[]
  // 由 modelAliases 显式定义（或包含隐式同名 target）时为 true，用于 UI 徽标。
  isAlias?: boolean
}

export interface UpstreamFailure {
  kind: ErrorKind
  status: number | null
  message: string
  retryAfterMs: number | null
}

export interface HistoryRecord {
  ts: string
  requestId: string
  protocol: 'openai' | 'anthropic'
  model: string
  providerId: string | null
  upstreamModel: string | null
  stream: boolean
  httpStatus: number
  outcome: 'ok' | 'error'
  promptTokens: number | null
  completionTokens: number | null
  latencyMs: number
  firstByteMs: number | null
  errorKind: ErrorKind | null
  failoverFrom?: string[]
}

export interface HistorySink {
  append(record: HistoryRecord): Promise<void>
}

export interface TodayStats {
  requests: number
  promptTokens: number
  completionTokens: number
  failures: number
}

export interface AppState {
  settings: Settings
  providers: Array<ProviderConfig & { hasKey: boolean }>
  runtime: ProviderRuntime[]
  catalog: MergedModel[]
  aliases: ModelAlias[]
  // error 只在启动监听失败时非空：界面据此提示“服务未启动”并引导改端口。
  server: { running: boolean; port: number; paused: boolean; error?: string | null }
  stats: TodayStats
  // 兼容性扫描进行中的进度；扫描结束后为空。
  scan?: { providerId: string; providerName: string; done: number; total: number } | null
  // 密钥库损坏被隔离时的提示；不含任何密钥内容。
  recoveryWarning?: string | null
}
