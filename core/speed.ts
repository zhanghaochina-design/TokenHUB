import type { HistoryRecord, ProviderSpeedStats } from './types'

// 极短生成或异常高值多为测量噪声，避免仪表被单条脏数据拉爆。
const MIN_GENERATION_MS = 100
const MAX_VALID_TPS = 1000

interface MeasuredSpeed {
  tps: number
  tokens: number
  generationMs: number
}

function measure(record: HistoryRecord): MeasuredSpeed | null {
  if (record.outcome !== 'ok' || !record.stream || !record.providerId) return null
  if (record.completionTokens === null || record.completionTokens <= 0) return null
  if (record.firstByteMs === null) return null
  const generationMs = record.latencyMs - record.firstByteMs
  if (!Number.isFinite(generationMs) || generationMs < MIN_GENERATION_MS) return null
  const tps = (record.completionTokens / generationMs) * 1000
  if (!Number.isFinite(tps) || tps > MAX_VALID_TPS) return null
  return { tps, tokens: record.completionTokens, generationMs }
}

/** 今日各供应商的流式生成速度；按总输出 token / 总生成耗时加权，避免短请求拉偏平均。 */
export function computeSpeedStats(records: HistoryRecord[]): ProviderSpeedStats[] {
  const groups = new Map<
    string,
    { latestAt: string; latestTps: number; tokens: number; generationMs: number; samples: number }
  >()

  for (const record of records) {
    const measured = measure(record)
    if (!measured || !record.providerId) continue
    const group = groups.get(record.providerId) ?? {
      latestAt: '',
      latestTps: 0,
      tokens: 0,
      generationMs: 0,
      samples: 0
    }
    group.tokens += measured.tokens
    group.generationMs += measured.generationMs
    group.samples += 1
    if (record.ts > group.latestAt) {
      group.latestAt = record.ts
      group.latestTps = measured.tps
    }
    groups.set(record.providerId, group)
  }

  return [...groups.entries()]
    .map(([providerId, group]) => ({
      providerId,
      latestTps: group.latestTps,
      latestAt: group.latestAt,
      averageTps: group.generationMs > 0 ? (group.tokens / group.generationMs) * 1000 : null,
      samples: group.samples
    }))
    .sort((a, b) => a.providerId.localeCompare(b.providerId))
}
