import type { SystemUsage } from '../../../core/local/types'
import { ResourceBar } from '../ResourceBar'

const GB = 1024 ** 3

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`
}

function percentOf(used: number, total: number | null): number {
  return total && total > 0 ? (used / total) * 100 : 0
}

export function LocalUsageBars({ usage }: { usage: SystemUsage | null }) {
  return (
    <div className="mt-3 space-y-3">
      <ResourceBar
        label="内存占用"
        percent={usage ? percentOf(usage.ramUsedBytes, usage.ramTotalBytes) : 0}
        detail={usage ? `${gb(usage.ramUsedBytes)} / ${gb(usage.ramTotalBytes)}` : '读取中…'}
      />
      <ResourceBar
        label="显存占用"
        percent={usage ? percentOf(usage.vramUsedBytes, usage.vramTotalBytes) : 0}
        detail={
          usage
            ? usage.vramTotalBytes
              ? `${gb(usage.vramUsedBytes)} / ${gb(usage.vramTotalBytes)}`
              : `${gb(usage.vramUsedBytes)}（总量未知）`
            : '读取中…'
        }
      />
      <ResourceBar
        label="GPU 使用率"
        percent={usage?.gpuPercent ?? 0}
        detail={usage ? `${Math.round(usage.gpuPercent)}%` : '读取中…'}
        tone="utilization"
      />
      <p className="text-[11px] text-muted">整机资源占用 · 每 5 秒刷新</p>
    </div>
  )
}