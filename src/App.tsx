import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  LayoutDashboard,
  Loader2,
  Network,
  Server,
  Settings,
  X,
  type LucideIcon
} from 'lucide-react'
import { useAppState } from './lib/useAppState'
import { ModelsPage } from './pages/ModelsPage'
import { OverviewPage } from './pages/OverviewPage'
import { ProvidersPage } from './pages/ProvidersPage'
import { SettingsPage } from './pages/SettingsPage'

const PAGES: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'providers', label: '供应商', icon: Server },
  { id: 'models', label: '模型', icon: Boxes },
  { id: 'settings', label: '设置', icon: Settings }
]

type PageId = (typeof PAGES)[number]['id']

function readPage(): PageId {
  const hash = window.location.hash.replace(/^#\/?/, '')
  return PAGES.some((page) => page.id === hash) ? (hash as PageId) : 'overview'
}

function ServerBadge({
  running,
  paused,
  port,
  error
}: {
  running: boolean
  paused: boolean
  port: number
  error?: string | null
}) {
  const label = !running ? '服务未运行' : paused ? '路由已暂停' : '服务运行中'
  const dot = !running ? 'bg-red-500' : paused ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div
      className="flex items-center gap-2 rounded-lg bg-canvas px-2.5 py-2"
      title={!running ? (error ?? undefined) : undefined}
    >
      <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-ink">{label}</p>
        <p className="truncate font-mono text-[11px] text-muted">127.0.0.1:{port}</p>
      </div>
    </div>
  )
}

export default function App() {
  const state = useAppState()
  const [page, setPage] = useState<PageId>(readPage)
  // 密钥恢复提示只在本会话内可关闭；下次启动密钥库若仍为空，警告不会再出现（文件已被隔离）。
  const [dismissedRecovery, setDismissedRecovery] = useState(false)

  useEffect(() => {
    const sync = () => setPage(readPage())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  function navigate(id: PageId) {
    setPage(id)
    try {
      window.history.replaceState(null, '', `#${id}`)
    } catch {
      // file:// 环境下若不允许改写历史，页面切换仍由状态完成。
    }
  }

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center gap-2 bg-canvas text-sm text-muted" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-accent" aria-hidden="true" />
        正在加载 TokenHUB…
      </div>
    )
  }

  return (
    <div className="flex h-full bg-canvas">
      <aside className="flex w-[200px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex items-center gap-2.5 px-4 pb-4 pt-6">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-white">
            <Network className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold tracking-tight text-ink">TokenHUB</span>
            <span className="block truncate text-[11px] text-muted">多供应商路由</span>
          </span>
        </div>

        <nav aria-label="主导航" className="flex flex-col gap-1 px-3">
          {PAGES.map((item) => {
            const Icon = item.icon
            const active = item.id === page
            return (
              <a
                key={item.id}
                href={`#${item.id}`}
                aria-current={active ? 'page' : undefined}
                onClick={(event) => {
                  event.preventDefault()
                  navigate(item.id)
                }}
                className={`flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors ${
                  active
                    ? 'bg-accent/10 font-medium text-accent-strong'
                    : 'text-muted hover:bg-neutral-100 hover:text-ink'
                }`}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {item.label}
              </a>
            )
          })}
        </nav>

        <div className="mt-auto border-t border-line p-3">
          <ServerBadge
            running={state.server.running}
            paused={state.server.paused}
            port={state.server.running ? state.server.port : state.settings.port}
            error={state.server.error}
          />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {state.recoveryWarning && !dismissedRecovery && (
          <div
            role="alert"
            className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-amber-900"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">密钥文件已隔离，需要重新录入</p>
              <p className="mt-0.5 break-words text-xs leading-5">{state.recoveryWarning}</p>
              <p className="mt-0.5 text-xs leading-5">供应商 API Key 与本地访问 Key 需要重新填写，界面不会显示任何密钥内容。</p>
            </div>
            <button
              type="button"
              aria-label="关闭密钥恢复提示"
              onClick={() => setDismissedRecovery(true)}
              className="-m-1 flex size-7 shrink-0 items-center justify-center rounded-md text-amber-900 transition-colors hover:bg-amber-100"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* relative 让页面内绝对定位元素（如 sr-only）受滚动容器裁剪，否则它们会撑高文档、出现第二条滚动条。 */}
        <main className="relative min-w-0 flex-1 overflow-y-auto">
          {page === 'overview' ? (
            <OverviewPage
              state={state}
              onOpenProviders={() => navigate('providers')}
              onOpenSettings={() => navigate('settings')}
            />
          ) : page === 'providers' ? (
            <ProvidersPage state={state} />
          ) : page === 'models' ? (
            <ModelsPage state={state} onOpenProviders={() => navigate('providers')} />
          ) : (
            <SettingsPage state={state} />
          )}
        </main>
      </div>
    </div>
  )
}
