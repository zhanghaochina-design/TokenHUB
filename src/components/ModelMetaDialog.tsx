import { useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import type { AppState, EffectiveModelMeta, ModelMeta, ModelThinkingMeta } from '../../core/types'
import { builtinModelMeta, effectiveModelMeta, MODEL_META_AS_OF } from '../../core/providers/modelMeta'
import { describeMeta, errorMessage, splitModels } from '../lib/format'

interface ModelMetaDialogProps {
  provider: AppState['providers'][number]
  upstreamModel: string
  onClose: () => void
  onSave: (meta: ModelMeta | null) => Promise<void>
}

type VisionChoice = 'unknown' | 'true' | 'false'
type ThinkingChoice = 'unknown' | 'none' | 'builtin' | 'custom'

function asEffective(meta: ModelMeta | null | undefined): EffectiveModelMeta {
  return {
    contextLength: meta?.contextLength ?? null,
    vision: meta?.vision ?? null,
    thinking: meta?.thinking ?? null
  }
}

function thinkingChoiceOf(thinking: ModelThinkingMeta | null): ThinkingChoice {
  if (!thinking) return 'unknown'
  if (thinking.param === 'none') return 'none'
  if (thinking.param === 'builtin') return 'builtin'
  return 'custom'
}

export function ModelMetaDialog({ provider, upstreamModel, onClose, onSave }: ModelMetaDialogProps) {
  const initial = useMemo(() => effectiveModelMeta(provider, upstreamModel), [provider, upstreamModel])
  const builtin = useMemo(() => builtinModelMeta(upstreamModel), [upstreamModel])
  const discovered = provider.modelDiscovery?.[upstreamModel]

  const [context, setContext] = useState(initial.contextLength === null ? '' : String(initial.contextLength))
  const [vision, setVision] = useState<VisionChoice>(
    initial.vision === null ? 'unknown' : initial.vision ? 'true' : 'false'
  )
  const [thinkingChoice, setThinkingChoice] = useState<ThinkingChoice>(thinkingChoiceOf(initial.thinking))
  const [param, setParam] = useState(initial.thinking && thinkingChoiceOf(initial.thinking) === 'custom' ? initial.thinking.param : '')
  const [values, setValues] = useState(
    initial.thinking && thinkingChoiceOf(initial.thinking) === 'custom' ? initial.thinking.values.join(', ') : ''
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const firstField = useRef<HTMLInputElement>(null)

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

  function buildMeta(): ModelMeta | null {
    const trimmed = context.trim()
    let contextLength: number | null = null
    if (trimmed) {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError('上下文长度必须是正整数（单位 token），或留空表示未标注。')
        return null
      }
      contextLength = Math.floor(parsed)
    }
    if (thinkingChoice === 'custom' && !param.trim()) {
      setError('自定义思考参数时必须填写原生参数名。')
      return null
    }
    const thinking: ModelThinkingMeta | null =
      thinkingChoice === 'unknown'
        ? null
        : thinkingChoice === 'none'
          ? { param: 'none', values: [] }
          : thinkingChoice === 'builtin'
            ? { param: 'builtin', values: [] }
            : { param: param.trim(), values: splitModels(values) }
    return {
      contextLength,
      vision: vision === 'unknown' ? null : vision === 'true',
      thinking
    }
  }

  async function submit(meta: ModelMeta | null) {
    setSaving(true)
    setError(null)
    try {
      await onSave(meta)
      onClose()
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const meta = buildMeta()
    if (meta) void submit(meta)
  }

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
        aria-labelledby="model-meta-dialog-title"
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 id="model-meta-dialog-title" className="text-base font-semibold text-ink">
              编辑模型元数据
            </h2>
            <p className="mt-1 break-all text-sm text-muted">
              {provider.name} · <span className="font-mono">{upstreamModel}</span>
            </p>
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

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <div className="space-y-1 rounded-md border border-line bg-canvas/60 px-3 py-2 text-xs text-muted">
              {discovered ? (
                <p>上游发现：{describeMeta(asEffective(discovered))}</p>
              ) : (
                <p>上游未提供能力字段。</p>
              )}
              {builtin ? (
                <p>
                  内置建议（{MODEL_META_AS_OF}）：{describeMeta(asEffective(builtin))}。仅为参考，以供应商文档为准。
                </p>
              ) : (
                <p>没有内置建议，请按供应商文档填写。</p>
              )}
              <p>手动覆盖优先于上游发现与内置建议。</p>
            </div>

            <div>
              <label htmlFor="model-meta-context" className="mb-1.5 block text-sm font-medium text-ink">
                上下文长度
              </label>
              <input
                ref={firstField}
                id="model-meta-context"
                inputMode="numeric"
                value={context}
                onChange={(event) => {
                  setContext(event.target.value)
                  setError(null)
                }}
                placeholder="token 数，如 200000；留空表示未标注"
                className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-ink placeholder:font-sans placeholder:text-neutral-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
            </div>

            <div>
              <label htmlFor="model-meta-vision" className="mb-1.5 block text-sm font-medium text-ink">
                视觉支持
              </label>
              <select
                id="model-meta-vision"
                value={vision}
                onChange={(event) => setVision(event.target.value as VisionChoice)}
                className="h-10 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              >
                <option value="unknown">未标注</option>
                <option value="true">支持图片输入</option>
                <option value="false">不支持图片输入</option>
              </select>
            </div>

            <div>
              <label htmlFor="model-meta-thinking" className="mb-1.5 block text-sm font-medium text-ink">
                思考参数
              </label>
              <select
                id="model-meta-thinking"
                value={thinkingChoice}
                onChange={(event) => {
                  setThinkingChoice(event.target.value as ThinkingChoice)
                  setError(null)
                }}
                className="h-10 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              >
                <option value="unknown">未标注</option>
                <option value="none">无参数化思考</option>
                <option value="builtin">模型内置推理（无参数）</option>
                <option value="custom">自定义原生参数</option>
              </select>
              <p className="mt-1 text-xs text-muted">网关只透传原生参数，不做档位换算。</p>

              {thinkingChoice === 'custom' && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="model-meta-param" className="mb-1.5 block text-xs font-medium text-ink">
                      原生参数名
                    </label>
                    <input
                      id="model-meta-param"
                      value={param}
                      onChange={(event) => {
                        setParam(event.target.value)
                        setError(null)
                      }}
                      placeholder="如 reasoning_effort"
                      className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-ink placeholder:font-sans placeholder:text-neutral-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
                    />
                  </div>
                  <div>
                    <label htmlFor="model-meta-values" className="mb-1.5 block text-xs font-medium text-ink">
                      可选值
                    </label>
                    <input
                      id="model-meta-values"
                      value={values}
                      onChange={(event) => setValues(event.target.value)}
                      placeholder="如 low, medium, high"
                      className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-ink placeholder:font-sans placeholder:text-neutral-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
                    />
                  </div>
                </div>
              )}
            </div>

            {error && (
              <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-6 py-4">
            <button
              type="button"
              disabled={saving || !provider.modelMeta?.[upstreamModel]}
              onClick={() => void submit(null)}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              恢复自动值
            </button>
            <div className="flex items-center gap-2">
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
                className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? '保存中…' : '保存元数据'}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  )
}