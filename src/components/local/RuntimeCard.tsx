import { useState } from 'react'
import type { LocalSnapshot } from '../../../core/local/types'
import { errorMessage } from '../../lib/format'

const PHASE_LABEL: Record<LocalSnapshot['runtime']['phase'], string> = {
  'not-installed': '未安装',
  stopped: '未加载',
  starting: '加载中',
  running: '运行中',
  error: '异常'
}

export function RuntimeCard({ snapshot, onError }: { snapshot: LocalSnapshot; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const runtime = snapshot.runtime

  async function stop() {
    setBusy(true)
    try {
      await window.tokenhub.local.stopModel()
    } catch (error) {
      onError(`停止失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="min-w-0 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-ink">运行状态</h2>
      <p className="mt-2 text-sm text-ink">
        {PHASE_LABEL[runtime.phase]}
        {runtime.modelId ? ` · ${runtime.modelId}` : ''}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted">
        <div>
          <dt>端口</dt>
          <dd className="font-mono text-ink">{runtime.port ?? '—'}</dd>
        </div>
        <div>
          <dt>上下文</dt>
          <dd className="font-mono text-ink">{runtime.contextLength ?? '—'}</dd>
        </div>
      </dl>
      {runtime.error ? <p className="mt-3 text-xs text-red-600">{runtime.error}</p> : null}
      {runtime.logTail.length > 0 ? (
        <pre className="mt-3 max-h-36 overflow-auto rounded-md bg-canvas p-2 text-[11px] leading-5 text-muted">
          {runtime.logTail.join('\n')}
        </pre>
      ) : null}
      <button
        type="button"
        onClick={() => void stop()}
        disabled={busy || (runtime.phase !== 'running' && runtime.phase !== 'starting')}
        className="mt-4 inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink disabled:opacity-60"
      >
        停止模型
      </button>
    </section>
  )
}
