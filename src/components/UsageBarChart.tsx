import { useId } from 'react'
import type { UsageWindow } from '../../core/types'
import { formatNumber, formatTokenCount } from '../lib/format'

interface UsageBarChartProps {
  windows: UsageWindow[]
  className?: string
}

const WINDOW_LABELS: Record<UsageWindow['key'], string> = {
  rolling: '5 小时',
  weekly: '1 周',
  monthly: '1 个月'
}

const WIDTH = 260
const HEIGHT = 168
const BASELINE_Y = 128
const CHART_HEIGHT = 96
const BAR_WIDTH = 44
const INPUT_FILL = '#a7f3d0'
const OUTPUT_FILL = '#10b981'

function centerX(index: number): number {
  return 48 + index * 82
}

/** 三周期堆叠柱：每根柱是一个周期的累计 token，下浅=输入、上深=输出，按卡片自身最大值定标。 */
export function UsageBarChart({ windows, className = '' }: UsageBarChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const maxTotal = Math.max(1, ...windows.map((w) => w.totalTokens))
  const summary = windows
    .map((w) => `${WINDOW_LABELS[w.key]} ${formatNumber(w.totalTokens)}（输入 ${formatNumber(w.promptTokens)} · 输出 ${formatNumber(w.completionTokens)}）`)
    .join('，')

  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm" style={{ background: INPUT_FILL }} aria-hidden="true" />
          输入
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm" style={{ background: OUTPUT_FILL }} aria-hidden="true" />
          输出
        </span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="block w-full" role="img" aria-label={`周期累计 token：${summary}`}>
        <defs>
          <linearGradient id={`${uid}-output`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>

        <line x1="16" y1={BASELINE_Y} x2={WIDTH - 16} y2={BASELINE_Y} stroke="var(--color-line)" strokeWidth="1" />

        {windows.map((window, index) => {
          const cx = centerX(index)
          const x = cx - BAR_WIDTH / 2
          const inputH = (window.promptTokens / maxTotal) * CHART_HEIGHT
          const outputH = (window.completionTokens / maxTotal) * CHART_HEIGHT
          const inputY = BASELINE_Y - inputH
          const outputY = inputY - outputH
          const label = WINDOW_LABELS[window.key]
          const tooltip = `${label}：总 ${formatNumber(window.totalTokens)} token（输入 ${formatNumber(window.promptTokens)} · 输出 ${formatNumber(window.completionTokens)}），${formatNumber(window.requests)} 次成功请求`
          return (
            <g key={window.key}>
              <title>{tooltip}</title>
              {window.totalTokens > 0 ? (
                <>
                  <rect x={x} y={inputY} width={BAR_WIDTH} height={inputH} fill={INPUT_FILL} />
                  <rect x={x} y={outputY} width={BAR_WIDTH} height={outputH} fill={`url(#${uid}-output)`} rx="2" />
                </>
              ) : (
                <rect x={x} y={BASELINE_Y - 2} width={BAR_WIDTH} height="2" fill="var(--color-line)" />
              )}
              <text x={cx} y={Math.max(outputY - 6, 14)} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--color-ink)" className="tabular-nums">
                {formatTokenCount(window.totalTokens)}
              </text>
              <text x={cx} y={148} textAnchor="middle" fontSize="11" fill="var(--color-muted)">
                {label}
              </text>
              <text x={cx} y={162} textAnchor="middle" fontSize="10" fill="var(--color-muted)" className="tabular-nums">
                {formatNumber(window.requests)} 次
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}