import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import type { AppState, ModelAlias } from '../../core/types'
import { errorMessage } from '../lib/format'

interface ModelAliasDialogProps {
  providers: AppState['providers']
  aliases: ModelAlias[]
  initial: ModelAlias | null
  onClose: () => void
  onSave: (alias: ModelAlias, previousId?: string) => Promise<void>
}

interface TargetRow {
  providerId: string
  upstreamModel: string
}

function uniqueModels(provider: AppState['providers'][number] | undefined): string[] {
  return provider ? [...new Set([...provider.models.cached, ...provider.models.manual])].sort() : []
}

export function ModelAliasDialog({ providers, aliases, initial, onClose, onSave }: ModelAliasDialogProps) {
  const [aliasId, setAliasId] = useState(initial?.id ?? '')
  const [targets, setTargets] = useState<TargetRow[]>(
    initial?.targets.length ? initial.targets.map((target) => ({ ...target })) : [{ providerId: providers[0]?.id ?? '', upstreamModel: '' }]
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const firstField = useRef<HTMLInputElement>(null)
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers])
  const usedProviders = new Set(targets.map((target) => target.providerId).filter(Boolean))

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

  const duplicateId = Boolean(aliasId.trim()) && aliases.some((alias) => alias.id === aliasId.trim() && alias.id !== initial?.id)
  const sameNameModels = aliasId.trim()
    ? providers.flatMap((provider) =>
        uniqueModels(provider)
          .filter((model) => model === aliasId.trim())
          .map((model) => `${provider.name}: ${model}`)
      )
    : []
  const missingTargets = targets.flatMap((target) => {
    const provider = providerById.get(target.providerId)
    if (!provider || !target.upstreamModel.trim()) return []
    return uniqueModels(provider).includes(target.upstreamModel.trim()) ? [] : [`${provider.name}: ${target.upstreamModel.trim()}`]
  })

  function updateTarget(index: number, patch: Partial<TargetRow>) {
    setTargets((current) => current.map((target, i) => (i === index ? { ...target, ...patch } : target)))
    setError(null)
  }

  function addTarget() {
    const next = providers.find((provider) => !usedProviders.has(provider.id))
    if (!next) {
      setError('没有可添加的供应商；同一供应商只能有一个目标。')
      return
    }
    setTargets((current) => [...current, { providerId: next.id, upstreamModel: '' }])
    setError(null)
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const id = aliasId.trim()
    if (!id) {
      setError('统一模型 ID 不能为空。')
      return
    }
    if (duplicateId) {
      setError(`统一模型 ID 已存在：${id}`)
      return
    }
    const cleaned = targets
      .map((target) => ({ providerId: target.providerId.trim(), upstreamModel: target.upstreamModel.trim() }))
      .filter((target) => target.providerId && target.upstreamModel)
    if (cleaned.length === 0) {
      setError('至少需要一个供应商目标。')
      return
    }
    if (new Set(cleaned.map((target) => target.providerId)).size !== cleaned.length) {
      setError('同一供应商只能有一个上游模型目标。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave({ id, targets: cleaned }, initial?.id)
      onClose()
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30 p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="alias-dialog-title" className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 id="alias-dialog-title" className="text-base font-semibold text-ink">{initial ? '编辑统一模型' : '添加统一模型'}</h2>
            <p className="mt-1 text-sm text-muted">Agent 使用统一 ID；TokenHUB 按供应商优先级转发到各自的上游模型 ID。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-neutral-100 hover:text-ink">
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={(event) => void handleSubmit(event)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <div>
              <label htmlFor="alias-id" className="mb-1.5 block text-sm font-medium text-ink">统一模型 ID</label>
              <input
                ref={firstField}
                id="alias-id"
                value={aliasId}
                onChange={(event) => { setAliasId(event.target.value); setError(null) }}
                aria-invalid={duplicateId || undefined}
                placeholder="例如 deepseek4.1flash"
                className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-ink placeholder:font-sans placeholder:text-neutral-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
              <p className="mt-1 text-xs text-muted">这是 Agent 里填写的模型名；建议使用简短、稳定的本地名称。</p>
              {duplicateId && <p className="mt-1 text-xs text-red-700">该统一 ID 已存在。</p>}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-ink">供应商目标</span>
                <button type="button" onClick={addTarget} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-ink transition-colors hover:bg-neutral-50">
                  <Plus className="size-3.5" aria-hidden="true" />
                  添加目标
                </button>
              </div>
              <div className="space-y-2">
                {targets.map((target, index) => {
                  const provider = providerById.get(target.providerId)
                  const models = uniqueModels(provider)
                  return (
                    <div key={index} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto] items-start gap-2">
                      <div>
                        <label htmlFor={`alias-provider-${index}`} className="sr-only">目标供应商 {index + 1}</label>
                        <select
                          id={`alias-provider-${index}`}
                          aria-label={`目标供应商 ${index + 1}`}
                          value={target.providerId}
                          onChange={(event) => updateTarget(index, { providerId: event.target.value })}
                          className="h-10 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
                        >
                          {providers.map((option) => (
                            <option key={option.id} value={option.id} disabled={option.id !== target.providerId && usedProviders.has(option.id)}>
                              {option.name}{option.enabled ? '' : '（已禁用）'}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`alias-model-${index}`} className="sr-only">上游模型 {index + 1}</label>
                        <input
                          id={`alias-model-${index}`}
                          aria-label={`上游模型 ${index + 1}`}
                          list={`alias-model-options-${index}`}
                          value={target.upstreamModel}
                          onChange={(event) => updateTarget(index, { upstreamModel: event.target.value })}
                          placeholder={models[0] ?? '输入或选择上游模型 ID'}
                          className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-ink placeholder:font-sans placeholder:text-neutral-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
                        />
                        <datalist id={`alias-model-options-${index}`}>
                          {models.map((model) => <option key={model} value={model} />)}
                        </datalist>
                      </div>
                      <button
                        type="button"
                        aria-label={`删除目标 ${index + 1}`}
                        onClick={() => { setTargets((current) => current.filter((_, i) => i !== index)); setError(null) }}
                        disabled={targets.length === 1}
                        className="flex size-10 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                  )
                })}
              </div>
              {sameNameModels.length > 0 && (
                <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  统一 ID 与以下原始模型同名：{sameNameModels.join('；')}。显式映射优先，其余同名供应商会自动纳入。
                </p>
              )}
              {missingTargets.length > 0 && (
                <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  以下目标不在供应商当前模型列表中，仍会按显式映射尝试：{missingTargets.join('；')}
                </p>
              )}
            </div>

            {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">
            <button type="button" onClick={onClose} className="inline-flex h-10 items-center rounded-lg border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-neutral-50">取消</button>
            <button type="submit" disabled={saving} className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60">
              {saving ? '保存中…' : '保存统一模型'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
