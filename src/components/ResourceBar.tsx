interface ResourceBarProps {
  label: string
  percent: number
  detail: string
  // 容量型按 70% / 90% 切警示色；利用率高不等于异常，固定主色。
  tone?: 'capacity' | 'utilization'
}

function fillClass(percent: number, tone: 'capacity' | 'utilization'): string {
  if (tone === 'utilization') return 'bg-meter-primary'
  if (percent >= 90) return 'bg-meter-danger'
  if (percent >= 70) return 'bg-meter-warn'
  return 'bg-meter-primary'
}

export function ResourceBar({ label, percent, detail, tone = 'capacity' }: ResourceBarProps) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0))
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-ink">{label}</span>
        <span className="tabular-nums text-muted">{detail}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-meter-track"
      >
        <div className={`h-full rounded-full ${fillClass(clamped, tone)}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  )
}