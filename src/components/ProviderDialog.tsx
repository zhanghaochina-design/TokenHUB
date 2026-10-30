import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Loader2, PlugZap, X } from 'lucide-react'
import { PROVIDER_PRESETS } from '../../core/providers/presets'
import type { ProviderInput, ProviderPatch, TestResult } from '../../core/ipc-types'
import type { Preset, ProviderConfig, QuotaAdapterId } from '../../core/types'
import { describeQuota, errorMessage, quotaHours, splitModels } from '../lib/format'

type ProviderWithKey = ProviderConfig & { hasKey: boolean }

interface ProviderDialogProps {
  // null 表示新建；传入配置表示编辑。
  provider: ProviderWithKey | null
  onClose: () => void
  onError: (message: string) => void
}

interface FormState {
  preset: Preset
  name: string
  baseUrl: string
  apiKey: string
  quotaAdapter: QuotaAdapterId
  lowBalance: string
  cooldownHours: string
  injectStreamUsage: boolean
  manualModels: string
}

type FieldErrors = Partial<Record<'name' | 'baseUrl' | 'apiKey' | 'lowBalance' | 'cooldown', string>>

const QUOTA_ADAPTERS: Array<{ value: QuotaAdapterId; label: string }> = [
  { value: 'none', label: '不查询额度' },
  { value: 'opencode-go', label: 'OpenCode Go 额度接口' },
  { value: 'deepseek-balance', label: 'DeepSeek 余额接口' },
  { value: 'commandcode-usage', label: 'CommandCode 套餐接口' }
]

const INPUT_CLASS =
  'h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-neutral-500 transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20'
const INPUT_ERROR_CLASS = 'border-red-400 focus:border-red-500 focus:ring-red-500/20'
const LABEL_CLASS = 'mb-1.5 block text-sm font-medium text-ink'
const HINT_CLASS = 'mt-1.5 text-xs leading-5 text-muted'
const ERROR_CLASS = 'mt-1.5 text-xs text-red-600'

function initialForm(provider: ProviderWithKey | null): FormState {
  if (!provider) {
    return {
      preset: 'custom',
      name: '',
      baseUrl: '',
      apiKey: '',
      quotaAdapter: 'none',
      lowBalance: '0.5',
      cooldownHours: '5',
      injectStreamUsage: true,
      manualModels: ''
    }
  }
  return {
    preset: provider.preset,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: '',
    quotaAdapter: provider.quotaAdapter,
    lowBalance: String(provider.quota.lowBalanceThreshold),
    cooldownHours: quotaHours(provider.quota.quotaCooldownMs),
    // 自动关闭后必须能在这里重新打开，否则只能手改 config.json。
    injectStreamUsage: provider.quota.injectStreamUsage,
    manualModels: provider.models.manual.join(', ')
  }
}

function baseUrlError(raw: string): string | undefined {
  const baseUrl = raw.trim()
  if (!baseUrl) return '请输入 Base URL'
  // 与 Hub 的校验保持一致：只允许 https，本机回环可用明文 http。
  const https = /^https:\/\/[^\s/]+/i.test(baseUrl)
  const localHttp = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(baseUrl)
  if (!https && !localHttp) return 'Base URL 必须使用 https://（本机地址可用 http://127.0.0.1）'
  return undefined
}

function parseNonNegative(raw: string): number | null {
  if (raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function buildInput(form: FormState): ProviderInput {
  const lowBalance = parseNonNegative(form.lowBalance) ?? 0
  const cooldownHours = parseNonNegative(form.cooldownHours) ?? 0
  return {
    preset: form.preset,
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    quotaAdapter: form.quotaAdapter,
    quota: {
      lowBalanceThreshold: lowBalance,
      quotaCooldownMs: Math.round(cooldownHours * 3_600_000),
      injectStreamUsage: form.injectStreamUsage
    },
    manualModels: splitModels(form.manualModels)
  }
}

export function ProviderDialog({ provider, onClose, onError }: ProviderDialogProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const baseUrlRef = useRef<HTMLInputElement>(null)
  const apiKeyRef = useRef<HTMLInputElement>(null)
  const lowBalanceRef = useRef<HTMLInputElement>(null)
  const cooldownRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const [form, setForm] = useState<FormState>(() => initialForm(provider))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  const editing = provider !== null

  // 焦点陷阱、Esc 关闭与滚动锁定；组件卸载时恢复焦点。
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const panel = panelRef.current
    const firstField = panel?.querySelector<HTMLElement>('input, select, textarea')
    firstField?.focus()

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.getClientRects().length > 0)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = bodyOverflow
      previous?.focus()
    }
  }, [])

  function clearError(key: keyof FieldErrors) {
    setErrors((previous) => {
      if (!(key in previous)) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  function updateField<K extends keyof FormState>(key: K, value: FormState[K], errorKey?: keyof FieldErrors) {
    setForm((previous) => ({ ...previous, [key]: value }))
    setTestResult(null)
    if (errorKey) clearError(errorKey)
  }

  function applyPreset(preset: Preset) {
    const found = PROVIDER_PRESETS.find((item) => item.preset === preset)
    setForm((previous) => {
      const previousPresetName = PROVIDER_PRESETS.find((item) => item.preset === previous.preset)?.name
      const nameCanBeReplaced = !previous.name.trim() || previous.name === previousPresetName
      let name = previous.name
      if (found && nameCanBeReplaced) name = found.name
      if (!found && nameCanBeReplaced) name = ''
      return {
        ...previous,
        preset,
        name,
        baseUrl: found ? found.baseUrl : '',
        quotaAdapter: found ? found.quotaAdapter : 'none'
      }
    })
    clearError('baseUrl')
    clearError('name')
    setTestResult(null)
  }

  function validate(): FieldErrors {
    const next: FieldErrors = {}
    if (!form.name.trim()) next.name = '请输入供应商名称'
    const urlError = baseUrlError(form.baseUrl)
    if (urlError) next.baseUrl = urlError
    if (!editing && !form.apiKey.trim()) next.apiKey = '新建供应商时必须填写 API Key'
    if (parseNonNegative(form.lowBalance) === null) next.lowBalance = '请输入不小于 0 的数字'
    if (parseNonNegative(form.cooldownHours) === null) next.cooldown = '请输入不小于 0 的小时数'
    return next
  }

  function focusFirstError(nextErrors: FieldErrors) {
    if (nextErrors.name) nameRef.current?.focus()
    else if (nextErrors.baseUrl) baseUrlRef.current?.focus()
    else if (nextErrors.apiKey) apiKeyRef.current?.focus()
    else if (nextErrors.lowBalance) lowBalanceRef.current?.focus()
    else if (nextErrors.cooldown) cooldownRef.current?.focus()
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextErrors = validate()
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      focusFirstError(nextErrors)
      return
    }

    const input = buildInput(form)
    // 先关闭再等待：离线时模型发现可能耗时十几秒，不能卡住对话框。
    onClose()
    if (provider) {
      const patch: ProviderPatch = {
        name: input.name,
        baseUrl: input.baseUrl,
        quotaAdapter: input.quotaAdapter,
        quota: input.quota,
        manualModels: input.manualModels
      }
      // 留空表示沿用已保存的 Key，绝不把空串写回。
      if (input.apiKey) patch.apiKey = input.apiKey
      void window.tokenhub
        .updateProvider(provider.id, patch)
        .catch((error: unknown) => onError(`保存供应商失败：${errorMessage(error)}`))
      return
    }
    void window.tokenhub
      .addProvider(input)
      .catch((error: unknown) => onError(`添加供应商失败：${errorMessage(error)}`))
  }

  async function handleTest() {
    const urlError = baseUrlError(form.baseUrl)
    if (urlError) {
      setErrors((previous) => ({ ...previous, baseUrl: urlError }))
      baseUrlRef.current?.focus()
      return
    }
    setErrors((previous) => {
      if (!('baseUrl' in previous)) return previous
      const next = { ...previous }
      delete next.baseUrl
      return next
    })
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.tokenhub.testProvider(buildInput(form), provider?.id)
      setTestResult(result)
    } catch (error) {
      setTestResult({ models: [], quota: null, error: errorMessage(error) })
    } finally {
      setTesting(false)
    }
  }

  const quotaSummary = testResult ? describeQuota(testResult.quota) : ''

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-6">
      <div className="fixed inset-0 bg-slate-950/40" aria-hidden="true" onMouseDown={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[calc(100vh-48px)] w-full max-w-[640px] flex-col rounded-xl border border-line bg-surface shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">
              {editing ? '编辑供应商' : '添加供应商'}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {editing ? '留空的 API Key 表示沿用已保存的密钥。' : '选择预设可自动填好地址与额度适配器。'}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭对话框"
            onClick={onClose}
            className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[220px_minmax(0,1fr)]">
              <div>
                <label htmlFor={`${titleId}-preset`} className={LABEL_CLASS}>
                  预设
                </label>
                <select
                  id={`${titleId}-preset`}
                  aria-label="预设"
                  value={form.preset}
                  onChange={(event) => applyPreset(event.target.value as Preset)}
                  className={INPUT_CLASS}
                >
                  {PROVIDER_PRESETS.map((preset) => (
                    <option key={preset.preset} value={preset.preset}>
                      {preset.name}
                    </option>
                  ))}
                  <option value="custom">自定义</option>
                </select>
              </div>
              <div>
                <label htmlFor={`${titleId}-name`} className={LABEL_CLASS}>
                  名称
                </label>
                <input
                  id={`${titleId}-name`}
                  ref={nameRef}
                  value={form.name}
                  onChange={(event) => updateField('name', event.target.value, 'name')}
                  aria-invalid={errors.name ? true : undefined}
                  aria-describedby={errors.name ? `${titleId}-name-error` : undefined}
                  placeholder="例如：OpenCode Go"
                  className={`${INPUT_CLASS} ${errors.name ? INPUT_ERROR_CLASS : ''}`}
                />
                {errors.name && (
                  <p id={`${titleId}-name-error`} className={ERROR_CLASS}>
                    {errors.name}
                  </p>
                )}
              </div>
            </div>

            <div>
              <label htmlFor={`${titleId}-base-url`} className={LABEL_CLASS}>
                Base URL
              </label>
              <input
                id={`${titleId}-base-url`}
                ref={baseUrlRef}
                type="url"
                value={form.baseUrl}
                onChange={(event) => updateField('baseUrl', event.target.value, 'baseUrl')}
                aria-invalid={errors.baseUrl ? true : undefined}
                aria-describedby={`${titleId}-base-url-hint${errors.baseUrl ? ` ${titleId}-base-url-error` : ''}`}
                placeholder="https://example.com/v1"
                spellCheck={false}
                className={`${INPUT_CLASS} ${errors.baseUrl ? INPUT_ERROR_CLASS : ''}`}
              />
              <p id={`${titleId}-base-url-hint`} className={HINT_CLASS}>
                不要包含 /chat/completions；仅允许 https，本机地址可用 http://127.0.0.1。
              </p>
              {errors.baseUrl && (
                <p id={`${titleId}-base-url-error`} className={ERROR_CLASS}>
                  {errors.baseUrl}
                </p>
              )}
            </div>

            <div>
              <label htmlFor={`${titleId}-api-key`} className={LABEL_CLASS}>
                API Key
              </label>
              <input
                id={`${titleId}-api-key`}
                ref={apiKeyRef}
                type="password"
                value={form.apiKey}
                onChange={(event) => updateField('apiKey', event.target.value, 'apiKey')}
                aria-label="API Key"
                aria-invalid={errors.apiKey ? true : undefined}
                aria-describedby={`${titleId}-api-key-hint${errors.apiKey ? ` ${titleId}-api-key-error` : ''}`}
                placeholder={editing ? '留空则不修改' : 'sk-…'}
                autoComplete="off"
                spellCheck={false}
                className={`${INPUT_CLASS} ${errors.apiKey ? INPUT_ERROR_CLASS : ''}`}
              />
              <p id={`${titleId}-api-key-hint`} className={HINT_CLASS}>
                {editing
                  ? provider?.hasKey
                    ? '已保存 Key（仅显示状态，不回显内容）；留空保持不变。'
                    : '尚未保存 Key；填写后才会保存并启用鉴权。'
                  : 'Key 只保存在本机，使用系统加密存储，界面不会回显。'}
              </p>
              {errors.apiKey && (
                <p id={`${titleId}-api-key-error`} className={ERROR_CLASS}>
                  {errors.apiKey}
                </p>
              )}
            </div>

            <fieldset className="rounded-lg border border-line bg-canvas/60 p-4">
              <legend className="px-1 text-sm font-medium text-ink">额度与模型</legend>
              <div className="space-y-4">
                <div>
                  <label htmlFor={`${titleId}-adapter`} className={LABEL_CLASS}>
                    额度适配器
                  </label>
                  <select
                    id={`${titleId}-adapter`}
                    value={form.quotaAdapter}
                    onChange={(event) => updateField('quotaAdapter', event.target.value as QuotaAdapterId)}
                    className={INPUT_CLASS}
                  >
                    {QUOTA_ADAPTERS.map((adapter) => (
                      <option key={adapter.value} value={adapter.value}>
                        {adapter.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`${titleId}-low-balance`} className={LABEL_CLASS}>
                      低余额阈值
                    </label>
                    <input
                      id={`${titleId}-low-balance`}
                      ref={lowBalanceRef}
                      type="number"
                      min="0"
                      step="0.1"
                      value={form.lowBalance}
                      onChange={(event) => updateField('lowBalance', event.target.value, 'lowBalance')}
                      aria-invalid={errors.lowBalance ? true : undefined}
                      aria-describedby={`${titleId}-low-balance-hint${errors.lowBalance ? ` ${titleId}-low-balance-error` : ''}`}
                      className={`${INPUT_CLASS} ${errors.lowBalance ? INPUT_ERROR_CLASS : ''}`}
                    />
                    <p id={`${titleId}-low-balance-hint`} className={HINT_CLASS}>
                      DeepSeek 余额低于该值时视为耗尽。
                    </p>
                    {errors.lowBalance && (
                      <p id={`${titleId}-low-balance-error`} className={ERROR_CLASS}>
                        {errors.lowBalance}
                      </p>
                    )}
                  </div>
                  <div>
                    <label htmlFor={`${titleId}-cooldown`} className={LABEL_CLASS}>
                      额度冷却（小时）
                    </label>
                    <input
                      id={`${titleId}-cooldown`}
                      ref={cooldownRef}
                      type="number"
                      min="0"
                      step="0.5"
                      value={form.cooldownHours}
                      onChange={(event) => updateField('cooldownHours', event.target.value, 'cooldown')}
                      aria-invalid={errors.cooldown ? true : undefined}
                      aria-describedby={`${titleId}-cooldown-hint${errors.cooldown ? ` ${titleId}-cooldown-error` : ''}`}
                      className={`${INPUT_CLASS} ${errors.cooldown ? INPUT_ERROR_CLASS : ''}`}
                    />
                    <p id={`${titleId}-cooldown-hint`} className={HINT_CLASS}>
                      无额度接口时，耗尽后的冷却时长。
                    </p>
                    {errors.cooldown && (
                      <p id={`${titleId}-cooldown-error`} className={ERROR_CLASS}>
                        {errors.cooldown}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-start justify-between gap-4 rounded-md bg-surface px-3 py-2.5 ring-1 ring-inset ring-line">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">流式请求注入 usage</p>
                    <p id={`${titleId}-inject-hint`} className="mt-0.5 text-xs leading-5 text-muted">
                      流式请求会附带 stream_options.include_usage，历史记录才能统计 token 用量。上游返回 400 时会自动关闭，可在这里重新开启。
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={form.injectStreamUsage}
                    aria-label="流式请求注入 usage"
                    aria-describedby={`${titleId}-inject-hint`}
                    onClick={() => updateField('injectStreamUsage', !form.injectStreamUsage)}
                    className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors ${
                      form.injectStreamUsage ? 'bg-accent' : 'bg-neutral-400'
                    }`}
                  >
                    <span
                      className={`size-5 rounded-full bg-white shadow-sm transition-transform ${
                        form.injectStreamUsage ? 'translate-x-4' : 'translate-x-0'
                      }`}
                      aria-hidden="true"
                    />
                  </button>
                </div>

                <div>
                  <label htmlFor={`${titleId}-manual-models`} className={LABEL_CLASS}>
                    手动模型
                  </label>
                  <input
                    id={`${titleId}-manual-models`}
                    value={form.manualModels}
                    onChange={(event) => updateField('manualModels', event.target.value)}
                    placeholder="glm-5.1, deepseek-chat"
                    spellCheck={false}
                    aria-describedby={`${titleId}-manual-models-hint`}
                    className={`${INPUT_CLASS} font-mono text-xs`}
                  />
                  <p id={`${titleId}-manual-models-hint`} className={HINT_CLASS}>
                    多个模型用逗号分隔；留空则只使用自动发现结果。
                  </p>
                </div>
              </div>
            </fieldset>

            {testResult && (
              <div aria-live="polite" className="rounded-lg border border-line bg-canvas/60 p-4 text-sm">
                <p className="font-medium text-ink">连接测试</p>
                <p className={`mt-1 ${testResult.error ? 'text-red-600' : 'text-emerald-700'}`}>
                  {testResult.error ?? '连接成功'}
                </p>
                <p className="mt-1 text-muted">
                  发现 {testResult.models.length} 个模型
                  {testResult.quota ? ` · 额度：${quotaSummary || '无可用数据'}` : ''}
                </p>
                {testResult.models.length > 0 && (
                  <div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                    {testResult.models.map((model) => (
                      <span
                        key={model}
                        className="rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-xs text-ink"
                      >
                        {model}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testing}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium text-ink transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {testing ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <PlugZap className="size-4" aria-hidden="true" />
              )}
              {testing ? '测试中…' : '测试连接'}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-10 items-center rounded-lg px-3.5 text-sm font-medium text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
              >
                取消
              </button>
              <button
                type="submit"
                className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-white transition-colors hover:bg-accent-strong"
              >
                保存
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  )
}
