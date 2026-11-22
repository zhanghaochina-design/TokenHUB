import { useState } from 'react'
import type { LocalSnapshot } from '../../../core/local/types'
import { errorMessage } from '../../lib/format'

function size(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function InstalledModelsCard({ snapshot, onError }: { snapshot: LocalSnapshot; onError: (message: string) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null)

  async function load(id: string) {
    setBusyId(id)
    try {
      await window.tokenhub.local.loadModel(id)
    } catch (error) {
      onError(`加载失败：${errorMessage(error)}`)
    } finally {
      setBusyId(null)
    }
  }

  async function remove(id: string) {
    if (!window.confirm(`确定删除本地模型「${id}」？文件将从模型目录移除。`)) return
    try {
      await window.tokenhub.local.deleteModel(id)
    } catch (error) {
      onError(`删除失败：${errorMessage(error)}`)
    }
  }

  async function refresh() {
    try {
      await window.tokenhub.local.refreshModels()
    } catch (error) {
      onError(`扫描失败：${errorMessage(error)}`)
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
    <section className="mt-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">已安装模型</h2>
        <div className="flex gap-3">
          <button type="button" onClick={() => void openDir()} className="text-xs text-muted hover:text-ink">
            打开模型目录
          </button>
          <button type="button" onClick={() => void refresh()} className="text-xs text-muted hover:text-ink">
            重新扫描
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
                {model.loaded ? ' · 已加载' : ''}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void load(model.id)}
                disabled={busyId !== null || model.loaded}
                className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-xs font-medium text-white disabled:opacity-60"
              >
                {busyId === model.id ? '加载中…' : model.loaded ? '已加载' : '加载'}
              </button>
              <button
                type="button"
                onClick={() => void remove(model.id)}
                className="inline-flex h-8 items-center rounded-lg border border-red-200 px-3 text-xs font-medium text-red-700"
              >
                删除
              </button>
            </div>
          </li>
        ))}
        {snapshot.models.length === 0 ? (
          <li className="py-4 text-sm text-muted">模型目录还是空的。可以从 HuggingFace 下载，或手动放入 .gguf 文件后重新扫描。</li>
        ) : null}
      </ul>
    </section>
  )
}