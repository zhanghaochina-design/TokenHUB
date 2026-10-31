import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import type { UpdateState } from '../../core/ipc-types'
import type { AppState, Settings } from '../../core/types'
import { Toast } from '../components/Toast'
import { errorMessage } from '../lib/format'
import { useUpdateState } from '../lib/useUpdateState'

interface SettingsPageProps {
  state: AppState
}

const INPUT_CLASS =
  'h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-neutral-500 transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60'
const LABEL_CLASS = 'mb-1.5 block text-sm font-medium text-ink'
const HINT_CLASS = 'mt-1.5 text-xs leading-5 text-muted'
const ERROR_CLASS = 'mt-1.5 text-xs text-red-600'
const PRIMARY_BUTTON =
  'inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60'
const SECONDARY_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60'
const DANGER_BUTTON =
  'inline-flex h-9 items-center rounded-lg border border-red-200 bg-surface px-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60'

function Toggle({
  id,
  label,
  checked,
  disabled,
  onChange
}: {
  id: string
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-accent' : 'bg-neutral-400'
      }`}
    >
      <span
        className={`size-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}
        aria-hidden="true"
      />
    </button>
  )
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  id: string
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted">{description}</p>
      </div>
      <Toggle id={id} label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  )
}

function Card({
  id,
  title,
  description,
  children,
  className
}: {
  id: string
  title: string
  description: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      aria-labelledby={id}
      className={`rounded-lg border border-line bg-surface p-5 shadow-sm ${className ?? ''}`}
    >
      <h2 id={id} className="text-sm font-semibold text-ink">
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  )
}

export function SettingsPage({ state }: SettingsPageProps) {
  const settings = state.settings
  const [portInput, setPortInput] = useState(() => String(settings.port))
  const [quotaInput, setQuotaInput] = useState(() => String(settings.quotaRefreshSec))
  const [portError, setPortError] = useState<string | null>(null)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [keyPending, setKeyPending] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const keyInputRef = useRef<HTMLInputElement>(null)
  const update = useUpdateState()
  const updateBusy = update?.phase === 'checking' || update?.phase === 'downloading'
  const updateDisabled = !update || update.phase === 'disabled'

  // 只跟随已保存的值同步，用户正在输入时不会被无关的状态推送覆盖。
  useEffect(() => {
    setPortInput(String(settings.port))
  }, [settings.port])
  useEffect(() => {
    setQuotaInput(String(settings.quotaRefreshSec))
  }, [settings.quotaRefreshSec])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4_000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), 2_000)
    return () => window.clearTimeout(timer)
  }, [copied])

  const localKeyEnabled = settings.localKeyEnabled
  const listeningPort = state.server.running && state.server.port > 0 ? state.server.port : settings.port
  const openaiUrl = `http://127.0.0.1:${listeningPort}/v1`
  const anthropicUrl = `http://127.0.0.1:${listeningPort}`

  function flash(message: string) {
    setNotice(message)
  }

  async function savePort() {
    const value = Number(portInput)
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      setPortError('端口必须是 1-65535 之间的整数。')
      return
    }
    const wasRunning = state.server.running
    // 服务未启动时允许重复提交同一端口：这是启动失败后唯一的恢复入口。
    if (value === settings.port && wasRunning) {
      setPortError(null)
      flash('端口未变化。')
      return
    }
    setPortError(null)
    setPending(true)
    try {
      await window.tokenhub.updateSettings({ port: value })
      flash(wasRunning ? `端口已切换为 ${value}，旧端口已停止监听。` : `服务已在端口 ${value} 启动。`)
    } catch (error) {
      const message = errorMessage(error)
      const occupied = /EADDRINUSE|address already in use/i.test(message)
      setPortError(
        wasRunning
          ? occupied
            ? `端口 ${value} 已被占用，服务仍在旧端口 ${listeningPort} 运行。`
            : `端口切换失败：${message}。服务仍在旧端口 ${listeningPort} 运行。`
          : occupied
            ? `端口 ${value} 已被占用，请换一个端口后重试。`
            : `服务启动失败：${message}`
      )
    } finally {
      setPending(false)
    }
  }

  async function saveQuotaRefresh() {
    const value = Number(quotaInput)
    if (!Number.isInteger(value) || value < 10 || value > 3600) {
      setQuotaError('额度刷新间隔必须是 10-3600 秒之间的整数。')
      return
    }
    setQuotaError(null)
    setPending(true)
    try {
      await window.tokenhub.updateSettings({ quotaRefreshSec: value })
      flash(`额度刷新间隔已保存为 ${value} 秒。`)
    } catch (error) {
      setQuotaError(`保存刷新间隔失败：${errorMessage(error)}`)
    } finally {
      setPending(false)
    }
  }

  async function saveToggle(patch: Partial<Settings>, label: string) {
    setPending(true)
    try {
      await window.tokenhub.updateSettings(patch)
      flash(`${label}已保存。`)
    } catch (error) {
      setToast(`${label}保存失败：${errorMessage(error)}`)
    } finally {
      setPending(false)
    }
  }

  // 本地访问 Key 的唯一入口：开启/更换/清除都走 setLocalKey，绝不把 localKeyEnabled 塞进 updateSettings。
  async function applyLocalKey(next: string | null) {
    setKeyPending(true)
    setKeyError(null)
    try {
      await window.tokenhub.setLocalKey(next)
      setKeyInput('')
      flash(next ? '本地访问 Key 已保存并启用。' : '本地访问 Key 已清除，/v1 不再校验 Key。')
    } catch (error) {
      setKeyError(`保存本地访问 Key 失败：${errorMessage(error)}`)
    } finally {
      setKeyPending(false)
    }
  }

  function handleLocalKeyToggle(next: boolean) {
    if (keyPending) return
    if (!next) {
      void applyLocalKey(null)
      return
    }
    const value = keyInput.trim()
    if (!value) {
      setKeyError('请先输入访问 Key，再启用本地访问保护。')
      keyInputRef.current?.focus()
      return
    }
    void applyLocalKey(value)
  }

  function saveKeyFromInput() {
    const value = keyInput.trim()
    if (!value) {
      setKeyError('请输入访问 Key。')
      keyInputRef.current?.focus()
      return
    }
    void applyLocalKey(value)
  }

  async function copyUrl(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
    } catch {
      setToast('复制失败，请手动选择并复制。')
    }
  }

  function updateStatus(state: UpdateState | null): string {
    if (!state) return '读取中'
    switch (state.phase) {
      case 'disabled':
        return '仅安装版'
      case 'idle':
        return '未检查'
      case 'checking':
        return '检查中'
      case 'up-to-date':
        return '已是最新'
      case 'available':
        return `发现 v${state.availableVersion ?? ''}`
      case 'downloading':
        return '下载中'
      case 'ready':
        return '等待重启'
      case 'error':
        return '检查失败'
      default:
        return '未知'
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
  }

  async function checkUpdates() {
    try {
      await window.tokenhub.checkForUpdates()
    } catch (error) {
      setToast(`检查更新失败：${errorMessage(error)}`)
    }
  }

  async function downloadUpdate() {
    try {
      await window.tokenhub.downloadUpdate()
    } catch (error) {
      setToast(`下载更新失败：${errorMessage(error)}`)
    }
  }

  async function installUpdate() {
    try {
      await window.tokenhub.installUpdate()
    } catch (error) {
      setToast(`安装更新失败：${errorMessage(error)}`)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">设置</h1>
        <p className="mt-1 text-sm text-muted">端口、访问控制、启动行为、日志保留与连接信息。</p>
        {notice && (
          <p role="status" className="mt-2 text-sm text-emerald-700">
            {notice}
          </p>
        )}
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          id="settings-port-heading"
          title="服务端口"
          description="本地服务的监听端口。修改后服务会立即在新端口重启。"
        >
          <div className="max-w-xs">
            {!state.server.running && (
              <div role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200">
                <p className="font-medium break-words">服务未启动：{state.server.error ?? '监听端口不可用'}</p>
                <p className="mt-0.5 text-xs leading-5">本地 Key 与供应商配置仍然保留；换一个可用端口保存即可恢复。</p>
              </div>
            )}
            <label htmlFor="settings-port" className={LABEL_CLASS}>
              端口
            </label>
            <input
              id="settings-port"
              type="number"
              min={1}
              max={65535}
              step={1}
              value={portInput}
              onChange={(event) => {
                setPortInput(event.target.value)
                setPortError(null)
              }}
              aria-invalid={portError ? true : undefined}
              aria-describedby={`settings-port-hint${portError ? ' settings-port-error' : ''}`}
              className={`${INPUT_CLASS} ${portError ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20' : ''}`}
            />
            <p id="settings-port-hint" className={HINT_CLASS}>
              1-65535。新端口启动失败时旧端口继续可用。
            </p>
            {portError && (
              <p id="settings-port-error" role="alert" className={ERROR_CLASS}>
                {portError}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void savePort()} disabled={pending} className={PRIMARY_BUTTON}>
                保存端口
              </button>
              <p className="text-xs text-muted">
                当前监听{' '}
                <span className="font-mono text-ink">
                  {state.server.running ? `http://127.0.0.1:${state.server.port}` : '服务未运行'}
                </span>
              </p>
            </div>
          </div>
        </Card>

        <Card
          id="settings-key-heading"
          title="本地访问 Key"
          description="启用后，/v1 请求必须携带 Authorization: Bearer 或 x-api-key，Key 只保存在本机且不会回显。"
        >
          <div className="flex items-center justify-between gap-4 rounded-md bg-canvas/60 px-3 py-2.5 ring-1 ring-inset ring-line">
            <p className="flex min-w-0 items-center gap-2 text-sm">
              <span
                className={`size-2 shrink-0 rounded-full ${localKeyEnabled ? 'bg-emerald-500' : 'bg-neutral-400'}`}
                aria-hidden="true"
              />
              <span className="font-medium text-ink">
                {localKeyEnabled ? '已启用：请求必须携带 Key' : '未启用：本机任何程序都可访问'}
              </span>
            </p>
            <Toggle
              id="settings-local-key-toggle"
              label="启用本地访问 Key"
              checked={localKeyEnabled}
              disabled={keyPending}
              onChange={handleLocalKeyToggle}
            />
          </div>

          <div className="mt-3">
            <label htmlFor="settings-local-key" className={LABEL_CLASS}>
              访问 Key
            </label>
            <input
              id="settings-local-key"
              ref={keyInputRef}
              type="password"
              value={keyInput}
              onChange={(event) => {
                setKeyInput(event.target.value)
                setKeyError(null)
              }}
              placeholder={localKeyEnabled ? '输入新 Key 可更换（不会回显）' : '输入 Key 以启用'}
              autoComplete="new-password"
              spellCheck={false}
              aria-invalid={keyError ? true : undefined}
              aria-describedby={`settings-local-key-hint${keyError ? ' settings-local-key-error' : ''}`}
              className={`${INPUT_CLASS} max-w-sm ${keyError ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20' : ''}`}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={saveKeyFromInput}
                disabled={keyPending || !keyInput.trim()}
                className={SECONDARY_BUTTON}
              >
                {keyPending ? '保存中…' : '保存 Key'}
              </button>
              <button
                type="button"
                onClick={() => void applyLocalKey(null)}
                disabled={keyPending || !localKeyEnabled}
                className={DANGER_BUTTON}
              >
                清除 Key
              </button>
            </div>
            <p id="settings-local-key-hint" className={HINT_CLASS}>
              开启开关需要先在输入框填写 Key；关闭开关或点「清除 Key」会立即停用本地鉴权。
            </p>
            {keyError && (
              <p id="settings-local-key-error" role="alert" className={ERROR_CLASS}>
                {keyError}
              </p>
            )}
          </div>
        </Card>

        <Card
          id="settings-startup-heading"
          title="启动与托盘"
          description="控制应用随系统启动、启动时的窗口状态，以及关闭窗口后的行为。"
        >
          <div className="divide-y divide-line">
            <ToggleRow
              id="settings-autostart"
              label="开机自启"
              description="登录 Windows 后自动启动 TokenHUB（仅安装版生效；开发与测试环境不写入系统启动项）。"
              checked={settings.autoStart}
              disabled={pending}
              onChange={(next) => void saveToggle({ autoStart: next }, '开机自启')}
            />
            <ToggleRow
              id="settings-start-minimized"
              label="启动时最小化"
              description="启动后只驻留托盘，不主动弹出主窗口。"
              checked={settings.startMinimized}
              disabled={pending}
              onChange={(next) => void saveToggle({ startMinimized: next }, '启动时最小化')}
            />
            <ToggleRow
              id="settings-close-to-tray"
              label="关闭窗口时最小化到托盘"
              description="关闭主窗口后服务继续运行；可从托盘菜单退出。"
              checked={settings.closeToTray}
              disabled={pending}
              onChange={(next) => void saveToggle({ closeToTray: next }, '关闭到托盘')}
            />
          </div>
        </Card>

        <Card
          id="settings-update-heading"
          title="软件更新"
          description="手动检查 GitHub Release；不会在后台自动请求网络。"
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-md bg-canvas/60 px-3 py-2.5 ring-1 ring-inset ring-line">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted">当前版本</p>
                <p className="mt-0.5 font-mono text-sm text-ink">v{update?.currentVersion ?? '—'}</p>
              </div>
              <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-muted ring-1 ring-inset ring-line">
                {updateStatus(update)}
              </span>
            </div>

            {update?.phase === 'downloading' && update.progress && (
              <div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-neutral-200"
                  role="progressbar"
                  aria-valuenow={update.progress.percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width]"
                    style={{ width: `${update.progress.percent}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  {update.progress.percent}% · {formatBytes(update.progress.transferred)} /{' '}
                  {formatBytes(update.progress.total)}
                </p>
              </div>
            )}

            {update?.message && (
              <p role="alert" className="text-xs leading-5 text-red-600">
                {update.message}
              </p>
            )}

            {updateDisabled && (
              <p className="text-xs leading-5 text-muted">
                仅安装版支持更新检查；开发与测试环境不会请求 GitHub。
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void checkUpdates()}
                disabled={updateDisabled || updateBusy}
                className={SECONDARY_BUTTON}
              >
                {update?.phase === 'checking' ? '检查中…' : '检查更新'}
              </button>
              {update?.phase === 'available' && (
                <button type="button" onClick={() => void downloadUpdate()} className={PRIMARY_BUTTON}>
                  下载 v{update.availableVersion}
                </button>
              )}
              {update?.phase === 'ready' && (
                <button type="button" onClick={() => void installUpdate()} className={PRIMARY_BUTTON}>
                  重启并安装
                </button>
              )}
            </div>

            {update?.checkedAt && (
              <p className="text-xs text-muted">上次检查：{new Date(update.checkedAt).toLocaleString()}</p>
            )}
          </div>
        </Card>

        <Card
          id="settings-history-heading"
          title="日志与额度"
          description="历史记录保留周期与额度探针的刷新间隔。"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="settings-retention" className={LABEL_CLASS}>
                历史保留
              </label>
              <select
                id="settings-retention"
                value={settings.retentionDays}
                onChange={(event) => void saveToggle({ retentionDays: Number(event.target.value) }, '历史保留')}
                disabled={pending}
                className={INPUT_CLASS}
              >
                <option value={7}>7 天</option>
                <option value={30}>30 天</option>
                <option value={90}>90 天</option>
                <option value={0}>永久保留</option>
              </select>
              <p className={HINT_CLASS}>启动时清理超过保留期的历史文件。</p>
            </div>
            <div>
              <label htmlFor="settings-quota-refresh" className={LABEL_CLASS}>
                额度刷新间隔（秒）
              </label>
              <div className="flex items-start gap-2">
                <input
                  id="settings-quota-refresh"
                  type="number"
                  min={10}
                  max={3600}
                  step={1}
                  value={quotaInput}
                  onChange={(event) => {
                    setQuotaInput(event.target.value)
                    setQuotaError(null)
                  }}
                  aria-invalid={quotaError ? true : undefined}
                  aria-describedby={`settings-quota-hint${quotaError ? ' settings-quota-error' : ''}`}
                  className={`${INPUT_CLASS} ${quotaError ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20' : ''}`}
                />
                <button
                  type="button"
                  onClick={() => void saveQuotaRefresh()}
                  disabled={pending}
                  className={`${SECONDARY_BUTTON} shrink-0`}
                >
                  保存间隔
                </button>
              </div>
              {quotaError && (
                <p id="settings-quota-error" role="alert" className={ERROR_CLASS}>
                  {quotaError}
                </p>
              )}
              <p id="settings-quota-hint" className={HINT_CLASS}>
                10-3600 秒，默认 300 秒（5 分钟）；所有供应商按同一间隔探测。
              </p>
            </div>
          </div>
        </Card>

        <Card
          id="settings-connection-heading"
          title="连接信息"
          description="把 Agent 的 Base URL 指向本地服务，模型名使用「模型」页中的 ID。"
          className="lg:col-span-2"
        >
          <div className="space-y-3">
            {[
              { label: 'OpenAI Base URL', url: openaiUrl },
              { label: 'Anthropic Base URL', url: anthropicUrl }
            ].map(({ label, url }) => (
              <div
                key={label}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-canvas/60 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted">{label}</p>
                  <p className="mt-0.5 break-all font-mono text-[13px] text-ink">{url}</p>
                </div>
                <button
                  type="button"
                  aria-label={`复制 ${label}`}
                  onClick={() => void copyUrl(url, label)}
                  className={SECONDARY_BUTTON}
                >
                  {copied === label ? (
                    <Check className="size-3.5 text-emerald-700" aria-hidden="true" />
                  ) : (
                    <Copy className="size-3.5" aria-hidden="true" />
                  )}
                  {copied === label ? '已复制' : '复制'}
                </button>
              </div>
            ))}
            <div className="rounded-md bg-canvas/60 p-3 text-xs leading-5 text-muted ring-1 ring-inset ring-line">
              <p>
                模型名提示：填写「模型」页显示的模型 ID。同名模型在多个供应商间只出现一次，路由会按优先级与可用性自动选择。
              </p>
              <p className="mt-1">
                Claude Code 等 Anthropic 客户端：把 <span className="font-mono text-ink">ANTHROPIC_BASE_URL</span> 指向
                Anthropic 地址，<span className="font-mono text-ink">ANTHROPIC_MODEL</span> 填写本地模型名。
              </p>
            </div>
          </div>
        </Card>
      </div>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  )
}
