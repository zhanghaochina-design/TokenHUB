export type Preset = 'opencode-go' | 'commandcode' | 'deepseek' | 'custom'
export type QuotaAdapterId = 'opencode-go' | 'deepseek-balance' | 'none'
export type Availability = 'ok' | 'exhausted' | 'rate_limited' | 'auth_error' | 'unknown'
export type ErrorKind = 'quota' | 'rate_limit' | 'auth' | 'transient' | 'model_missing' | 'request' | 'unknown'

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
  quota: ProviderQuotaConfig
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
  quota: QuotaSnapshot | null
  probeFailures: number
  probeDisabled: boolean
}

export interface MergedModel {
  id: string
  providers: string[]
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
  // error 只在启动监听失败时非空：界面据此提示“服务未启动”并引导改端口。
  server: { running: boolean; port: number; paused: boolean; error?: string | null }
  stats: TodayStats
  // 密钥库损坏被隔离时的提示；不含任何密钥内容。
  recoveryWarning?: string | null
}
