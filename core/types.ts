export type Preset = 'opencode-go' | 'commandcode' | 'deepseek' | 'custom'
export type QuotaAdapterId = 'opencode-go' | 'deepseek-balance' | 'commandcode-usage' | 'none'
export type Availability = 'ok' | 'exhausted' | 'rate_limited' | 'auth_error' | 'unknown'
export type ErrorKind = 'quota' | 'rate_limit' | 'auth' | 'transient' | 'model_missing' | 'request' | 'unknown'
export type Protocol = 'openai' | 'anthropic'

// 扫描得到的入口兼容性：true=可用，false=明确不支持，null=本次无法判定（超时/限流/5xx）。
export interface ModelProtocolSupport {
  anthropic: boolean | null
  openai: boolean | null
  checkedAt: string
}

// 上游 /models 声明的入口能力（CommandCode 的 supported_endpoints）；只描述协议形状，不表示套餐/地区可用。
export interface ModelEndpointSupport {
  anthropic: boolean
  openai: boolean
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
  // 扫描时上游声明的入口能力；探测为 null 的格子据此展示，不把权限/地区拒绝显示成未知。
  endpointSupport?: Record<string, ModelEndpointSupport>
  error?: string
}

// 上游模型的思考参数：沿用原生参数名与取值，网关只展示、不换算。
export interface ModelThinkingMeta {
  // 原生参数名，如 reasoning_effort、thinking.budget_tokens；'none' 表示无参数化思考。
  param: string
  values: string[]
}

// 手动覆盖只保存显式字段：缺省回退内置建议，null 表示明确未知/不支持。
export interface ModelMeta {
  contextLength?: number | null
  vision?: boolean | null
  thinking?: ModelThinkingMeta | null
}

export interface EffectiveModelMeta {
  contextLength: number | null
  vision: boolean | null
  thinking: ModelThinkingMeta | null
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
  // Anthropic messages 专用 base（含版本路径）；缺省时按预设推导，DeepSeek 官方为 /anthropic/v1。
  anthropicBaseUrl?: string
  quotaAdapter: QuotaAdapterId
  enabled: boolean
  // 同时发往该上游的最大请求数；0 表示不限。槽位持有到响应体结束，满员时路由按优先级转下一家。
  maxConcurrency?: number
  // hidden/scanHidden/shown 只影响模型页与 /v1/models 的展示，不改变路由与故障切换。
  // 生效隐藏 = (hidden ∪ scanHidden) − shown；shown 记录用户对自动隐藏的显式恢复。
  models: {
    cached: string[]
    manual: string[]
    hidden?: string[]
    scanHidden?: string[]
    shown?: string[]
    lastSyncedAt: string | null
  }
  // 键为上游模型 ID；缺失表示尚未扫描，路由回退到预设默认。
  protocolSupport?: Record<string, ModelProtocolSupport>
  // 键为上游模型 ID；每次刷新模型时按上游 /models 的 supported_endpoints 重写。
  // 扫描结果为 null（超时/限流/权限拒绝）时用它兜底，避免把套餐/地区限制误判成协议不支持。
  endpointDiscovery?: Record<string, ModelEndpointSupport>
  // 键为上游模型 ID；只存手动覆盖，未命中时回退发现值、再回退内置建议表。
  modelMeta?: Record<string, ModelMeta>
  // 键为上游模型 ID；每次刷新模型时按上游 /models 响应重写，清空即表示上游未提供。
  modelDiscovery?: Record<string, ModelMeta>
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
  // 各目标的能力聚合：上下文取最小值、视觉任一支持、思考按同一参数名取交集。
  meta: EffectiveModelMeta
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

// 当前在途请求数：从进入网关到响应体结束；limit=0 表示不限并发。
export interface ProviderConcurrency {
  providerId: string
  active: number
  limit: number
}

export interface ProviderSpeedStats {
  providerId: string
  latestTps: number | null
  latestAt: string | null
  averageTps: number | null
  samples: number
}

export interface TodayStats {
  requests: number
  promptTokens: number
  completionTokens: number
  failures: number
}

export type UsageWindowKey = 'rolling' | 'weekly' | 'monthly'

// 统计周期边界：start/end 为 ISO 时间，end 取现在；aligned 表示按探针重置时间对齐而非滚动回退。
export interface UsageWindowBound {
  key: UsageWindowKey
  start: string
  end: string
  aligned: boolean
  // 历史保留天数不足以覆盖整个周期时为 true，前端据此标注“数据不足”。
  partial: boolean
}

export interface UsageWindow extends UsageWindowBound {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  requests: number
}

export interface ProviderUsageStats {
  providerId: string
  windows: UsageWindow[]
}

export interface AppState {
  settings: Settings
  providers: Array<ProviderConfig & { hasKey: boolean }>
  runtime: ProviderRuntime[]
  concurrency: ProviderConcurrency[]
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
