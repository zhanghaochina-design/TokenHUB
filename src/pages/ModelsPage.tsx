import { useEffect, useMemo, useState } from 'react'
import { Activity, Boxes, Eye, EyeOff, Link2, Pencil, Plus, RefreshCw, Search, SearchX, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react'
import type { AppState, EffectiveModelMeta, ModelAlias, MergedModelTarget, ModelEndpointSupport, ModelProtocolSupport, ProviderRuntime, ProtocolScanResult } from '../../core/types'
import { suggestModelAliases } from '../../core/providers/aliases'
import { isTargetHidden, listedCatalog } from '../../core/providers/catalog'
import { aggregateModelMeta, effectiveModelMeta } from '../../core/providers/modelMeta'
import { ModelAliasDialog } from '../components/ModelAliasDialog'
import { ModelMetaDialog } from '../components/ModelMetaDialog'
import { ProtocolScanDialog } from '../components/ProtocolScanDialog'
import { Toast } from '../components/Toast'
import {
  describeMeta,
  describeThinking,
  errorMessage,
  formatContextLength,
  formatDateTime,
  formatNumber,
  providerModelCount,
  providerStatus,
  type StatusTone
} from '../lib/format'

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

function ProtocolBadges({ support, discovered }: { support?: ModelProtocolSupport; discovered?: ModelEndpointSupport }) {
  if (!support && !discovered) return null
  const entries = [
    { key: 'anthropic', label: 'A', title: 'Anthropic /messages' },
    { key: 'openai', label: 'O', title: 'OpenAI /chat/completions' }
  ] as const
  return (
    <span className="inline-flex items-center gap-0.5">
      {entries.map((entry) => {
        // 扫描结果优先；扫描无法判定或被拒绝时，用上游声明的入口能力兜底。
        const value = support?.[entry.key] ?? discovered?.[entry.key] ?? null
        const mark = value === true ? '✓' : value === false ? '✗' : '?'
        const tone =
          value === true
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : value === false
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-line bg-neutral-50 text-neutral-600'
        const label = value === true ? '支持' : value === false ? '不支持' : '未知'
        const source = support ? formatDateTime(support.checkedAt) : '上游模型列表声明'
        return (
          <span
            key={entry.key}
            title={`${entry.title}：${label}（${source}）`}
            className={`rounded border px-1 py-0.5 font-mono text-[10px] leading-none ${tone}`}
          >
            {entry.label}
            {mark}
          </span>
        )
      })}
    </span>
  )
}

const META_BADGE = 'rounded border px-1.5 py-0.5 text-[10px] leading-4'
const META_BADGE_KNOWN = 'border-line bg-neutral-50 text-neutral-700'
const META_BADGE_UNKNOWN = 'border-dashed border-line bg-surface text-muted'

// 聚合口径：上下文取各目标最小值、视觉任一支持、思考按同一参数名取交集。
function MetaBadges({ meta }: { meta: EffectiveModelMeta }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span
        className={`${META_BADGE} ${meta.contextLength === null ? META_BADGE_UNKNOWN : META_BADGE_KNOWN}`}
        title={meta.contextLength === null ? '上下文长度未标注' : `上下文 ${formatNumber(meta.contextLength)} tokens（多供应商取最小值）`}
      >
        {meta.contextLength === null ? '上下文未标注' : formatContextLength(meta.contextLength)}
      </span>
      <span
        className={`${META_BADGE} ${meta.vision === null ? META_BADGE_UNKNOWN : META_BADGE_KNOWN}`}
        title={meta.vision === null ? '视觉能力未标注' : meta.vision ? '支持图片输入' : '不支持图片输入'}
      >
        {meta.vision === null ? '视觉未标注' : meta.vision ? '视觉' : '无视觉'}
      </span>
      <span
        className={`${META_BADGE} max-w-64 truncate ${meta.thinking === null ? META_BADGE_UNKNOWN : META_BADGE_KNOWN}`}
        title={describeThinking(meta.thinking)}
      >
        {describeThinking(meta.thinking)}
      </span>
    </span>
  )
}

export function ModelsPage({ state, onOpenProviders }: ModelsPageProps) {
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [aliasEditor, setAliasEditor] = useState<{ initial: ModelAlias | null } | null>(null)
  const [scanResults, setScanResults] = useState<ProtocolScanResult | null>(null)
  const [metaEditor, setMetaEditor] = useState<{ providerId: string; upstreamModel: string } | null>(null)
  const [showHidden, setShowHidden] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const aliases = state.aliases ?? []
  const providerById = useMemo(
    () => new Map(state.providers.map((provider) => [provider.id, provider])),
    [state.providers]
  )
  const runtimeById = useMemo(
    () => new Map(state.runtime.map((runtime) => [runtime.providerId, runtime])),
    [state.runtime]
  )
  const metaProvider = metaEditor ? providerById.get(metaEditor.providerId) : undefined
  const suggestions = useMemo(() => suggestModelAliases(state.providers, aliases), [state.providers, aliases])

  const normalizedQuery = query.trim().toLowerCase()
  const displayModels = useMemo(
    () => (showHidden ? state.catalog : listedCatalog(state.catalog, state.providers)),
    [state.catalog, state.providers, showHidden]
  )
  const hiddenCount = useMemo(
    () =>
      state.catalog.reduce(
        (count, model) =>
          count +
          model.targets.filter((target) => isTargetHidden(providerById.get(target.providerId), target.upstreamModel)).length,
        0
      ),
    [state.catalog, providerById]
  )
  const filtered = useMemo(
    () =>
      normalizedQuery
        ? displayModels.filter(
            (model) =>
              model.id.toLowerCase().includes(normalizedQuery) ||
              model.targets.some(
                (target) =>
                  (showHidden || !isTargetHidden(providerById.get(target.providerId), target.upstreamModel)) &&
                  target.upstreamModel.toLowerCase().includes(normalizedQuery)
              )
          )
        : displayModels,
    [displayModels, normalizedQuery, providerById, showHidden]
  )

  const enabledProviders = state.providers.filter((provider) => provider.enabled).length
  const hasProviders = state.providers.length > 0

  function providerName(providerId: string): string {
    return providerById.get(providerId)?.name ?? providerId
  }

  async function handleToggleHidden(providerId: string, upstreamModel: string, hidden: boolean) {
    try {
      await window.tokenhub.setModelHidden(providerId, upstreamModel, hidden)
    } catch (error) {
      setToast(`更新模型可见性失败：${errorMessage(error)}`)
    }
  }

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

  async function handleScan(provider: AppState['providers'][number]) {
    const total = providerModelCount(provider)
    if (total === 0) {
      setToast('该供应商还没有模型，先刷新模型。')
      return
    }
    if (state.scan) return
    const confirmed = window.confirm(
      `将向「${provider.name}」的 ${total} 个模型各发 2 个最小请求（max_tokens=16），可能消耗少量额度。继续？`
    )
    if (!confirmed) return
    try {
      const result = await window.tokenhub.scanProviderProtocols(provider.id)
      setScanResults(result)
      if (result.error) {
        setToast(`扫描未完成：${result.error}`)
      } else {
        const messagesOk = result.rows.filter((row) => row.anthropic === true).length
        const chatOk = result.rows.filter((row) => row.openai === true).length
        const autoHidden = result.rows.filter((row) => row.anthropic === false && row.openai === false).length
        setToast(
          `扫描完成：${result.rows.length} 个模型，Messages ${messagesOk} 个可用，Chat ${chatOk} 个可用${autoHidden > 0 ? `，自动隐藏 ${autoHidden} 个` : ''}`
        )
      }
    } catch (error) {
      setToast(`扫描失败：${errorMessage(error)}`)
    }
  }

  function handleViewSupport(provider: AppState['providers'][number]) {
    const current = new Set([...provider.models.cached, ...provider.models.manual])
    const rows = Object.entries(provider.protocolSupport ?? {})
      .filter(([model]) => current.has(model))
      .map(([model, support]) => ({ model, ...support }))
      .sort((a, b) => a.model.localeCompare(b.model))
    setScanResults({
      providerId: provider.id,
      providerName: provider.name,
      rows,
      endpointSupport: provider.endpointDiscovery
    })
  }

  async function handleSaveAlias(alias: ModelAlias, previousId?: string) {
    await window.tokenhub.saveModelAlias(alias, previousId)
  }

  async function handleDeleteAlias(alias: ModelAlias) {
    if (!window.confirm(`删除统一模型 ${alias.id}？被映射的原始模型 ID 会重新出现在列表。`)) return
    try {
      await window.tokenhub.deleteModelAlias(alias.id)
    } catch (error) {
      setToast(`删除统一模型失败：${errorMessage(error)}`)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] p-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">模型</h1>
          <p className="mt-1 text-sm text-muted">
            {hasProviders
              ? `合并 ${enabledProviders} 个已启用供应商的模型；统一模型只显示本地 ID，原始 ID 隐藏但仍可用 providerId/原始ID 强制访问。`
              : '合并所有已启用供应商的模型，供 Agent 选择。'}
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

      {state.providers.length > 0 && (
        <section aria-label="调用方式兼容性" className="mb-4 overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-muted" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-ink">调用方式兼容性</h2>
              <p className="text-xs text-muted">A = Anthropic /messages，O = OpenAI /chat/completions</p>
            </div>
            {state.scan && (
              <p className="text-xs tabular-nums text-accent" aria-live="polite">
                扫描中 {state.scan.providerName} · {state.scan.done}/{state.scan.total}
              </p>
            )}
          </div>
          <ul aria-label="供应商兼容性扫描" className="m-0 list-none divide-y divide-line p-0">
            {state.providers.map((provider) => {
              const current = new Set([...provider.models.cached, ...provider.models.manual])
              const scanned = Object.keys(provider.protocolSupport ?? {}).filter((model) => current.has(model))
              const resolved = [...current].map((model) => {
                const support = provider.protocolSupport?.[model]
                const endpoint = provider.endpointDiscovery?.[model]
                return {
                  anthropic: support?.anthropic ?? endpoint?.anthropic ?? null,
                  openai: support?.openai ?? endpoint?.openai ?? null
                }
              })
              const checked = scanned.length
              const messagesOk = resolved.filter((entry) => entry.anthropic === true).length
              const chatOk = resolved.filter((entry) => entry.openai === true).length
              const known = resolved.some((entry) => entry.anthropic !== null || entry.openai !== null)
              const total = providerModelCount(provider)
              const lastChecked = scanned
                .map((model) => provider.protocolSupport?.[model]?.checkedAt)
                .filter(Boolean)
                .sort()
                .at(-1)
              const isScanning = state.scan?.providerId === provider.id
              return (
                <li key={provider.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">{provider.name}</span>
                      {!provider.enabled && (
                        <span className="rounded border border-line bg-neutral-100 px-1.5 py-0.5 text-[11px] text-muted">已禁用</span>
                      )}
                      {!provider.hasKey && <span className="text-xs text-red-700">缺少 Key</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {checked > 0
                        ? `已扫描 ${checked}/${total} · Messages ${messagesOk} 支持 · Chat ${chatOk} 支持${lastChecked ? ` · 最近 ${formatDateTime(lastChecked)}` : ''}`
                        : known
                          ? `未扫描 · Messages ${messagesOk} 支持 · Chat ${chatOk} 支持 · ${total} 个模型`
                          : `尚未扫描 · ${total} 个模型`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {checked > 0 && (
                      <button
                        type="button"
                        onClick={() => handleViewSupport(provider)}
                        className="inline-flex h-8 items-center rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-ink transition-colors hover:bg-neutral-50"
                      >
                        查看结果
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleScan(provider)}
                      disabled={!provider.enabled || !provider.hasKey || total === 0 || Boolean(state.scan)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-ink transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Activity className={`size-3.5 ${isScanning ? 'animate-pulse' : ''}`} aria-hidden="true" />
                      {isScanning ? '扫描中…' : '扫描'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section aria-label="统一模型" className="mb-4 overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <Link2 className="size-4 text-muted" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-ink">统一模型</h2>
            <span className="text-xs tabular-nums text-muted">{aliases.length} 个</span>
          </div>
          <button
            type="button"
            aria-label="添加统一模型"
            disabled={!hasProviders}
            onClick={() => setAliasEditor({ initial: null })}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="size-4" aria-hidden="true" />
            添加统一模型
          </button>
        </div>

        {aliases.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted">还没有统一模型。给同一个模型配置多个供应商的上游 ID 后，Agent 只需使用本地统一 ID。</p>
        ) : (
          <ul aria-label="统一模型列表" className="m-0 list-none divide-y divide-line p-0">
            {aliases.map((alias) => (
              <li key={alias.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-[13px] text-ink">{alias.id}</span>
                    <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">统一</span>
                    {alias.targets.length === 0 && <span className="text-xs text-red-700">无目标，Agent 无法路由</span>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs text-muted">
                    {alias.targets.map((target) => {
                      const provider = providerById.get(target.providerId)
                      return (
                        <span key={target.providerId} className="inline-flex max-w-full items-center gap-1 rounded border border-line bg-neutral-50 px-1.5 py-0.5">
                          <span className={provider ? '' : 'text-red-700'}>{provider?.name ?? `${target.providerId}（供应商不存在）`}</span>
                          <span aria-hidden="true">→</span>
                          <span className="break-all font-mono text-ink">{target.upstreamModel}</span>
                        </span>
                      )
                    })}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label={`编辑统一模型 ${alias.id}`}
                    onClick={() => setAliasEditor({ initial: alias })}
                    className="flex size-8 items-center justify-center rounded-md border border-line text-muted transition-colors hover:bg-neutral-50 hover:text-ink"
                  >
                    <Pencil className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`删除统一模型 ${alias.id}`}
                    onClick={() => void handleDeleteAlias(alias)}
                    className="flex size-8 items-center justify-center rounded-md border border-line text-muted transition-colors hover:bg-red-50 hover:text-red-700"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {suggestions.length > 0 && (
          <div className="border-t border-line bg-canvas/60 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles className="size-4 text-accent" aria-hidden="true" />
              <h3 className="text-xs font-semibold text-ink">自动建议</h3>
              <p className="text-xs text-muted">按名称相似度生成，不会自动合并；确认后创建。</p>
            </div>
            <div className="mt-2 grid gap-2">
              {suggestions.map((suggestion) => (
                <div key={suggestion.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2">
                  <div className="min-w-0">
                    <div className="break-all font-mono text-[13px] text-ink">{suggestion.id}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted">
                      {suggestion.targets.map((target) => (
                        <span key={target.providerId} className="inline-flex items-center gap-1 rounded border border-line bg-neutral-50 px-1.5 py-0.5">
                          {providerName(target.providerId)}
                          <span aria-hidden="true">→</span>
                          <span className="break-all font-mono text-ink">{target.upstreamModel}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`创建统一模型 ${suggestion.id}`}
                    onClick={() => setAliasEditor({ initial: { id: suggestion.id, targets: suggestion.targets } })}
                    className="inline-flex h-8 shrink-0 items-center rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-ink transition-colors hover:bg-neutral-50"
                  >
                    创建
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

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
                placeholder="按统一 ID 或上游 ID 搜索"
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
            <div className="flex items-center gap-3">
              <p className="text-xs tabular-nums text-muted" aria-live="polite">
                显示 {filtered.length} / {displayModels.length}
                {hiddenCount > 0 && ` · 已隐藏 ${hiddenCount}`}
              </p>
              <button
                type="button"
                aria-pressed={showHidden}
                onClick={() => setShowHidden((current) => !current)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs font-medium text-ink transition-colors hover:bg-neutral-50"
              >
                {showHidden ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
                {showHidden ? '收起隐藏项' : '显示已隐藏'}
              </button>
            </div>
          </div>

          {filtered.length === 0 ? (
            normalizedQuery ? (
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
              <div className="px-6 py-14 text-center">
                <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-canvas text-muted">
                  <EyeOff className="size-4" aria-hidden="true" />
                </span>
                <p className="mt-3 text-sm font-medium text-ink">所有模型都已隐藏</p>
                <p className="mt-1 text-sm text-muted">本地列表当前为空；打开「显示已隐藏」可逐条恢复。</p>
                <button
                  type="button"
                  onClick={() => setShowHidden(true)}
                  className="mt-4 inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-neutral-50"
                >
                  显示已隐藏
                </button>
              </div>
            )
          ) : (
            <ul aria-label="模型列表" className="m-0 list-none divide-y divide-line p-0">
              {filtered.map((model) => {
                const targets = showHidden
                  ? model.targets
                  : model.targets.filter((target) => !isTargetHidden(providerById.get(target.providerId), target.upstreamModel))
                const rowHidden = model.targets.every((target) =>
                  isTargetHidden(providerById.get(target.providerId), target.upstreamModel)
                )
                const shownMeta =
                  targets.length === model.targets.length
                    ? model.meta
                    : aggregateModelMeta(
                        targets.flatMap((target) => {
                          const provider = providerById.get(target.providerId)
                          return provider ? [effectiveModelMeta(provider, target.upstreamModel)] : []
                        })
                      )
                return (
                  <li
                    key={model.id}
                    className={`flex items-start justify-between gap-4 px-4 py-3 transition-colors hover:bg-neutral-50/80 ${rowHidden ? 'opacity-60' : ''}`}
                    title={model.targets
                      .map((target) => {
                        const provider = providerById.get(target.providerId)
                        const hidden = isTargetHidden(provider, target.upstreamModel)
                        if (!provider) return `${target.providerId}: ${target.upstreamModel}${hidden ? '（已隐藏）' : ''}`
                        return `${provider.name}: ${target.upstreamModel}${hidden ? '（已隐藏）' : ''}（${describeMeta(effectiveModelMeta(provider, target.upstreamModel))}）`
                      })
                      .join('\n')}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-[13px] leading-5 text-ink">{model.id}</span>
                        {model.isAlias && <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">统一</span>}
                        {rowHidden && <span className="rounded border border-dashed border-line bg-surface px-1.5 py-0.5 text-[10px] text-muted">已隐藏</span>}
                      </span>
                      <MetaBadges meta={shownMeta} />
                    </span>
                    <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      {targets.map((target) => {
                        const provider = providerById.get(target.providerId)
                        const hidden = isTargetHidden(provider, target.upstreamModel)
                        return (
                          <span key={target.providerId} className={`inline-flex items-center gap-1 ${hidden ? 'opacity-50' : ''}`}>
                            <ProviderBadge
                              providerId={target.providerId}
                              name={provider?.name ?? null}
                              runtime={runtimeById.get(target.providerId)}
                              enabled={provider?.enabled ?? true}
                              now={now}
                            />
                            <ProtocolBadges
                              support={provider?.protocolSupport?.[target.upstreamModel]}
                              discovered={provider?.endpointDiscovery?.[target.upstreamModel]}
                            />
                            <button
                              type="button"
                              aria-label={`编辑 ${provider?.name ?? target.providerId} / ${target.upstreamModel} 元数据`}
                              title="编辑上下文、视觉与思考参数"
                              disabled={!provider}
                              onClick={() => setMetaEditor({ providerId: target.providerId, upstreamModel: target.upstreamModel })}
                              className="flex size-6 items-center justify-center rounded border border-line bg-surface text-muted transition-colors hover:bg-neutral-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <SlidersHorizontal className="size-3" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              aria-label={`${hidden ? '显示' : '隐藏'} ${provider?.name ?? target.providerId} / ${target.upstreamModel} 条目`}
                              title={hidden ? '在本地列表中显示' : '从本地列表隐藏（仍可调用）'}
                              disabled={!provider}
                              onClick={() => void handleToggleHidden(target.providerId, target.upstreamModel, !hidden)}
                              className="flex size-6 items-center justify-center rounded border border-line bg-surface text-muted transition-colors hover:bg-neutral-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {hidden ? <EyeOff className="size-3" aria-hidden="true" /> : <Eye className="size-3" aria-hidden="true" />}
                            </button>
                          </span>
                        )
                      })}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {aliasEditor && (
        <ModelAliasDialog
          providers={state.providers}
          aliases={aliases}
          initial={aliasEditor.initial}
          onClose={() => setAliasEditor(null)}
          onSave={handleSaveAlias}
        />
      )}
      {metaEditor && metaProvider && (
        <ModelMetaDialog
          provider={metaProvider}
          upstreamModel={metaEditor.upstreamModel}
          onClose={() => setMetaEditor(null)}
          onSave={(meta) => window.tokenhub.saveModelMeta(metaProvider.id, metaEditor.upstreamModel, meta)}
        />
      )}
      {scanResults && <ProtocolScanDialog result={scanResults} onClose={() => setScanResults(null)} />}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  )
}
