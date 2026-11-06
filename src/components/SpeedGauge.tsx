import { useId } from 'react'
import type { ProviderSpeedStats } from '../../core/types'

interface SpeedGaugeProps {
  stats: ProviderSpeedStats | undefined
  className?: string
}

const GAUGE_MAX = 300
const CENTER_X = 110
const CENTER_Y = 112
const FACE_RADIUS = 88
const TRACK_RADIUS = 76
const NEEDLE_RADIUS = 62
const MAJOR_TICKS = [0, 50, 100, 150, 200, 250, 300]
const LABELS = [0, 100, 200, 300]

const SPEED_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })

function formatSpeed(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return SPEED_FORMAT.format(value)
}

function clampRatio(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(1, value / GAUGE_MAX)
}

function pointAt(radius: number, ratio: number): { x: number; y: number } {
  const angle = Math.PI + ratio * Math.PI
  return { x: CENTER_X + Math.cos(angle) * radius, y: CENTER_Y + Math.sin(angle) * radius }
}

function arcPath(ratio: number): string {
  if (ratio <= 0) return ''
  const start = pointAt(TRACK_RADIUS, 0)
  const end = pointAt(TRACK_RADIUS, ratio)
  return `M ${start.x} ${start.y} A ${TRACK_RADIUS} ${TRACK_RADIUS} 0 0 1 ${end.x} ${end.y}`
}

/** 汽车仪表风格的生成速度表：指针为最新一次，绿色弧线为今日加权平均。 */
export function SpeedGauge({ stats, className = '' }: SpeedGaugeProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const latest = stats?.latestTps ?? null
  const average = stats?.averageTps ?? null
  const samples = stats?.samples ?? 0
  const latestRatio = clampRatio(latest)
  const averageRatio = clampRatio(average)
  const needleAngle = -90 + latestRatio * 180
  const averagePoint = pointAt(TRACK_RADIUS, averageRatio)
  const label =
    latest === null
      ? 'Token 速度：暂无成功请求'
      : `Token 速度：最新 ${formatSpeed(latest)} t/s，今日平均 ${formatSpeed(average)} t/s，${samples} 条样本`

  return (
    <div
      role="img"
      aria-label={label}
      className={`rounded-xl bg-neutral-950 p-3 text-neutral-100 shadow-inner ring-1 ring-inset ring-white/10 ${className}`}
    >
      <svg viewBox="0 0 220 124" className="block w-full" aria-hidden="true">
        <defs>
          <radialGradient id={`${uid}-face`} cx="50%" cy="100%" r="100%">
            <stop offset="0%" stopColor="#27272a" />
            <stop offset="100%" stopColor="#09090b" />
          </radialGradient>
          <linearGradient id={`${uid}-track`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#3f3f46" />
            <stop offset="100%" stopColor="#52525b" />
          </linearGradient>
        </defs>

        <path
          d={`M ${CENTER_X - FACE_RADIUS} ${CENTER_Y} A ${FACE_RADIUS} ${FACE_RADIUS} 0 0 1 ${CENTER_X + FACE_RADIUS} ${CENTER_Y} Z`}
          fill={`url(#${uid}-face)`}
          stroke="#3f3f46"
          strokeWidth="1"
        />

        <path
          d={`M ${CENTER_X - TRACK_RADIUS} ${CENTER_Y} A ${TRACK_RADIUS} ${TRACK_RADIUS} 0 0 1 ${CENTER_X + TRACK_RADIUS} ${CENTER_Y}`}
          fill="none"
          stroke={`url(#${uid}-track)`}
          strokeWidth="14"
          strokeLinecap="round"
        />

        {average !== null && (
          <>
            <path d={arcPath(averageRatio)} fill="none" stroke="#34d399" strokeWidth="4" strokeLinecap="round" />
            <circle cx={averagePoint.x} cy={averagePoint.y} r="3.5" fill="#34d399" stroke="#09090b" strokeWidth="1.5" />
          </>
        )}

        {MAJOR_TICKS.map((tick) => {
          const ratio = tick / GAUGE_MAX
          const inner = pointAt(tick % 100 === 0 ? 64 : 69, ratio)
          const outer = pointAt(TRACK_RADIUS, ratio)
          return (
            <line
              key={tick}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke={tick % 100 === 0 ? '#d4d4d8' : '#71717a'}
              strokeWidth={tick % 100 === 0 ? 1.8 : 1}
              strokeLinecap="round"
            />
          )
        })}

        {LABELS.map((tick) => {
          const point = pointAt(52, tick / GAUGE_MAX)
          return (
            <text
              key={tick}
              x={point.x}
              y={point.y}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="#a1a1aa"
              fontSize="8"
              fontWeight="500"
            >
              {tick}
            </text>
          )
        })}

        <g transform={`rotate(${needleAngle} ${CENTER_X} ${CENTER_Y})`}>
          <line
            x1={CENTER_X}
            y1={CENTER_Y}
            x2={CENTER_X}
            y2={CENTER_Y - NEEDLE_RADIUS}
            stroke="#fbbf24"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </g>
        <circle cx={CENTER_X} cy={CENTER_Y} r="5.5" fill="#fbbf24" stroke="#09090b" strokeWidth="2" />
        <circle cx={CENTER_X} cy={CENTER_Y} r="1.8" fill="#09090b" />
      </svg>

      <div className="mt-1 flex items-end justify-between gap-3">
        <div className="min-w-0" title="最近一次流式成功请求的生成速度">
          <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">最新</p>
          <p className="mt-0.5 truncate text-xl font-semibold leading-none tabular-nums text-white">
            {formatSpeed(latest)} <span className="text-[10px] font-normal text-neutral-400">t/s</span>
          </p>
        </div>
        <div className="min-w-0 text-right" title="今日所有流式成功请求：总输出 token ÷ 总生成耗时">
          <p className="text-[10px] text-neutral-500">今日平均</p>
          <p className="mt-0.5 truncate text-sm font-medium leading-none tabular-nums text-emerald-300">
            {formatSpeed(average)} <span className="text-[10px] font-normal text-neutral-400">t/s</span>
          </p>
          <p className="mt-1 text-[10px] text-neutral-500">{samples > 0 ? `${samples} 条样本` : '暂无成功请求'}</p>
        </div>
      </div>
    </div>
  )
}
