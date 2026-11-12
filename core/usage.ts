import type { HistoryRecord, ProviderUsageStats, QuotaSnapshot, UsageWindowBound, UsageWindowKey } from './types'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// 三个统计周期的时长；月周期按 30 天近似（探针只给重置时间，不给账期长度）。
const WINDOW_DEFS: Array<{ key: UsageWindowKey; durationMs: number }> = [
  { key: 'rolling', durationMs: 5 * HOUR_MS },
  { key: 'weekly', durationMs: 7 * DAY_MS },
  { key: 'monthly', durationMs: 30 * DAY_MS }
]

/**
 * 解析每个供应商的统计周期边界。OpenCode Go/CommandCode 的额度窗口带重置时间时，
 * 用「重置时间 − 周期时长」反推当前计费周期起点；重置时间缺失/已过期、DeepSeek 余额快照
 * 及无探针供应商一律回退到「最近 5 小时/7 天/30 天」滚动窗口。
 */
export function resolveUsageWindows(quota: QuotaSnapshot | null, now: Date, retentionDays: number): UsageWindowBound[] {
  const nowMs = now.getTime()
  const end = now.toISOString()
  const cutoffMs = retentionDays > 0 ? nowMs - retentionDays * DAY_MS : Number.NEGATIVE_INFINITY
  return WINDOW_DEFS.map(({ key, durationMs }) => {
    const resetsAt = quota?.windows?.[key]?.resetsAt
    const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN
    const aligned = Number.isFinite(resetMs) && resetMs > nowMs
    // 对齐起点不会晚于现在（账期长于 30 天时夹到现在，避免负长度窗口）。
    const startMs = aligned ? Math.min(resetMs - durationMs, nowMs) : nowMs - durationMs
    return { key, start: new Date(startMs).toISOString(), end, aligned, partial: startMs < cutoffMs }
  })
}

/** 按周期边界聚合各供应商成功请求的输入/输出 token；边界含起点、含终点。 */
export function computeUsageStats(
  records: HistoryRecord[],
  providers: Array<{ providerId: string; windows: UsageWindowBound[] }>
): ProviderUsageStats[] {
  return providers.map(({ providerId, windows }) => ({
    providerId,
    windows: windows.map((bound) => {
      let promptTokens = 0
      let completionTokens = 0
      let requests = 0
      for (const record of records) {
        if (record.providerId !== providerId || record.outcome !== 'ok') continue
        if (record.ts < bound.start || record.ts > bound.end) continue
        promptTokens += record.promptTokens ?? 0
        completionTokens += record.completionTokens ?? 0
        requests += 1
      }
      return { ...bound, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, requests }
    })
  }))
}