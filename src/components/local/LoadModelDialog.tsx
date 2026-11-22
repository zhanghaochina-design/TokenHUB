import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { estimateKvBytes } from '../../../core/local/kvEstimate'
import { KV_CACHE_TYPES, MAX_CONTEXT_TOKENS, MIN_CONTEXT_TOKENS } from '../../../core/local/settings'
import type { InstalledModel, KvCacheType, LocalLoadOptions, LocalSettings } from '../../../core/local/types'
import { errorMessage, formatContextLength, formatNumber } from '../../lib/format'

const GIB = 1024 ** 3
// 计算缓冲与碎片的安全余量：估算值不含这部分，直接加 0.5 GiB 避免把临界值当成可加载。
const OVERHEAD_BYTES = 0.5 * GIB

const KV_OPTIONS: Array<{ value: KvCacheType; label: string }> = [
  { value: 'f16', label: 'f16（质量最好，显存最大）' },
  { value: 'q8_0', label: 'q8_0（推荐，约一半显存）' },
  { value: 'q4_0', label: 'q4_0（最省显存，质量有损）' }
]

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(2)} GiB`
}

interface LoadModelDialogProps {
  model: InstalledModel
  settings: LocalSettings
  // 整机显存总量；资源采样未就绪时由调用方用硬件报告兜底，避免显示「未知」。
  vramTotalBytes: number | null
  onClose: () => void
  onLoad: (options: LocalLoadOptions) => Promise<void>
}

export function LoadModelDialog({ model, settings, vramTotalBytes, onClose, onLoad }: LoadModelDialogProps) {
  const [context, setContext] = useState(String(settings.defaultContext))
  const [kvCache, setKvCache] = useState<KvCacheType>(settings.kvCache)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const firstField = useRef<HTMLInputElement>(null)
  const trained = model.kvInfo?.trainedContext ?? null

  // 预设按值去重：默认值可能恰好等于 256K，避免下拉里出现两个相同项。
  const presets = useMemo(() => {
    const entries: Array<{ label: string; value: number }> = [
      { label: `默认（${formatNumber(settings.defaultContext)}）`, value: settings.defaultContext },
      { label: '256K', value: 262144 },
      { label: '512K', value: 524288 },
      { label: '1M', value: 1048576 }
    ]
    if (trained !== null) entries.push({ label: `训练上限（${formatNumber(trained)}）`, value: trained })
    const seen = new Set<number>()
    return entries.filter((entry) => (seen.has(entry.value) ? false : (seen.add(entry.value), true)))
  }, [settings.defaultContext, trained])

  const selectedPreset = presets.find((preset) => String(preset.value) === context.trim())?.value
  const tokens = Number(context)
  const validTokens = Number.isInteger(tokens) && tokens >= MIN_CONTEXT_TOKENS && tokens <= MAX_CONTEXT_TOKENS
  const kvBytes = validTokens ? estimateKvBytes(model.kvInfo, tokens, kvCache) : null
  const totalBytes = model.sizeBytes + OVERHEAD_BYTES + (kvBytes ?? 0)
  const vramTotal = vramTotalBytes
  const overVram = vramTotal !== null && validTokens && totalBytes > vramTotal
  const ropeScale = trained !== null && validTokens && tokens > trained ? tokens / trained : null

  useEffect(() => {
    firstField.current?.focus()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!validTokens) {
      setError(`上下文必须是 ${MIN_CONTEXT_TOKENS}–${formatNumber(MAX_CONTEXT_TOKENS)} 之间的整数。`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onLoad({ contextSize: tokens, kvCache })
      onClose()
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setSaving(false)
    }
  }

  const input =
    'h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-ink placeholder:font-sans focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20'
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="load-model-dialog-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 id="load-model-dialog-title" className="text-base font-semibold text-ink">
              加载本地模型
            </h2>
            <p className="mt-1 break-all text-sm text-muted">{model.id}</p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <div>
              <label htmlFor="load-model-context" className="mb-1.5 block text-sm font-medium text-ink">
                上下文长度（token）
              </label>
              <div className="flex gap-2">
                <select
                  value={selectedPreset ?? 'custom'}
                  onChange={(event) => {
                    if (event.target.value === 'custom') return
                    setContext(event.target.value)
                    setError(null)
                  }}
                  className="h-10 w-40 shrink-0 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
                >
                  {presets.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                  <option value="custom">自定义</option>
                </select>
                <input
                  ref={firstField}
                  id="load-model-context"
                  inputMode="numeric"
                  value={context}
                  onChange={(event) => {
                    setContext(event.target.value)
                    setError(null)
                  }}
                  className={`${input} min-w-0 flex-1`}
                />
              </div>
              <p className="mt-1 text-xs text-muted">
                训练上下文：{trained === null ? '未知（无法自动启用 YaRN）' : formatContextLength(trained)}
                {trained !== null ? '；超过训练长度时自动启用 YaRN。' : '；超过训练长度可能被截断或降质。'}
              </p>
            </div>

            <div>
              <label htmlFor="load-model-kv" className="mb-1.5 block text-sm font-medium text-ink">
                KV 缓存精度
              </label>
              <select
                id="load-model-kv"
                value={kvCache}
                onChange={(event) => setKvCache(event.target.value as KvCacheType)}
                className="h-10 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              >
                {KV_OPTIONS.filter((option) => KV_CACHE_TYPES.includes(option.value)).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1 rounded-md border border-line bg-canvas/60 px-3 py-2 text-xs text-muted">
              <p>模型权重：{gib(model.sizeBytes)}</p>
              <p>KV 缓存预估：{kvBytes === null ? '未知（GGUF 头未提供注意力参数）' : gib(kvBytes)}</p>
              <p>
                总占用预估：{gib(totalBytes)}
                {vramTotal !== null ? ` / 显存 ${gib(vramTotal)}` : '；显存总量未知'}
              </p>
              {overVram ? (
                <p className="font-medium text-red-700">预估占用超过总显存，加载可能失败；可降低上下文、换 q4_0 或换更小的模型。</p>
              ) : null}
              {ropeScale !== null ? (
                <p>将自动启用 YaRN ×{Number(ropeScale.toFixed(4))}：超出训练长度，长文精度可能下降。</p>
              ) : null}
              {kvCache !== 'f16' ? <p>量化 KV 会启用 Flash Attention（Vulkan 上 prefill 较慢）。</p> : null}
            </div>

            {error ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            ) : null}
          </div>

          <footer className="flex justify-end gap-2 border-t border-line px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 items-center rounded-lg border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-neutral-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-white disabled:opacity-60"
            >
              {saving ? '加载中…' : '加载'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}