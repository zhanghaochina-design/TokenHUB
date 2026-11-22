import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Toast } from '../components/Toast'
import { HardwareCard } from '../components/local/HardwareCard'
import { InstalledModelsCard } from '../components/local/InstalledModelsCard'
import { RuntimeCard } from '../components/local/RuntimeCard'
import { useLocalState } from '../lib/useLocalState'

export function LocalModelsPage() {
  const snapshot = useLocalState()
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted" role="status">
        <Loader2 className="size-5 animate-spin text-accent" aria-hidden="true" />
        正在读取本地模型状态…
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">本地模型</h1>
        <p className="mt-1 text-sm text-muted">
          在本机通过 llama.cpp 运行 GGUF 模型。加载后可作为「本地模型」供应商参与路由，优先级可在供应商页调整。
        </p>
      </header>
      <div className="grid gap-4 lg:grid-cols-2">
        <HardwareCard snapshot={snapshot} onError={setToast} />
        <RuntimeCard snapshot={snapshot} onError={setToast} />
      </div>
      <InstalledModelsCard snapshot={snapshot} onError={setToast} />
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </div>
  )
}
