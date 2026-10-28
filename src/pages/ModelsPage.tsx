import { useEffect, useMemo, useState } from 'react'
import { Boxes, RefreshCw, Search, SearchX, X } from 'lucide-react'
import type { AppState, ProviderRuntime } from '../../core/types'
import { Toast } from '../components/Toast'
import { errorMessage, providerStatus, type StatusTone } from '../lib/format'

interface ModelsPageProps {
  state: AppState
  onOpenProviders: () => void
}

const BADGE_TONE: Record<StatusTone, string> = {
  ok: 'border-line bg-neutral-50 text-neutral-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  error: 'border-red-200 bg-red-50 text-red-700',
  muted: 'border-line bg-neutral-100 text-neutral-600'
}

const DOT_TONE: Record<StatusTone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  muted: 'bg-neutral-400'
}

interface ProviderBadgeProps {
  providerId: string
  name: string | null
  runtime: ProviderRuntime | undefined
  enabled: boolean
  now: number
}

function ProviderBadge({ providerId, name, runtime, enabled, now }: ProviderBadgeProps) {
  const status = name ? providerStatus({ enabled }, runtime, now) : { label: '未知供应商', tone: 'muted' as const }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${BADGE_TONE[status.tone]}`}
      title={status.detail ?? `${status.label} · ${providerId}`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${DOT_TONE[status.tone]}`} aria-hidden="true" />
      <span className="max-w-48 truncate">{name ?? providerId}</span>
      <span className="sr-only">（{status.label}）</span>
    </span>
  )
}

export function ModelsPage({ state, onOpenProviders }: ModelsPageProps) {
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const providerById = useMemo(
    () => new Map(state.providers.map((provider) => [provider.id, provider])),
    [state.providers]
  )
  const runtimeById = useMemo(
    () => new Map(state.runtime.map((runtime) => [runtime.providerId, runtime])),
    [state.runtime]
  )

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      normalizedQuery
        ? state.catalog.filter((model) => model.id.toLowerCase().includes(normalizedQuery))
        : state.catalog,
    [state.catalog, normalizedQuery]
  )

  const enabledProviders = state.providers.filter((provider) => provider.enabled).length
  const hasProviders = state.providers.length > 0

  async function handleRefreshAll() {
    setRefreshing(true)
    try {
      await window.tokenhub.refreshModels()
    } catch (error) {
      setToast(`刷新模型失败：${errorMessage(error)}`)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] p-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">模型</h1>
          <p className="mt-1 text-sm text-muted">
            {hasProviders
              ? `合并 ${enabledProviders} 个已启用供应商的模型 ID，Agent 使用这里出现的名称请求模型。`
              : '合并所有已启用供应商的模型 ID，供 Agent 选择。'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleRefreshAll()}
          disabled={!hasProviders || refreshing}
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium text-ink transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          {refreshing ? '刷新中…' : '刷新全部'}
        </button>
      </header>

      {!hasProviders ? (
        <div className="rounded-lg border border-dashed border-line bg-surface px-6 py-16 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-canvas text-muted">
            <Boxes className="size-5" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-base font-semibold text-ink">还没有供应商</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            添加供应商后，这里会显示合并后的模型目录，供 Agent 选择模型。
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
      ) : state.catalog.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-surface px-6 py-16 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-canvas text-muted">
            <Boxes className="size-5" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-base font-semibold text-ink">暂无可用模型</h2>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted">
            点击右上角「刷新全部」从供应商拉取模型，或在编辑供应商时手动填写模型 ID。
          </p>
        </div>
      ) : (
        <section className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <label htmlFor="model-search" className="sr-only">
                搜索模型
              </label>
              <input
                id="model-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="搜索模型"
                placeholder="按模型 ID 搜索"
                className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-9 text-sm text-ink placeholder:text-neutral-500 transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  aria-label="清除搜索"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
            <p className="text-xs tabular-nums text-muted" aria-live="polite">
              显示 {filtered.length} / {state.catalog.length}
            </p>
          </div>

          {filtered.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-canvas text-muted">
                <SearchX className="size-4" aria-hidden="true" />
              </span>
              <p className="mt-3 text-sm font-medium text-ink">没有匹配的模型</p>
              <p className="mt-1 text-sm text-muted">未找到包含「{query.trim()}」的模型 ID。</p>
              <button
                type="button"
                onClick={() => setQuery('')}
                className="mt-4 inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-neutral-50"
              >
                清除搜索
              </button>
            </div>
          ) : (
            <ul aria-label="模型列表" className="m-0 list-none divide-y divide-line p-0">
              {filtered.map((model) => (
                <li
                  key={model.id}
                  className="flex items-start justify-between gap-4 px-4 py-3 transition-colors hover:bg-neutral-50/80"
                >
                  <span className="min-w-0 break-all font-mono text-[13px] leading-5 text-ink">{model.id}</span>
                  <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {model.providers.map((providerId) => {
                      const provider = providerById.get(providerId)
                      return (
                        <ProviderBadge
                          key={providerId}
                          providerId={providerId}
                          name={provider?.name ?? null}
                          runtime={runtimeById.get(providerId)}
                          enabled={provider?.enabled ?? true}
                          now={now}
                        />
                      )
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  )
}
