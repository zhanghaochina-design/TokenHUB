import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Server } from 'lucide-react'
import type { AppState } from '../../core/types'
import { ProviderDialog } from '../components/ProviderDialog'
import { ProviderList } from '../components/ProviderList'
import { Toast } from '../components/Toast'
import { errorMessage } from '../lib/format'

type ProviderWithKey = AppState['providers'][number]

interface ProvidersPageProps {
  state: AppState
}

export function ProvidersPage({ state }: ProvidersPageProps) {
  const [dialog, setDialog] = useState<{ provider: ProviderWithKey | null } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const runtimeById = useMemo(
    () => new Map(state.runtime.map((runtime) => [runtime.providerId, runtime])),
    [state.runtime]
  )
  const enabledCount = state.providers.filter((provider) => provider.enabled).length
  const hasProviders = state.providers.length > 0

  async function handleRefreshAll() {
    setRefreshing(true)
    try {
      await window.tokenhub.refreshModels()
    } catch (error) {
      setToast(`刷新模型失败：${errorMessage(error)}`)
    } finally {
      setRefreshing(false)
    }
  }

  async function handleReorder(ids: string[]) {
    await window.tokenhub.reorderProviders(ids)
  }

  async function handleToggle(provider: ProviderWithKey, enabled: boolean) {
    try {
      await window.tokenhub.setProviderEnabled(provider.id, enabled)
    } catch (error) {
      setToast(`切换启用状态失败：${errorMessage(error)}`)
    }
  }

  async function handleDelete(provider: ProviderWithKey) {
    const confirmed = window.confirm(`确定删除供应商「${provider.name}」？其模型将从合并目录中移除。`)
    if (!confirmed) return
    try {
      await window.tokenhub.deleteProvider(provider.id)
    } catch (error) {
      setToast(`删除供应商失败：${errorMessage(error)}`)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] p-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">供应商</h1>
          <p className="mt-1 text-sm text-muted">
            {hasProviders
              ? `共 ${state.providers.length} 个供应商，${enabledCount} 个已启用。拖动行首手柄调整路由优先级。`
              : '按优先级从上到下路由请求。先添加一个供应商开始使用。'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRefreshAll()}
            disabled={!hasProviders || refreshing}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium text-ink transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            {refreshing ? '刷新中…' : '刷新全部模型'}
          </button>
          <button
            type="button"
            onClick={() => setDialog({ provider: null })}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white transition-colors hover:bg-accent-strong"
          >
            <Plus className="size-4" aria-hidden="true" />
            添加供应商
          </button>
        </div>
      </header>

      {hasProviders ? (
        <ProviderList
          providers={state.providers}
          runtimeById={runtimeById}
          now={now}
          onReorder={handleReorder}
          onEdit={(provider) => setDialog({ provider })}
          onDelete={(provider) => void handleDelete(provider)}
          onToggle={(provider, enabled) => void handleToggle(provider, enabled)}
          onError={setToast}
        />
      ) : (
        <div className="rounded-lg border border-dashed border-line bg-surface px-6 py-16 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-canvas text-muted">
            <Server className="size-5" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-base font-semibold text-ink">还没有供应商</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            添加一个供应商后，TokenHUB 才能路由请求并发现可用模型。API Key 只保存在本机。
          </p>
          <button
            type="button"
            onClick={() => setDialog({ provider: null })}
            className="mt-5 inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-neutral-50"
          >
            <Plus className="size-4" aria-hidden="true" />
            添加第一个供应商
          </button>
        </div>
      )}

      {dialog && (
        <ProviderDialog
          provider={dialog.provider}
          onClose={() => setDialog(null)}
          onError={setToast}
        />
      )}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  )
}
