import type { QuotaAdapter, ProbeFetchFn, ProbeOptions } from './types'
import type { ProviderConfig, QuotaSnapshot, QuotaWindow } from '../types'

const DEFAULT_API_BASE = 'https://api.commandcode.ai'

// 控制台同款内部接口，按月套餐 ID 前缀给出月上限（美元 credits）；未识别的套餐按月上限 $70 估算，余额更高时以余额定标。
const PLAN_CAPS: Array<{ prefix: string; name: string; monthlyCap: number }> = [
  { prefix: 'individual-goat', name: 'GOAT', monthlyCap: 70 },
  { prefix: 'individual-pro-v1', name: 'Pro', monthlyCap: 80 },
  { prefix: 'individual-provider', name: 'Provider', monthlyCap: 15 },
  { prefix: 'individual-ultra', name: 'Ultra', monthlyCap: 300 },
  { prefix: 'individual-max', name: 'Max', monthlyCap: 150 },
  { prefix: 'individual-pro', name: 'Pro', monthlyCap: 30 },
  { prefix: 'individual-go', name: 'Go', monthlyCap: 10 },
  { prefix: 'teams-pro', name: 'Teams Pro', monthlyCap: 40 }
]

interface JsonResult {
  status: number
  json: Record<string, unknown>
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function pick(source: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) if (name in source) return source[name]
  return null
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function boolish(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  return false
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function epochIso(value: unknown): string | null {
  const asNumber = num(value)
  if (asNumber !== null) return new Date(asNumber < 100_000_000_000 ? asNumber * 1000 : asNumber).toISOString()
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
  }
  return null
}

function apiBaseOf(provider: ProviderConfig): string {
  try {
    return new URL(provider.baseUrl).origin
  } catch {
    return DEFAULT_API_BASE
  }
}

async function getJson(fetchFn: ProbeFetchFn, url: string, apiKey: string): Promise<JsonResult> {
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  })
  if (res.status === 401) return { status: 401, json: {} }
  if (!res.ok) throw new Error(`${new URL(url).pathname} ${res.status}`)
  const json = await res.json().catch(() => null)
  const record = obj(json)
  if (Object.keys(record).length === 0) throw new Error(`${new URL(url).pathname} invalid json`)
  return { status: res.status, json: record }
}

function firstObject(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const record = obj(value)
    if (Object.keys(record).length > 0) return record
    if (Array.isArray(value) && value.length > 0) {
      const nested = obj(value[0])
      if (Object.keys(nested).length > 0) return nested
    }
  }
  return {}
}

/** 已用比例窗口：used/cap 由服务端给出，重置时间可能缺失。 */
function toWindow(raw: unknown): QuotaWindow | undefined {
  const source = obj(raw)
  if (Object.keys(source).length === 0) return undefined
  const used = num(pick(source, ['used', 'usage', 'usedCredits', 'used_credits']))
  const cap = num(pick(source, ['cap', 'limit', 'capCredits', 'cap_credits']))
  if (used === null || cap === null || cap <= 0) return undefined
  const percent = Math.min(100, Math.max(0, (used / cap) * 100))
  const exceeded = boolish(pick(source, ['exceeded', 'isExceeded', 'is_exceeded'])) || used >= cap
  return {
    percent,
    status: exceeded ? 'rate-limited' : 'ok',
    resetsAt: epochIso(pick(source, ['resetAt', 'reset_at', 'resetsAt', 'resets_at']))
  }
}

export const commandCodeAdapter: QuotaAdapter = {
  id: 'commandcode-usage',
  async probe(provider: ProviderConfig, apiKey: string, options: ProbeOptions = {}): Promise<QuotaSnapshot> {
    const now = options.now ?? (() => new Date())
    const fetchFn: ProbeFetchFn = options.fetchFn ?? ((url, init) => fetch(url, init))
    const base = apiBaseOf(provider)
    const fetchedAt = now().toISOString()

    const creditsResult = await getJson(fetchFn, `${base}/alpha/billing/credits`, apiKey)
    if (creditsResult.status === 401) {
      return { providerId: provider.id, availability: 'auth_error', source: 'probe', fetchedAt, note: 'billing 401' }
    }
    const root = creditsResult.json
    const data = Object.keys(obj(root.data)).length > 0 ? obj(root.data) : root
    const credits = obj(data.credits)
    const limits = Object.keys(obj(data.windowLimits)).length > 0 ? obj(data.windowLimits) : obj(data.window_limits)

    // whoami/订阅只用于 orgId 与账期结束时间，失败不应让额度主数据作废。
    let orgId = ''
    try {
      const whoami = await getJson(fetchFn, `${base}/alpha/whoami`, apiKey)
      if (whoami.status !== 401) orgId = text(obj(whoami.json.org).id)
    } catch {
      // 订阅信息缺失时月窗口仍可显示百分比，只缺重置时间。
    }
    let subscription: Record<string, unknown> = {}
    if (orgId) {
      try {
        const url = `${base}/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`
        const sub = await getJson(fetchFn, url, apiKey)
        if (sub.status !== 401) subscription = firstObject(sub.json.data, sub.json.subscription, sub.json)
      } catch {
        // 同上：订阅接口不可用不影响 credits 口径。
      }
    }

    const planId = text(pick(subscription, ['planId', 'plan_id'])) || text(pick(credits, ['planId', 'plan_id']))
    const normalizedPlan = planId.toLowerCase().replace(/_/g, '-')
    const plan = PLAN_CAPS.find((candidate) => normalizedPlan.startsWith(candidate.prefix))
    const limited = limits.limited === undefined ? true : boolish(limits.limited)
    const periodEnd = epochIso(pick(subscription, ['currentPeriodEnd', 'current_period_end']))
    const monthlyRemaining = num(pick(credits, ['monthlyCredits', 'monthly_credits']))

    const windows: NonNullable<QuotaSnapshot['windows']> = {}
    if (limited) {
      windows.rolling = toWindow(pick(limits, ['fiveHour', 'five_hour', 'rolling5h', '5h']))
      windows.weekly = toWindow(pick(limits, ['weekly', 'week']))
    }
    if (monthlyRemaining !== null) {
      // 未识别套餐时按月上限 $70 估算；余额高于上限（加购/赠送）时用余额本身定标，避免出现负用量。
      const cap = Math.max(plan?.monthlyCap ?? 70, monthlyRemaining)
      const used = Math.max(0, cap - monthlyRemaining)
      windows.monthly = {
        percent: (used / cap) * 100,
        status: used >= cap ? 'rate-limited' : 'ok',
        resetsAt: periodEnd
      }
    }

    const present = [windows.rolling, windows.weekly, windows.monthly].filter((window): window is QuotaWindow => Boolean(window))
    if (present.length === 0) throw new Error('billing payload has no recognizable windows')

    const limitedWindow = text(pick(limits, ['exceeded']))
    const exhausted = Boolean(limitedWindow) || present.some((window) => window.percent >= 100 || window.status === 'rate-limited')

    const note: string[] = []
    if (plan) note.push(`${plan.name} 套餐`)
    else if (planId) note.push(`${planId} 套餐`)
    if (!limited) note.push('当前套餐不受 5 小时/周窗口限制')
    if (boolish(pick(credits, ['belowThreshold', 'below_threshold']))) note.push('剩余额度低于预警阈值')

    return {
      providerId: provider.id,
      availability: exhausted ? 'exhausted' : 'ok',
      windows,
      ...(monthlyRemaining !== null ? { balance: { amount: monthlyRemaining, currency: 'USD' } } : {}),
      source: 'probe',
      fetchedAt,
      ...(note.length > 0 ? { note: note.join(' · ') } : {})
    }
  }
}
