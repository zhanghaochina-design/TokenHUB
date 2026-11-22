import { useState } from 'react'
import { parseRuntimeDevices } from '../../../core/local/devices'
import type { InstalledModel, LocalLoadOptions, LocalSnapshot } from '../../../core/local/types'
import { errorMessage, formatContextLength } from '../../lib/format'
import { LoadModelDialog } from './LoadModelDialog'

function size(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

// 与 service 的 vramTotalBytes 同口径：资源采样未就绪时用选中显卡（自动时取最大）兜底。
function vramTotalBytes(snapshot: LocalSnapshot): number | null {
  if (snapshot.usage?.vramTotalBytes) return snapshot.usage.vramTotalBytes
  const selected = snapshot.settings.gpuDevice.toLowerCase()
  if (selected && snapshot.install) {
    const device = parseRuntimeDevices(snapshot.install.devices).find((item) => item.id.toLowerCase() === selected)
    const label = device?.label.toLowerCase() ?? ''
    const gpu = label
      ? snapshot.hardware.gpus.find((candidate) => label.includes(candidate.name.toLowerCase()))
      : undefined
    if (gpu?.vramBytes) return gpu.vramBytes
  }
  const max = snapshot.hardware.gpus.reduce((best, gpu) => Math.max(best, gpu.vramBytes ?? 0), 0)
  return max > 0 ? max : null
}

export function InstalledModelsCard({ snapshot, onError }: { snapshot: LocalSnapshot; onError: (message: string) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [loadTarget, setLoadTarget] = useState<InstalledModel | null>(null)
  // 加载/删除/扫描都会动模型目录或运行时进程，任意一项在途时禁止再发起另一项。
  const blocked = busyId !== null || deletingId !== null || scanning

  // 错误交给对话框就地展示：loadModel 在主进程里把启动失败写成 runtime error 而不抛错，
// 这里把非 running 的结果转成异常，对话框才能保持打开让用户改参数重试。
  async function load(id: string, options: LocalLoadOptions) {
    setBusyId(id)
    try {
      const next = await window.tokenhub.local.loadModel(id, options)
      if (next.runtime.phase !== 'running') throw new Error(next.runtime.error ?? '模型未能启动')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(id: string) {
    if (!window.confirm(`确定删除本地模型「${id}」？文件将从模型目录移除。`)) return
    setDeletingId(id)
    try {
      await window.tokenhub.local.deleteModel(id)
    } catch (error) {
      onError(`删除失败：${errorMessage(error)}`)
    } finally {
      setDeletingId(null)
    }
  }

  async function refresh() {
    setScanning(true)
    try {
      await window.tokenhub.local.refreshModels()
    } catch (error) {
      onError(`扫描失败：${errorMessage(error)}`)
    } finally {
      setScanning(false)
    }
  }

  async function openDir() {
    try {
      await window.tokenhub.local.revealModelsDir()
    } catch (error) {
      onError(`打开模型目录失败：${errorMessage(error)}`)
    }
  }

  return (
    <section className="min-w-0 rounded-lg border border-line bg-surface p-5 shadow-sm lg:col-span-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">已安装模型</h2>
        <div className="flex gap-3">
          <button type="button" onClick={() => void openDir()} className="text-xs text-muted hover:text-ink">
            打开模型目录
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={scanning}
            className="text-xs text-muted hover:text-ink disabled:opacity-60"
          >
            {scanning ? '扫描中…' : '重新扫描'}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">模型目录：{snapshot.settings.modelsDir || '（默认数据目录/models）'}</p>
      <ul className="mt-3 divide-y divide-line">
        {snapshot.models.map((model) => (
          <li key={model.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm text-ink">{model.id}</p>
              <p className="text-xs text-muted">
                {size(model.sizeBytes)} · {model.quant ?? '未知量化'} · {model.parts} 个分片
                {model.kvInfo?.trainedContext ? ` · 训练 ${formatContextLength(model.kvInfo.trainedContext)}` : ''}
                {model.loaded ? ' · 已加载' : ''}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setLoadTarget(model)}
                disabled={blocked || model.loaded}
                className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-xs font-medium text-white disabled:opacity-60"
              >
                {busyId === model.id ? '加载中…' : model.loaded ? '已加载' : '加载'}
              </button>
              <button
                type="button"
                onClick={() => void remove(model.id)}
                disabled={blocked || busyId === model.id}
                className="inline-flex h-8 items-center rounded-lg border border-red-200 px-3 text-xs font-medium text-red-700 disabled:opacity-60"
              >
                {deletingId === model.id ? '删除中…' : '删除'}
              </button>
            </div>
          </li>
        ))}
        {snapshot.models.length === 0 ? (
          <li className="py-4 text-sm text-muted">模型目录还是空的。可以从 HuggingFace 下载，或手动放入 .gguf 文件后重新扫描。</li>
        ) : null}
      </ul>
      {loadTarget ? (
        <LoadModelDialog
          model={loadTarget}
          settings={snapshot.settings}
          vramTotalBytes={vramTotalBytes(snapshot)}
          onClose={() => setLoadTarget(null)}
          onLoad={(options) => load(loadTarget.id, options)}
        />
      ) : null}
    </section>
  )
}
