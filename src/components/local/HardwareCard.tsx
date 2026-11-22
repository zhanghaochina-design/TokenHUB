import { useState } from 'react'
import type { LocalSnapshot } from '../../../core/local/types'
import { errorMessage } from '../../lib/format'

function gb(bytes: number | null): string {
  return bytes === null ? '未知' : `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function HardwareCard({ snapshot, onError }: { snapshot: LocalSnapshot; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const { hardware, install } = snapshot
  const progress = snapshot.installProgress ?? null
  // 安装/导入共用同一个 staging 目录，进度存在即视为安装在进行：离开页面再回来 busy 会归零，
  // 只靠 busy 会漏掉「后台还在安装」的情况，仍能再触发一次安装。
  const installing = busy || snapshot.installProgress !== null
  // total 只有拿到 Content-Length 时才是正数；缺失或 0 时只报「第几个资产」，不编造百分比。
  const percent =
    progress && typeof progress.total === 'number' && progress.total > 0
      ? Math.min(100, Math.floor((progress.received / progress.total) * 100))
      : null

  async function installRuntime() {
    setBusy(true)
    try {
      // 不传后端：服务端按设置里的偏好（auto 时用硬件推荐）选择。
      await window.tokenhub.local.installRuntime()
    } catch (error) {
      onError(`运行时安装失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function importZip() {
    setBusy(true)
    try {
      await window.tokenhub.local.importRuntimeZip()
    } catch (error) {
      onError(`导入失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  // 卸载是唯一的磁盘回收路径（重装会清旧目录，但用户想彻底释放空间只能走这里），必须给到界面。
  async function removeRuntime() {
    if (!install) return
    if (!window.confirm(`卸载 ${install.backend.toUpperCase()} 运行时（${install.tag}）？卸载后需要重新安装才能加载模型。`)) return
    setBusy(true)
    try {
      await window.tokenhub.local.removeRuntime(install.backend)
    } catch (error) {
      onError(`卸载失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-ink">显卡与后端</h2>
      {hardware.error ? <p className="mt-2 text-xs text-red-600">{hardware.error}</p> : null}
      <ul className="mt-3 space-y-2">
        {hardware.gpus.map((gpu, index) => (
          <li key={`${gpu.name}-${index}`} className="flex items-center justify-between gap-3 rounded-md bg-canvas px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-ink">{gpu.name}</p>
              <p className="text-xs text-muted">
                {gpu.vendor.toUpperCase()} · {gb(gpu.vramBytes)}
                {gpu.vramEstimated ? '（估算）' : ''}
              </p>
            </div>
            {gpu.recommended ? (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">推荐</span>
            ) : null}
          </li>
        ))}
        {hardware.gpus.length === 0 ? <li className="text-sm text-muted">未识别到独立显卡，将使用 CPU 后端。</li> : null}
      </ul>
      <p className="mt-3 text-xs text-muted">
        推荐后端：<span className="font-medium text-ink">{hardware.recommendedBackend}</span>
        {install ? ` · 已安装 ${install.tag}（${install.devices.join(' / ') || '未报告设备'}）` : ' · 未安装运行时'}
      </p>
      {progress ? (
        <div className="mt-3" aria-live="polite">
          <p className="text-xs text-muted">
            安装中 {progress.index}/{progress.count} {progress.asset}
            {percent === null ? '' : ` · ${percent}%`}
          </p>
          <div
            role="progressbar"
            aria-label="运行时安装进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-meter-track"
          >
            <div className="h-full rounded-full bg-meter-primary transition-[width]" style={{ width: `${percent ?? 0}%` }} />
          </div>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void installRuntime()}
          disabled={installing}
          className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {installing ? '安装中…' : install ? '重新安装运行时' : '安装运行时'}
        </button>
        <button
          type="button"
          onClick={() => void importZip()}
          disabled={installing}
          className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink disabled:opacity-60"
        >
          导入运行时 ZIP
        </button>
        {install ? (
          <button
            type="button"
            onClick={() => void removeRuntime()}
            disabled={installing}
            className="inline-flex h-9 items-center rounded-lg border border-red-200 bg-surface px-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-60"
          >
            卸载运行时
          </button>
        ) : null}
      </div>
    </section>
  )
}
