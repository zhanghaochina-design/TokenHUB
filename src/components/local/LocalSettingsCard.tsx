import { useEffect, useState } from 'react'
import type { BackendPreference, HfEndpointKind, LocalSnapshot } from '../../../core/local/types'
import { errorMessage } from '../../lib/format'

const BACKEND_OPTIONS: Array<{ value: BackendPreference; label: string }> = [
  { value: 'auto', label: '自动（按硬件推荐）' },
  { value: 'cuda', label: 'CUDA（NVIDIA）' },
  { value: 'vulkan', label: 'Vulkan（多厂商）' },
  { value: 'rocm', label: 'ROCm（AMD）' },
  { value: 'cpu', label: 'CPU' }
]

export function LocalSettingsCard({ snapshot, onError }: { snapshot: LocalSnapshot; onError: (message: string) => void }) {
  const settings = snapshot.settings
  const [modelsDir, setModelsDir] = useState(settings.modelsDir)
  const [port, setPort] = useState(String(settings.localPort))
  // 后端偏好决定「安装运行时」拉哪个资产；auto 时主进程按显卡报告推荐。
  const [backend, setBackend] = useState<BackendPreference>(settings.backend)
  const [mirror, setMirror] = useState(settings.githubMirror)
  const [hfEndpoint, setHfEndpoint] = useState<HfEndpointKind>(settings.hfEndpoint)
  const [hfCustom, setHfCustom] = useState(settings.hfEndpointCustom)
  const [context, setContext] = useState(String(settings.defaultContext))
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  // Token 单独保存：输入框永远是空的，只在本次输入非空或显式清除时才写 secrets.bin。
  const [savingToken, setSavingToken] = useState(false)

  // 主进程每次推送都会重新构造 settings 对象（含下载进度等无关字段），按对象身份同步会打断输入；
  // 只依赖各字段的原始值，真正的设置变更才覆盖输入框。
  useEffect(() => {
    setModelsDir(settings.modelsDir)
    setPort(String(settings.localPort))
    setBackend(settings.backend)
    setMirror(settings.githubMirror)
    setHfEndpoint(settings.hfEndpoint)
    setHfCustom(settings.hfEndpointCustom)
    setContext(String(settings.defaultContext))
  }, [
    settings.modelsDir,
    settings.localPort,
    settings.backend,
    settings.githubMirror,
    settings.hfEndpoint,
    settings.hfEndpointCustom,
    settings.defaultContext
  ])

  async function pickModelsDir() {
    setPicking(true)
    try {
      const picked = await window.tokenhub.local.chooseModelsDir()
      if (!picked) return
      setModelsDir(picked)
      // 选目录即生效，避免用户选完忘记再点保存。
      await window.tokenhub.local.updateSettings({ modelsDir: picked })
    } catch (error) {
      onError(`选择模型目录失败：${errorMessage(error)}`)
    } finally {
      setPicking(false)
    }
  }

  async function save() {
    const portValue = Number(port)
    if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
      onError('推理端口必须是 1-65535 之间的整数。')
      return
    }
    const contextValue = Number(context)
    if (!Number.isInteger(contextValue) || contextValue < 512 || contextValue > 262144) {
      onError('默认上下文必须是 512-262144 之间的整数。')
      return
    }
    if (hfEndpoint === 'custom' && !hfCustom.trim()) {
      onError('选择自定义 HF 源时必须填写地址。')
      return
    }
    setSaving(true)
    try {
      await window.tokenhub.local.updateSettings({
        modelsDir: modelsDir.trim(),
        localPort: portValue,
        backend,
        githubMirror: mirror.trim(),
        hfEndpoint,
        hfEndpointCustom: hfCustom.trim(),
        defaultContext: contextValue
      })
    } catch (error) {
      onError(`保存失败：${errorMessage(error)}`)
    } finally {
      setSaving(false)
    }
  }

  async function saveToken() {
    const value = token.trim()
    // 空输入意味着「不修改」：误点保存不能清掉已存的 Token。
    if (!value) return
    setSavingToken(true)
    try {
      await window.tokenhub.local.setHfToken(value)
      setToken('')
    } catch (error) {
      onError(`Token 保存失败：${errorMessage(error)}`)
    } finally {
      setSavingToken(false)
    }
  }

  async function clearToken() {
    setSavingToken(true)
    try {
      await window.tokenhub.local.setHfToken(null)
      setToken('')
    } catch (error) {
      onError(`Token 清除失败：${errorMessage(error)}`)
    } finally {
      setSavingToken(false)
    }
  }

  const input = 'h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none'
  return (
    <section className="mt-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-ink">本地设置</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-xs text-muted">
          模型目录（留空使用数据目录/models）
          <div className="mt-1 flex gap-2">
            <input
              className={`${input} min-w-0 flex-1`}
              value={modelsDir}
              placeholder="例如 E:\\models"
              onChange={(event) => setModelsDir(event.target.value)}
            />
            <button
              type="button"
              onClick={() => void pickModelsDir()}
              disabled={picking}
              className="inline-flex h-9 shrink-0 items-center rounded-lg border border-line bg-surface px-3 text-xs font-medium text-ink transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {picking ? '选择中…' : '选择目录'}
            </button>
          </div>
        </label>
        <label className="text-xs text-muted">
          推理端口
          <input
            className={`${input} mt-1`}
            inputMode="numeric"
            value={port}
            onChange={(event) => setPort(event.target.value)}
          />
        </label>
        <label className="text-xs text-muted">
          默认上下文
          <input
            className={`${input} mt-1`}
            inputMode="numeric"
            value={context}
            onChange={(event) => setContext(event.target.value)}
          />
        </label>
        <label className="text-xs text-muted">
          后端偏好
          <select
            className={`${input} mt-1`}
            value={backend}
            onChange={(event) => setBackend(event.target.value as BackendPreference)}
          >
            {BACKEND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          HuggingFace 源
          <select
            className={`${input} mt-1`}
            value={hfEndpoint}
            onChange={(event) => setHfEndpoint(event.target.value as HfEndpointKind)}
          >
            <option value="official">官方 huggingface.co</option>
            <option value="mirror">镜像 hf-mirror.com</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        {hfEndpoint === 'custom' ? (
          <label className="text-xs text-muted">
            自定义 HF 地址
            <input
              className={`${input} mt-1`}
              value={hfCustom}
              placeholder="https://example.com"
              onChange={(event) => setHfCustom(event.target.value)}
            />
          </label>
        ) : null}
        <label className="text-xs text-muted md:col-span-2">
          GitHub 下载镜像前缀（运行时安装用，留空直连）
          <input className={`${input} mt-1`} value={mirror} onChange={(event) => setMirror(event.target.value)} />
        </label>
        <div className="text-xs text-muted md:col-span-2">
          <label htmlFor="hf-token">
            HF Token（{snapshot.hfTokenSet ? '已设置' : '未设置'}；Gated 模型需要）
          </label>
          <input
            id="hf-token"
            className={`${input} mt-1`}
            type="password"
            autoComplete="off"
            value={token}
            placeholder={snapshot.hfTokenSet ? '留空不修改；输入新 Token 覆盖' : 'hf_...'}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {saving ? '保存中…' : '保存设置'}
        </button>
        <button
          type="button"
          onClick={() => void saveToken()}
          disabled={savingToken || token.trim().length === 0}
          className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink disabled:opacity-60"
        >
          保存 Token
        </button>
        <button
          type="button"
          onClick={() => void clearToken()}
          disabled={savingToken || !snapshot.hfTokenSet}
          className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-red-700 disabled:opacity-60"
        >
          清除 Token
        </button>
      </div>
    </section>
  )
}
