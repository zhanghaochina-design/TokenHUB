import type { DownloadPhase, DownloadTask } from '../../../core/local/types'
import { errorMessage } from '../../lib/format'

const PHASE_LABEL: Record<DownloadPhase, string> = {
  queued: '排队中',
  downloading: '下载中',
  paused: '已暂停',
  done: '已完成',
  error: '失败',
  canceled: '已取消'
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

// 进度按任务内所有文件求和：分片模型逐片完成时，单看某一片会长期停在 0 或 100。
function progressOf(task: DownloadTask): { received: number; total: number; percent: number } {
  const total = task.files.reduce((sum, file) => sum + file.totalBytes, 0)
  const received = task.files.reduce((sum, file) => sum + file.receivedBytes, 0)
  // 服务器没给 Content-Length 时 total 为 0：不编造百分比，留给界面显示「准备中」。
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
  return { received, total, percent }
}

export function DownloadQueue({ tasks, onError }: { tasks: DownloadTask[]; onError: (message: string) => void }) {
  async function act(action: 'pause' | 'resume' | 'cancel', id: string) {
    try {
      if (action === 'pause') await window.tokenhub.local.pauseDownload(id)
      else if (action === 'resume') await window.tokenhub.local.resumeDownload(id)
      else await window.tokenhub.local.cancelDownload(id)
    } catch (error) {
      onError(`操作失败：${errorMessage(error)}`)
    }
  }

  return (
    <section className="mt-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-ink">下载队列</h2>
      <ul className="mt-3 space-y-4">
        {tasks.map((task) => {
          const { received, total, percent } = progressOf(task)
          return (
            <li key={task.id}>
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm text-ink" title={task.repo}>
                  {task.repo}
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {PHASE_LABEL[task.phase]}
                  {task.phase === 'downloading' && task.speedBps
                    ? ` · ${(task.speedBps / 1024 ** 2).toFixed(1)} MB/s`
                    : ''}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={`${task.repo} 下载进度`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-meter-track"
              >
                <div className="h-full rounded-full bg-meter-primary transition-[width]" style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted">
                {total > 0 ? `${gb(received)} / ${gb(total)} · ${percent}%` : '准备中（等待服务器返回文件大小）'}
              </p>
              {task.files.length > 1 ? (
                <ul className="mt-1 space-y-0.5">
                  {task.files.map((file) => (
                    <li key={file.path} className="truncate text-[11px] text-muted" title={file.path}>
                      {file.path} · {gb(file.receivedBytes)} / {gb(file.totalBytes)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {task.error ? <p className="mt-1 text-xs text-red-600">{task.error}</p> : null}
              <div className="mt-1.5 flex gap-3 text-xs">
                {task.phase === 'queued' || task.phase === 'downloading' ? (
                  <button type="button" onClick={() => void act('pause', task.id)} className="text-muted hover:text-ink">
                    暂停
                  </button>
                ) : null}
                {task.phase === 'paused' || task.phase === 'error' ? (
                  <button type="button" onClick={() => void act('resume', task.id)} className="text-muted hover:text-ink">
                    {task.phase === 'error' ? '重试' : '继续'}
                  </button>
                ) : null}
                {task.phase !== 'done' && task.phase !== 'canceled' ? (
                  <button
                    type="button"
                    onClick={() => void act('cancel', task.id)}
                    className="text-red-600 hover:text-red-700"
                  >
                    取消
                  </button>
                ) : null}
              </div>
            </li>
          )
        })}
        {tasks.length === 0 ? <li className="text-sm text-muted">暂无下载任务。</li> : null}
      </ul>
    </section>
  )
}