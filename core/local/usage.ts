import { freemem, totalmem } from 'node:os'
import type { CommandRunner } from './hardware'
import type { SystemUsage } from './types'

// 系统资源采样的间隔：与首页额度的探针节奏错开，资源占用需要比额度更实时。
export const USAGE_SAMPLE_MS = 5000
const USAGE_TIMEOUT_MS = 10_000

// 使用语言无关的 CIM 类：类名与属性名不随 Windows 语言变化，中文系统同样可用。
// 只取 Name 与数值列，避免把整个性能对象序列化进 JSON。
export const USAGE_QUERY_SCRIPT = [
  '$eng = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue | Select-Object Name, UtilizationPercentage)',
  '$mem = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction SilentlyContinue | Select-Object Name, DedicatedUsage)',
  '[pscustomobject]@{ engines = $eng; memory = $mem } | ConvertTo-Json -Depth 4 -Compress'
].join('; ')

interface RawEngine {
  Name?: unknown
  UtilizationPercentage?: unknown
}

interface RawMemory {
  Name?: unknown
  DedicatedUsage?: unknown
}

interface RawReport {
  engines?: RawEngine[] | RawEngine
  memory?: RawMemory[] | RawMemory
}

export interface UsageInputs {
  ramTotalBytes: number
  ramFreeBytes: number
  vramTotalBytes: number | null
  now: () => Date
}

// 实例名形如 pid_11468_luid_0x00000000_0x09281676_phys_0_eng_0_engtype_3D；
// 同一张卡的所有进程共享 luid，显存与引擎占用按 luid 聚合。
const LUID_PATTERN = /luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)/i
const ENGINE_PATTERN = /_eng_(\d+)/i

function asArray<T>(value: T[] | T | null | undefined): T[] {
  if (Array.isArray(value)) return value
  return value ? [value] : []
}

function luidOf(name: string): string | null {
  const match = LUID_PATTERN.exec(name)
  return match ? `${match[1].toLowerCase()}_${match[2].toLowerCase()}` : null
}

function countOf(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function percentOf(raw: unknown): number {
  return Math.min(100, countOf(raw))
}

/**
 * 整机口径：system RAM 已用/总量；显存取「占用显存最多」的适配器（通常就是正在跑模型的独显），
 * GPU 使用率取该适配器最忙引擎的占比（同引擎多进程求和，再取各引擎最大值，避免多引擎重复累加）。
 * 适配器没有名称可读，LUID 也无法和 WMI 显卡名直接对应，因此用「当前占用最大」作为选择依据。
 */
export function parseUsageReport(rawJson: string, input: UsageInputs): SystemUsage {
  const parsed = JSON.parse(rawJson.replace(/^\uFEFF/, '').trim() || '{}') as RawReport

  const vramByLuid = new Map<string, number>()
  for (const item of asArray(parsed.memory)) {
    const name = typeof item.Name === 'string' ? item.Name : ''
    const luid = luidOf(name)
    if (!luid) continue
    vramByLuid.set(luid, (vramByLuid.get(luid) ?? 0) + countOf(item.DedicatedUsage))
  }

  // luid -> 引擎序号 -> 该引擎上所有进程的合计占比
  const enginesByLuid = new Map<string, Map<number, number>>()
  for (const item of asArray(parsed.engines)) {
    const name = typeof item.Name === 'string' ? item.Name : ''
    const luid = luidOf(name)
    if (!luid) continue
    const index = Number(ENGINE_PATTERN.exec(name)?.[1] ?? 0)
    const engines = enginesByLuid.get(luid) ?? new Map<number, number>()
    engines.set(index, Math.min(100, (engines.get(index) ?? 0) + percentOf(item.UtilizationPercentage)))
    enginesByLuid.set(luid, engines)
  }

  const busiestPercent = (luid: string | null): number => {
    if (!luid) return 0
    let max = 0
    for (const percent of enginesByLuid.get(luid)?.values() ?? []) max = Math.max(max, percent)
    return Math.round(max)
  }

  let adapter: string | null = null
  let adapterVram = -1
  for (const [luid, used] of vramByLuid) {
    if (used > adapterVram) {
      adapterVram = used
      adapter = luid
    }
  }
  // 没有显存计数器时退化为最忙的适配器，至少 GPU 使用率仍可用。
  if (!adapter) {
    let busiest = -1
    for (const luid of enginesByLuid.keys()) {
      const percent = busiestPercent(luid)
      if (percent > busiest) {
        busiest = percent
        adapter = luid
      }
    }
  }

  const ramTotal = countOf(input.ramTotalBytes)
  return {
    sampledAt: input.now().toISOString(),
    ramUsedBytes: Math.max(0, ramTotal - Math.min(countOf(input.ramFreeBytes), ramTotal)),
    ramTotalBytes: ramTotal,
    vramUsedBytes: adapter ? (vramByLuid.get(adapter) ?? 0) : 0,
    vramTotalBytes: input.vramTotalBytes,
    gpuPercent: busiestPercent(adapter)
  }
}

/** 采集失败（进程/计数器不可用、PowerShell 超时）返回 null，由调用方保留上一次读数。 */
export async function sampleSystemUsage(input: {
  run: CommandRunner
  vramTotalBytes: number | null
  now?: () => Date
}): Promise<SystemUsage | null> {
  try {
    const raw = await input.run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', USAGE_QUERY_SCRIPT],
      USAGE_TIMEOUT_MS
    )
    return parseUsageReport(raw, {
      ramTotalBytes: totalmem(),
      ramFreeBytes: freemem(),
      vramTotalBytes: input.vramTotalBytes,
      now: input.now ?? (() => new Date())
    })
  } catch {
    return null
  }
}