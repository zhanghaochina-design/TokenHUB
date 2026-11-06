import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pause, Play, RotateCcw, Server } from 'lucide-react'
import type { AppState, HistoryRecord, ProviderRuntime, ProviderSpeedStats, QuotaWindow } from '../../core/types'
import { HistoryTable } from '../components/HistoryTable'
import { QuotaBar } from '../components/QuotaBar'
import { SpeedGauge } from '../components/SpeedGauge'
import { Toast } from '../components/Toast'
import {
  errorKindLabel,
  errorMessage,
  formatCountdown,
  formatDateTime,
  formatNumber,
  formatRefreshInterval,
  localDayKey,
  providerStatus,
  type StatusTone
} from '../lib/format'

type ProviderWithKey = AppState['providers'][number]

interface OverviewPageProps {
  state: AppState
  onOpenProviders: () => void
  onOpenSettings?: () => void
}

const DOT_TONE: Record<StatusTone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  muted: 'bg-neutral-400'
}

const TEXT_TONE: Record<StatusTone, string> = {
  ok: 'text-emerald-700',
  warn: 'text-amber-800',
  error: 'text-red-700',
  muted: 'text-muted'
}

const BALANCE_FORMAT = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const WINDOW_LABELS: Array<{ key: 'rolling' | 'weekly' | 'monthly'; label: string }> = [
  { key: 'rolling', label: '滚动窗口' },
  { key: 'weekly', label: '周窗口' },
  { key: 'monthly', label: '月窗口' }
]

function cooldownRemaining(runtime: ProviderRuntime | undefined, now: number): string | null {
  if (!runtime?.cooldownUntil) return null
  const until = Date.parse(runtime.cooldownUntil)
  if (!Number.isFinite(until) || until <= now) return null
  return formatCountdown(runtime.cooldownUntil, now)
}

function QuotaWindows({ windows, now }: { windows: Partial<Record<'rolling' | 'weekly' | 'monthly', QuotaWindow>>; now: number }) {
  const present = WINDOW_LABELS.filter(({ key }) => windows[key])
  if (present.length === 0) return null
  return (
    <div className="mt-3 space-y-3">
      {present.map(({ key, label }) => {
        const window = windows[key]!
        return <QuotaBar key={key} label={label} percent={window.percent} resetsAt={window.resetsAt} now={now} />
      })}
    </div>
  )
}

function ProviderQuota({ provider, runtime, now }: { provider: ProviderWithKey; runtime: ProviderRuntime | undefined; now: number }) {
  const snapshot = runtime?.quota ?? null
  const note = snapshot?.note ? <p className="mt-2 text-[11px] text-muted">探针备注：{snapshot.note}</p> : null

  if (provider.quotaAdapter === 'opencode-go') {
    const windows = snapshot?.windows ?? {}
    const hasWindows = Boolean(windows.rolling || windows.weekly || windows.monthly)
    return (
      <>
        {hasWindows ? (
          <QuotaWindows windows={windows} now={now} />
        ) : (
          <p className="mt-3 text-xs text-muted">暂无额度窗口数据，等待探针首次刷新。</p>
        )}
        {note}
      </>
    )
  }

  if (provider.quotaAdapter === 'commandcode-usage') {
    const windows = snapshot?.windows ?? {}
    const hasWindows = Boolean(windows.rolling || windows.weekly || windows.monthly)
    return (
      <>
        {hasWindows ? (
          <QuotaWindows windows={windows} now={now} />
        ) : (
          <p className="mt-3 text-xs text-muted">暂无额度窗口数据，等待探针首次刷新。</p>
        )}
        {snapshot?.balance ? (
          <p className="mt-2 text-[11px] text-muted">
            本月剩余 {BALANCE_FORMAT.format(snapshot.balance.amount)} {snapshot.balance.currency}
          </p>
        ) : null}
        {note}
      </>
    )
  }

  if (provider.quotaAdapter === 'deepseek-balance') {
    return (
      <>
        {snapshot?.balance ? (
          <div className="mt-3">
            <p className="text-xs text-muted">账户余额</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-ink">
              {BALANCE_FORMAT.format(snapshot.balance.amount)}{' '}
              <span className="text-xs font-medium text-muted">{snapshot.balance.currency}</span>
            </p>
            <p className="mt-1 text-[11px] text-muted">
              低于阈值 {BALANCE_FORMAT.format(provider.quota.lowBalanceThreshold)} 时视为额度耗尽。
            </p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted">暂无余额数据，等待探针首次刷新。</p>
        )}
        {note}
      </>
    )
  }

  return <p className="mt-3 text-xs text-muted">未配置额度查询；额度耗尽或限流后按错误码进入冷却。</p>
}

function ProviderCard({
  provider,
  runtime,
  speed,
  index,
  now,
  resetting,
  onReset
}: {
  provider: ProviderWithKey
  runtime: ProviderRuntime | undefined
  speed: ProviderSpeedStats | undefined
  index: number
  now: number
  resetting: boolean
  onReset: (id: string) => void
}) {
  const status = providerStatus(provider, runtime, now)
  const cooldown = cooldownRemaining(runtime, now)

  return (
    <li className="rounded-lg border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-label={`优先级 ${index + 1}`}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-[11px] font-semibold tabular-nums text-neutral-600"
            >
              {index + 1}
            </span>
            <span className={`size-2 shrink-0 rounded-full ${DOT_TONE[status.tone]}`} aria-hidden="true" />
            <h3 className="truncate text-sm font-semibold text-ink" title={provider.name}>
              {provider.name}
            </h3>
            {!provider.enabled && (
              <span className="shrink-0 rounded-md border border-line bg-neutral-100 px-1.5 py-0.5 text-[11px] text-muted">
                已禁用
              </span>
            )}
          </div>
          <p className="mt-1 text-xs">
            <span className={`font-medium ${TEXT_TONE[status.tone]}`}>{status.label}</span>
            {!provider.hasKey && <span className="text-red-600"> · 未配置 Key</span>}
          </p>
        </div>
        <button
          type="button"
          aria-label={`恢复 ${provider.name}`}
          onClick={() => onReset(provider.id)}
          disabled={resetting}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-ink transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {resetting ? '恢复中…' : '恢复'}
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <ProviderQuota provider={provider} runtime={runtime} now={now} />
        </div>
        <SpeedGauge
          stats={speed}
          className="order-first w-[170px] max-w-full shrink-0 self-center sm:order-none sm:mt-3 sm:self-start min-[1100px]:w-[190px]"
        />
      </div>

      {runtime?.quota?.fetchedAt && (
        <p className="mt-2 text-[11px] text-muted">额度更新于 {formatDateTime(runtime.quota.fetchedAt)}</p>
      )}

      {cooldown && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-600/20">
          <span>
            冷却中
            {runtime?.lastErrorKind ? `（${errorKindLabel(runtime.lastErrorKind)}）` : ''}
          </span>
          <span className="tabular-nums">剩余 {cooldown}</span>
        </div>
      )}

      {runtime && runtime.probeFailures > 0 && (
        <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-600/20">
          额度探针连续失败 {runtime.probeFailures} 次，已自动退避重试；路由仍按错误码工作。
        </div>
      )}
    </li>
  )
}

export function OverviewPage({ state, onOpenProviders, onOpenSettings }: OverviewPageProps) {
  const [history, setHistory] = useState<HistoryRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [speedStats, setSpeedStats] = useState<ProviderSpeedStats[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [toast, setToast] = useState<string | null>(null)
  const [resettingId, setResettingId] = useState<string | null>(null)
  const [pausing, setPausing] = useState(false)

  const loadHistory = useCallback(async () => {
    try {
      // 历史文件按本地日命名；每轮重新取日键，跨午夜后自动切到新一天。
      const rows = await window.tokenhub.getHistory(localDayKey(), 50)
      setHistory(rows)
    } catch (error) {
      setToast(`加载历史失败：${errorMessage(error)}`)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const loadSpeedStats = useCallback(async () => {
    try {
      setSpeedStats(await window.tokenhub.getSpeedStats(localDayKey()))
    } catch {
      // 瞬时读取失败时保留上一次读数，避免仪表闪回空表。
    }
  }, [])

  useEffect(() => {
    void loadHistory()
    void loadSpeedStats()
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void loadHistory()
      void loadSpeedStats()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [loadHistory, loadSpeedStats])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const runtimeById = useMemo(
    () => new Map(state.runtime.map((runtime) => [runtime.providerId, runtime])),
    [state.runtime]
  )

  const speedByProvider = useMemo(
    () => new Map(speedStats.map((item) => [item.providerId, item])),
    [speedStats]
  )

  const stats = state.stats
  const totalTokens = stats.promptTokens + stats.completionTokens
  const successRate = stats.requests === 0 ? null : Math.round(((stats.requests - stats.failures) / stats.requests) * 100)
  const listenUrl = state.server.running ? `http://127.0.0.1:${state.server.port}` : '服务未运行'
  const serverLabel = !state.server.running ? '未运行' : state.server.paused ? '已暂停' : '运行中'
  const serverTone: StatusTone = !state.server.running ? 'error' : state.server.paused ? 'warn' : 'ok'

  async function handleTogglePaused() {
    setPausing(true)
    try {
      await window.tokenhub.setPaused(!state.server.paused)
    } catch (error) {
      setToast(`切换暂停状态失败：${errorMessage(error)}`)
    } finally {
      setPausing(false)
    }
  }

  async function handleReset(id: string) {
    setResettingId(id)
    try {
      await window.tokenhub.resetProvider(id)
    } catch (error) {
      setToast(`恢复供应商失败：${errorMessage(error)}`)
    } finally {
      setResettingId(null)
    }
  }

  const statCells: Array<{ label: string; value: string; title?: string }> = [
    { label: '监听地址', value: listenUrl, title: listenUrl },
    {
      label: '运行状态',
      value: serverLabel,
      title: !state.server.running
        ? (state.server.error ?? undefined)
        : state.server.paused
          ? '路由已暂停，/v1 请求返回 503'
          : undefined
    },
    { label: '今日请求', value: formatNumber(stats.requests) },
    { label: '今日 Token', value: formatNumber(totalTokens), title: `输入 ${formatNumber(stats.promptTokens)} · 输出 ${formatNumber(stats.completionTokens)}` },
    { label: '今日失败', value: formatNumber(stats.failures) },
    {
      label: '成功率',
      value: successRate === null ? '—' : `${successRate}%`,
      title: successRate === null ? '今日暂无请求' : `成功 ${stats.requests - stats.failures} / 共 ${stats.requests}`
    }
  ]

  return (
    <div className="mx-auto w-full max-w-[1200px] p-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">概览</h1>
          <p className="mt-1 text-sm text-muted">本地服务状态、今日用量、供应商额度与最近请求。</p>
        </div>
        <button
          type="button"
          onClick={() => void handleTogglePaused()}
          disabled={!state.server.running || pausing}
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.server.paused ? (
            <Play className="size-4" aria-hidden="true" />
          ) : (
            <Pause className="size-4" aria-hidden="true" />
          )}
          {state.server.paused ? '恢复路由' : '暂停路由'}
        </button>
      </header>

      {!state.server.running && state.server.error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p className="font-medium break-words">服务未启动：{state.server.error}</p>
          <p className="mt-1 text-xs leading-5">
            端口可能已被其他程序占用。到设置页修改端口并保存即可立即重试，本地 Key 与供应商配置不受影响。
          </p>
          {onOpenSettings && (
            <a
              href="#settings"
              onClick={(event) => {
                event.preventDefault()
                onOpenSettings()
              }}
              className="mt-2 inline-flex h-8 items-center rounded-lg border border-red-300 bg-surface px-3 text-xs font-medium text-red-800 transition-colors hover:bg-red-100"
            >
              前往设置修改端口
            </a>
          )}
        </div>
      )}

      {state.server.paused && state.server.running && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
          路由已暂停：所有 /v1 请求会返回 503，点击「恢复路由」继续服务。
        </div>
      )}

      <section aria-label="服务状态" className="overflow-hidden rounded-lg border border-line shadow-sm">
        <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 xl:grid-cols-6">
          {statCells.map((cell) => (
            <div key={cell.label} className="bg-surface px-4 py-3">
              <dt className="text-xs text-muted">{cell.label}</dt>
              <dd
                className={`mt-1 truncate text-lg font-semibold tabular-nums text-ink ${
                  cell.label === '监听地址'
                    ? 'font-mono text-[13px]'
                    : cell.label === '运行状态'
                      ? `text-sm ${TEXT_TONE[serverTone]}`
                      : ''
                }`}
                title={cell.title}
              >
                {cell.label === '运行状态' ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`size-2 rounded-full ${DOT_TONE[serverTone]}`} aria-hidden="true" />
                    {cell.value}
                  </span>
                ) : (
                  cell.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-6" aria-labelledby="quota-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="quota-heading" className="text-base font-semibold text-ink">
            供应商额度
          </h2>
          <p className="text-xs text-muted">
            按路由优先级排列 · 额度每 {formatRefreshInterval(state.settings.quotaRefreshSec)} 探测一次
          </p>
        </div>

        {state.providers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-surface px-6 py-12 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-canvas text-muted">
              <Server className="size-5" aria-hidden="true" />
            </span>
            <h3 className="mt-4 text-base font-semibold text-ink">还没有供应商</h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">
              添加供应商后，这里会按优先级显示额度窗口、余额与冷却状态。
            </p>
            <a
              href="#providers"
              onClick={(event) => {
                event.preventDefault()
                onOpenProviders()
              }}
              className="mt-5 inline-flex h-10 items-center rounded-lg border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-neutral-50"
            >
              前往供应商
            </a>
          </div>
        ) : (
          <ul aria-label="供应商额度" className="grid list-none gap-4 p-0 lg:grid-cols-2">
            {state.providers.map((provider, index) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                runtime={runtimeById.get(provider.id)}
                speed={speedByProvider.get(provider.id)}
                index={index}
                now={now}
                resetting={resettingId === provider.id}
                onReset={(id) => void handleReset(id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6" aria-labelledby="history-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="history-heading" className="text-base font-semibold text-ink">
            最近请求
          </h2>
          <p className="text-xs text-muted">本地日 {localDayKey()} · 最多显示 50 条 · 每 30 秒刷新</p>
        </div>
        <HistoryTable records={history} providers={state.providers} loading={historyLoading} />
      </section>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  )
}
