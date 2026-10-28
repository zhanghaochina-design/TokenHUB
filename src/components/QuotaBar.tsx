import { formatCountdown } from '../lib/format'

interface QuotaBarProps {
  label: string
  percent: number
  resetsAt: string | null
  // 由父级 30 秒 tick 传入，保证多个进度条的倒计时口径一致。
  now?: number
}

function barTone(percent: number): string {
  if (percent >= 90) return 'bg-red-500'
  if (percent >= 70) return 'bg-amber-500'
  return 'bg-emerald-500'
}

export function QuotaBar({ label, percent, resetsAt, now = Date.now() }: QuotaBarProps) {
  const raw = Number.isFinite(percent) ? percent : 0
  const clamped = Math.min(100, Math.max(0, raw))
  const rounded = Math.round(clamped)
  const countdown = formatCountdown(resetsAt, now)

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-ink">{label}</span>
        <span className="tabular-nums text-muted">已用 {rounded}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-100"
      >
        <div className={`h-full rounded-full ${barTone(clamped)}`} style={{ width: `${clamped}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-muted">
        {resetsAt === null ? '重置时间未知' : countdown === '已到期' ? '已到重置时间，等待额度刷新' : `重置倒计时 ${countdown}`}
      </p>
    </div>
  )
}
