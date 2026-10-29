import type { Availability, ErrorKind, ProviderConfig, ProviderRuntime, QuotaSnapshot } from '../../core/types'

export type StatusTone = 'ok' | 'warn' | 'error' | 'muted'

export interface ProviderStatus {
  label: string
  tone: StatusTone
  detail?: string
}

const AVAILABILITY_LABELS: Record<Availability, string> = {
  ok: '正常',
  exhausted: '额度耗尽',
  rate_limited: '限流中',
  auth_error: '鉴权失败',
  unknown: '未知'
}

const AVAILABILITY_TONES: Record<Availability, StatusTone> = {
  ok: 'ok',
  exhausted: 'error',
  rate_limited: 'warn',
  auth_error: 'error',
  unknown: 'muted'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function providerModelCount(provider: ProviderConfig): number {
  return new Set([...provider.models.cached, ...provider.models.manual]).size
}

// 冷却优先于可用性展示：两者同时存在时，用户更关心暂时不可路由的原因。
export function providerStatus(
  provider: Pick<ProviderConfig, 'enabled'>,
  runtime: ProviderRuntime | undefined,
  now: number
): ProviderStatus {
  if (!provider.enabled) return { label: '已禁用', tone: 'muted' }
  if (!runtime) return { label: '未知', tone: 'muted' }
  const cooldownUntil = runtime.cooldownUntil ? Date.parse(runtime.cooldownUntil) : Number.NaN
  if (Number.isFinite(cooldownUntil) && cooldownUntil > now) {
    return { label: '冷却中', tone: 'warn', detail: `冷却至 ${formatDateTime(runtime.cooldownUntil!)}` }
  }
  return { label: AVAILABILITY_LABELS[runtime.availability], tone: AVAILABILITY_TONES[runtime.availability] }
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const NUMBER_FORMAT = new Intl.NumberFormat('zh-CN')

export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value)
}

// 历史文件按本地日命名（与 HistoryStore.dayKey 一致），不能用 UTC 的 toISOString 切片。
export function localDayKey(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

// 倒计时按显示精度截断：超过一天省略分钟，超过一小时省略秒。
export function formatCountdown(target: string | null, now: number): string {
  if (!target) return '—'
  const at = Date.parse(target)
  if (!Number.isFinite(at)) return '—'
  const remaining = at - now
  if (remaining <= 0) return '已到期'
  const totalSeconds = Math.ceil(remaining / 1000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

const ERROR_KIND_LABELS: Record<ErrorKind, string> = {
  quota: '额度耗尽',
  rate_limit: '限流',
  auth: '鉴权失败',
  transient: '上游异常',
  model_missing: '模型不存在',
  request: '请求错误',
  unknown: '未知错误'
}

export function errorKindLabel(kind: ErrorKind | null): string {
  return kind ? ERROR_KIND_LABELS[kind] : '—'
}

// 秒级精度无意义，保留两位小数并去掉多余的 0。
export function quotaHours(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0'
  return Number((ms / 3_600_000).toFixed(2)).toString()
}

const WINDOW_LABELS = { rolling: '滚动窗口', weekly: '周窗口', monthly: '月窗口' } as const

export function describeQuota(snapshot: QuotaSnapshot | null): string {
  if (!snapshot) return ''
  const parts: string[] = []
  if (snapshot.balance) {
    const amount = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(snapshot.balance.amount)
    parts.push(`余额 ${amount} ${snapshot.balance.currency}`)
  }
  for (const key of ['rolling', 'weekly', 'monthly'] as const) {
    const window = snapshot.windows?.[key]
    if (window) parts.push(`${WINDOW_LABELS[key]} ${Math.round(window.percent)}%`)
  }
  if (parts.length === 0) return snapshot.note ?? ''
  return parts.join(' · ')
}

export function splitModels(raw: string): string[] {
  const models = new Set<string>()
  for (const item of raw.split(/[,，\n]/)) {
    const model = item.trim()
    if (model) models.add(model)
  }
  return [...models]
}
