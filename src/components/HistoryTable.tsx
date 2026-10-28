import { Fragment, useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, History, SearchX } from 'lucide-react'
import type { ErrorKind, HistoryRecord, ProviderConfig } from '../../core/types'
import { errorKindLabel, formatClock, formatNumber } from '../lib/format'

interface HistoryTableProps {
  records: HistoryRecord[]
  providers: Array<Pick<ProviderConfig, 'id' | 'name'>>
  loading: boolean
}

type OutcomeFilter = 'all' | HistoryRecord['outcome']

const SELECT_CLASS =
  'h-9 rounded-lg border border-line bg-surface px-2.5 text-xs text-ink transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60'

const PROTOCOL_LABELS: Record<HistoryRecord['protocol'], string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic'
}

function totalTokens(record: HistoryRecord): number | null {
  if (record.promptTokens === null && record.completionTokens === null) return null
  return (record.promptTokens ?? 0) + (record.completionTokens ?? 0)
}

function errorSummary(kind: ErrorKind | null): string {
  return kind ? errorKindLabel(kind) : '—'
}

export function HistoryTable({ records, providers, loading }: HistoryTableProps) {
  const providerFilterId = useId()
  const modelFilterId = useId()
  const outcomeFilterId = useId()
  const [provider, setProvider] = useState<string>('all')
  const [model, setModel] = useState<string>('all')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  const providerNameById = useMemo(() => new Map(providers.map((item) => [item.id, item.name])), [providers])

  const providerOptions = useMemo(() => {
    const ids = new Set(records.flatMap((record) => (record.providerId ? [record.providerId] : [])))
    return [...ids]
      .map((id) => ({ id, name: providerNameById.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }, [records, providerNameById])

  const modelOptions = useMemo(
    () => [...new Set(records.map((record) => record.model))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [records]
  )

  const filtered = records.filter(
    (record) =>
      (provider === 'all' || record.providerId === provider) &&
      (model === 'all' || record.model === model) &&
      (outcome === 'all' || record.outcome === outcome)
  )
  const hasFilters = provider !== 'all' || model !== 'all' || outcome !== 'all'

  function clearFilters() {
    setProvider('all')
    setModel('all')
    setOutcome('all')
  }

  return (
    <section
      aria-label="最近请求"
      className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-neutral-50/70 px-4 py-3">
        <label htmlFor={providerFilterId} className="sr-only">
          按供应商过滤
        </label>
        <select
          id={providerFilterId}
          aria-label="按供应商过滤"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          className={SELECT_CLASS}
        >
          <option value="all">全部供应商</option>
          {providerOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>

        <label htmlFor={modelFilterId} className="sr-only">
          按模型过滤
        </label>
        <select
          id={modelFilterId}
          aria-label="按模型过滤"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className={`${SELECT_CLASS} max-w-64`}
        >
          <option value="all">全部模型</option>
          {modelOptions.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>

        <label htmlFor={outcomeFilterId} className="sr-only">
          按结果过滤
        </label>
        <select
          id={outcomeFilterId}
          aria-label="按结果过滤"
          value={outcome}
          onChange={(event) => setOutcome(event.target.value as OutcomeFilter)}
          className={SELECT_CLASS}
        >
          <option value="all">全部结果</option>
          <option value="ok">成功</option>
          <option value="error">失败</option>
        </select>

        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="h-9 rounded-lg px-2.5 text-xs font-medium text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
          >
            清除筛选
          </button>
        )}

        <p className="ml-auto text-xs tabular-nums text-muted" aria-live="polite">
          显示 {filtered.length} / {records.length}
        </p>
      </div>

      {loading ? (
        <p role="status" className="px-4 py-12 text-center text-sm text-muted">
          正在加载今日历史…
        </p>
      ) : records.length === 0 ? (
        <div className="px-6 py-14 text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-canvas text-muted">
            <History className="size-4" aria-hidden="true" />
          </span>
          <p className="mt-3 text-sm font-medium text-ink">今天还没有请求</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            Agent 通过本地地址发起请求后，这里会按时间倒序显示只含元数据的记录。
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-6 py-14 text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-canvas text-muted">
            <SearchX className="size-4" aria-hidden="true" />
          </span>
          <p className="mt-3 text-sm font-medium text-ink">没有匹配的请求</p>
          <p className="mt-1 text-sm text-muted">当前筛选条件下没有今日请求。</p>
          <button
            type="button"
            onClick={clearFilters}
            className="mt-4 inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-neutral-50"
          >
            清除筛选
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-neutral-50/70 text-xs font-medium text-muted">
                <th scope="col" className="w-10 px-4 py-2">
                  <span className="sr-only">展开详情</span>
                </th>
                <th scope="col" className="whitespace-nowrap px-2 py-2">
                  时间
                </th>
                <th scope="col" className="px-2 py-2">
                  协议
                </th>
                <th scope="col" className="px-2 py-2">
                  模型
                </th>
                <th scope="col" className="px-2 py-2">
                  供应商
                </th>
                <th scope="col" className="px-2 py-2">
                  状态
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  Token
                </th>
                <th scope="col" className="px-2 py-2 pr-4 text-right">
                  耗时
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => {
                const open = expanded === record.requestId
                const ok = record.outcome === 'ok'
                const tokens = totalTokens(record)
                const providerName = record.providerId ? providerNameById.get(record.providerId) ?? record.providerId : null
                const detailId = `history-detail-${record.requestId}`
                return (
                  <Fragment key={record.requestId}>
                    <tr
                      onClick={() => setExpanded(open ? null : record.requestId)}
                      className="border-b border-line transition-colors last:border-b-0 hover:bg-neutral-50/80"
                    >
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={open ? detailId : undefined}
                          aria-label={`${open ? '收起' : '展开'}请求 ${record.model} 的详情`}
                          onClick={(event) => {
                            event.stopPropagation()
                            setExpanded(open ? null : record.requestId)
                          }}
                          className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
                        >
                          {open ? (
                            <ChevronDown className="size-4" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="size-4" aria-hidden="true" />
                          )}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 font-mono text-xs tabular-nums text-muted">
                        {formatClock(record.ts)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5">
                        <span className="rounded-md border border-line bg-neutral-50 px-1.5 py-0.5 text-[11px] text-neutral-700">
                          {PROTOCOL_LABELS[record.protocol]}
                        </span>
                      </td>
                      <td className="max-w-64 truncate px-2 py-2.5 font-mono text-xs text-ink" title={record.model}>
                        {record.model}
                      </td>
                      <td className="max-w-40 truncate px-2 py-2.5 text-xs text-ink" title={providerName ?? '—'}>
                        {providerName ?? '—'}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                            ok
                              ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                              : 'bg-red-50 text-red-700 ring-red-600/20'
                          }`}
                          title={`HTTP ${record.httpStatus}${ok ? '' : ` · ${errorSummary(record.errorKind)}`}`}
                        >
                          <span
                            className={`size-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`}
                            aria-hidden="true"
                          />
                          {ok ? '成功' : '失败'}
                        </span>
                      </td>
                      <td
                        className="px-2 py-2.5 text-right text-xs tabular-nums text-ink"
                        title={
                          tokens === null
                            ? '上游未返回用量'
                            : `输入 ${record.promptTokens ?? 0} · 输出 ${record.completionTokens ?? 0}`
                        }
                      >
                        {tokens === null ? '—' : formatNumber(tokens)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 pr-4 text-right text-xs tabular-nums text-muted">
                        {formatNumber(record.latencyMs)} ms
                      </td>
                    </tr>
                    {open && (
                      <tr id={detailId} className="border-b border-line bg-canvas/60 last:border-b-0">
                        <td colSpan={8} className="px-4 py-3">
                          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                            <div className="min-w-0">
                              <dt className="text-muted">请求 ID</dt>
                              <dd className="mt-0.5 break-all font-mono text-ink">{record.requestId || '—'}</dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="text-muted">上游模型</dt>
                              <dd className="mt-0.5 break-all font-mono text-ink">{record.upstreamModel ?? '—'}</dd>
                            </div>
                            <div>
                              <dt className="text-muted">首字节耗时</dt>
                              <dd className="mt-0.5 tabular-nums text-ink">
                                {record.firstByteMs === null ? '—' : `${formatNumber(record.firstByteMs)} ms`}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted">错误分类</dt>
                              <dd className="mt-0.5 text-ink">{errorSummary(record.errorKind)}</dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="text-muted">切换来源</dt>
                              <dd className="mt-0.5 break-all text-ink">
                                {record.failoverFrom && record.failoverFrom.length > 0
                                  ? record.failoverFrom
                                      .map((id) => providerNameById.get(id) ?? id)
                                      .join(' → ')
                                  : '无'}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted">请求方式</dt>
                              <dd className="mt-0.5 text-ink">{record.stream ? '流式' : '非流式'}</dd>
                            </div>
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
