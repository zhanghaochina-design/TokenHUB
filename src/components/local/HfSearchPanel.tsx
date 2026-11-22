import { useState } from 'react'
import type { HfModelDetail, HfModelSummary } from '../../../core/local/types'
import { errorMessage, formatNumber } from '../../lib/format'
// 分片整组校验是纯逻辑，单独放 lib 以便在 node 环境跑单测（组件文件带 JSX，node tsconfig 无法导入）。
import { findIncompleteSplit } from '../../lib/hfSelection'

// HF 的体积以 GB 为单位展示，固定两位小数；精确字节数放在 title 里，方便核对分片大小。
function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function HfSearchPanel({
  hfTokenSet,
  onDownloaded,
  onError
}: {
  // Gated 模型只有在 secrets.bin 里有 Token 才下载得动；这里只用来给提示，不拦截入队。
  hfTokenSet: boolean
  onDownloaded: (repo: string) => void
  onError: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HfModelSummary[]>([])
  const [detail, setDetail] = useState<HfModelDetail | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [opening, setOpening] = useState(false)
  const [enqueuing, setEnqueuing] = useState(false)
  // 已入队的仓库 ID：同一详情页只允许成功入队一次，避免重复点击产生「已在下载队列中」的错误。
  const [enqueuedRepo, setEnqueuedRepo] = useState<string | null>(null)

  async function search() {
    setSearching(true)
    try {
      setResults(await window.tokenhub.local.searchHf(query))
      // 结果换了一批，旧详情与入队态都不再对应，必须清掉。
      setDetail(null)
      setSelected([])
      setEnqueuedRepo(null)
    } catch (error) {
      onError(`搜索失败：${errorMessage(error)}`)
    } finally {
      setSearching(false)
    }
  }

  async function open(repo: string) {
    setOpening(true)
    try {
      const model = await window.tokenhub.local.getHfModel(repo)
      setDetail(model)
      // 默认只勾主模型，mmproj 视觉适配权重不单独勾选（P3 才支持视觉）。
      setSelected(model.files.filter((file) => !file.isAdapter).map((file) => file.path))
      setEnqueuedRepo(null)
    } catch (error) {
      onError(`读取模型失败：${errorMessage(error)}`)
    } finally {
      setOpening(false)
    }
  }

  async function download() {
    if (!detail || selected.length === 0 || enqueuedRepo === detail.id) return
    const gap = findIncompleteSplit(detail.files, selected)
    if (gap) {
      onError(`分片未选全：${gap.base} 需要 ${gap.total} 个文件（已选 ${gap.chosen} 个）`)
      return
    }
    setEnqueuing(true)
    try {
      await window.tokenhub.local.download(detail.id, selected)
      setEnqueuedRepo(detail.id)
      onDownloaded(detail.id)
    } catch (error) {
      onError(`开始下载失败：${errorMessage(error)}`)
    } finally {
      setEnqueuing(false)
    }
  }

  const selectedBytes = detail
    ? detail.files.filter((file) => selected.includes(file.path)).reduce((sum, file) => sum + file.sizeBytes, 0)
    : 0
  const alreadyEnqueued = detail !== null && enqueuedRepo === detail.id
  const input = 'h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none'
  return (
    <section className="min-w-0 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-ink">HuggingFace 模型</h2>
      <div className="mt-3 flex gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void search()
          }}
          placeholder="搜索 GGUF 模型，如 qwen3 gguf"
          aria-label="HuggingFace 模型搜索"
          className={input}
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching}
          className="inline-flex h-9 shrink-0 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {searching ? '查询中…' : '搜索'}
        </button>
      </div>
      <ul className="mt-3 max-h-64 divide-y divide-line overflow-auto">
        {results.map((model) => (
          <li key={model.id} className="flex items-center justify-between gap-3 py-2">
            <button
              type="button"
              onClick={() => void open(model.id)}
              disabled={opening}
              className="min-w-0 flex-1 text-left disabled:opacity-60"
            >
              <p className="truncate text-sm text-ink">{model.id}</p>
              <p className="text-xs text-muted">
                下载 {formatNumber(model.downloads)} · 赞 {formatNumber(model.likes)}
                {model.license ? ` · ${model.license}` : ''}
              </p>
            </button>
            {model.gated ? (
              <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                需授权
              </span>
            ) : null}
          </li>
        ))}
        {results.length === 0 ? <li className="py-3 text-sm text-muted">输入关键词搜索 GGUF 模型。</li> : null}
      </ul>
      {detail ? (
        <div className="mt-4 rounded-md bg-canvas p-3">
          <div className="flex items-center gap-2">
            <p className="min-w-0 truncate text-sm font-medium text-ink">{detail.id}</p>
            {detail.gated ? (
              <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                需授权
              </span>
            ) : null}
          </div>
          {detail.gated ? (
            <p className="mt-1 text-xs text-muted">
              {hfTokenSet
                ? '该模型受授权保护：请确认已在 HuggingFace 网页同意条款，Token 已设置。'
                : '该模型受授权保护：请先在「本地设置」保存 HuggingFace Token，并同意模型条款。'}
            </p>
          ) : null}
          <ul className="mt-2 space-y-1">
            {detail.files.map((file) => (
              <li key={file.path} className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  aria-label={`选择文件 ${file.path}`}
                  checked={selected.includes(file.path)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked ? [...current, file.path] : current.filter((path) => path !== file.path)
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate" title={file.path}>
                  {file.path}
                  {file.split ? `（分片 ${file.split.part}/${file.split.total}）` : ''}
                  {file.isAdapter ? '（视觉适配，P3）' : ''}
                </span>
                <span className="shrink-0 font-mono" title={`${formatNumber(file.sizeBytes)} 字节`}>
                  {gb(file.sizeBytes)}
                </span>
              </li>
            ))}
            {detail.files.length === 0 ? (
              <li className="text-xs text-muted">该仓库没有可推理的 .gguf 文件。</li>
            ) : null}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void download()}
              disabled={selected.length === 0 || enqueuing || alreadyEnqueued}
              className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {enqueuing ? '正在加入…' : alreadyEnqueued ? '已加入下载队列' : '下载所选文件'}
            </button>
            <span className="text-xs text-muted">
              已选 {selected.length} 个文件 · 共 {gb(selectedBytes)}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  )
}
