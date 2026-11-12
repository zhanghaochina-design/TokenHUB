import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, Server } from 'lucide-react'
import type { AppState, ProviderRuntime, ProviderUsageStats, UsageWindow } from '../../core/types'
import { UsageBarChart } from '../components/UsageBarChart'
import { Toast } from '../components/Toast'
import {
  errorMessage,
  formatCountdown,
  formatDateTime,
  formatNumber,
  formatTokenCount,
  providerStatus,
  type StatusTone
} from '../lib/format'

interface UsagePageProps {
  state: AppState
}

type ProviderWithKey = AppState['providers'][number]

const DOT_TONE: Record<StatusTone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  muted: 'bg-neutral-400'
}

const WINDOW_LABELS: Record<UsageWindow['key'], string> = {
  rolling: '5 小时',
  weekly: '1 周',
  monthly: '1 个月'
}

function WindowRow({
  window,
  resetsAt,
  now,
  maxTotal
}: {
  window: UsageWindow
  resetsAt: string | null
  now: number
  maxTotal: number
}) {
  const countdown = window.aligned ? formatCountdown(resetsAt, now) : null
  // 没有 token 上限可依，细条按本供应商最大周期定标，只表达三周期之间的相对量级。
  const ratio = maxTotal > 0 ? Math.min(100, (window.totalTokens / maxTotal) * 100) : 0
  const inputShare = window.totalTokens > 0 ? (window.promptTokens / window.totalTokens) * 100 : 0
  const percent = Math.round(ratio * 10) / 10
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        <span className="inline-flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink">
          {WINDOW_LABELS[window.key]}
          <span className="inline-flex items-center rounded border border-line bg-neutral-100 px-1 py-0.5 text-[10px] font-medium text-neutral-600">
            {window.aligned ? '套餐周期' : '滚动'}
          </span>
          {window.partial && (
            <span
              className="rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20"
              title="历史保留天数不足以覆盖整个周期"
            >
              数据不足
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs font-semibold tabular-nums text-ink" title={`${formatNumber(window.totalTokens)} token`}>
          {formatTokenCount(window.totalTokens)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${WINDOW_LABELS[window.key]} token 用量，相对本供应商最大周期 ${percent}%`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-meter-track"
      >
        <div
          className="flex h-full overflow-hidden rounded-full"
          style={{ width: `${ratio}%`, minWidth: window.totalTokens > 0 ? 2 : undefined }}
        >
          <span className="h-full bg-meter-soft" style={{ width: `${inputShare}%` }} />
          <span className="h-full flex-1 bg-meter-primary" />
        </div>
      </div>
      <p className="mt-1 text-[11px] text-muted" title={`统计自 ${formatDateTime(window.start)}`}>
        输入 {formatTokenCount(window.promptTokens)} · 输出 {formatTokenCount(window.completionTokens)}
        {window.aligned && countdown && countdown !== '—' && ` · 重置${countdown === '已到期' ? '已到期' : `剩 ${countdown}`}`}
      </p>
    </li>
  )
}

function UsageCard({
  provider,
  runtime,
  stats,
  now
}: {
  provider: ProviderWithKey
  runtime: ProviderRuntime | undefined
  stats: ProviderUsageStats | undefined
  now: number
}) {
  const status = providerStatus(provider, runtime, now)
  const windows = stats?.windows ?? []
  const maxTotal = Math.max(0, ...windows.map((window) => window.totalTokens))
  return (
    <li className="rounded-lg border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${DOT_TONE[status.tone]}`} aria-hidden="true" />
        <h3 className="truncate text-sm font-semibold text-ink" title={provider.name}>
          {provider.name}
        </h3>
        {!provider.enabled && (
          <span className="shrink-0 rounded-md border border-line bg-neutral-100 px-1.5 py-0.5 text-[11px] text-muted">已禁用</span>
        )}
      </div>

      {windows.length > 0 ? (
        <>
          <UsageBarChart windows={windows} className="mx-auto mt-3 w-full max-w-[320px]" />
          <ul className="mt-4 grid list-none gap-3.5 p-0">
            {windows.map((window) => (
              <WindowRow
                key={window.key}
                window={window}
                resetsAt={runtime?.quota?.windows?.[window.key]?.resetsAt ?? null}
                now={now}
                maxTotal={maxTotal}
              />
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-3 text-xs text-muted">暂无用量数据。</p>
      )}
    </li>
  )
}

export function UsagePage({ state }: UsagePageProps) {
  const [usage, setUsage] = useState<ProviderUsageStats[]>([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [toast, setToast] = useState<string | null>(null)

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await window.tokenhub.getUsageStats())
    } catch (error) {
      setToast(`加载用量统计失败：${errorMessage(error)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadUsage()
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void loadUsage()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [loadUsage])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const runtimeById = useMemo(() => new Map(state.runtime.map((runtime) => [runtime.providerId, runtime])), [state.runtime])
  const usageByProvider = useMemo(() => new Map(usage.map((item) => [item.providerId, item])), [usage])
  const anyPartial = usage.some((item) => item.windows.some((window) => window.partial))

  return (
    <div className="mx-auto w-full max-w-[1200px] p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">用量统计</h1>
        <p className="mt-1 text-sm text-muted">
          各供应商 5 小时 / 周 / 月的累计 token（输入 + 输出）。OpenCode Go 与 CommandCode 按套餐周期对齐，DeepSeek 等按最近 5 小时 / 7 天 / 30 天滚动。
        </p>
      </header>

      {anyPartial && (
        <div role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          历史保留 {state.settings.retentionDays} 天，标注「数据不足」的周期未覆盖完整时长；可在设置页调高保留天数。
        </div>
      )}

      <section aria-labelledby="usage-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="usage-heading" className="text-base font-semibold text-ink">
            供应商用量
          </h2>
          <p className="text-xs text-muted">
            每 30 秒刷新 · {state.settings.retentionDays === 0 ? '历史永久保留' : `历史保留 ${state.settings.retentionDays} 天`}
          </p>
        </div>

        {state.providers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-surface px-6 py-12 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-canvas text-muted">
              <Server className="size-5" aria-hidden="true" />
            </span>
            <h3 className="mt-4 text-base font-semibold text-ink">还没有供应商</h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">添加供应商后，这里会按周期统计累计 token 用量。</p>
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-8 text-sm text-muted" role="status">
            <BarChart3 className="size-4 animate-pulse text-accent" aria-hidden="true" />
            正在统计用量…
          </div>
        ) : (
          <ul aria-label="供应商用量" className="grid list-none gap-4 p-0 lg:grid-cols-2">
            {state.providers.map((provider) => (
              <UsageCard
                key={provider.id}
                provider={provider}
                runtime={runtimeById.get(provider.id)}
                stats={usageByProvider.get(provider.id)}
                now={now}
              />
            ))}
          </ul>
        )}
      </section>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  )
}