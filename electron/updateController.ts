import type { UpdateState } from '../core/ipc-types'

export interface UpdateInfoLike {
  version: string
}

export interface UpdateProgressLike {
  percent: number
  transferred: number
  total: number
}

interface UpdaterEvents {
  'checking-for-update': () => void
  'update-available': (info: UpdateInfoLike) => void
  'update-not-available': (info: UpdateInfoLike) => void
  'download-progress': (progress: UpdateProgressLike) => void
  'update-downloaded': (info: UpdateInfoLike) => void
  error: (error: Error) => void
}

export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  on<E extends keyof UpdaterEvents>(event: E, listener: UpdaterEvents[E]): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class UpdateController {
  private state: UpdateState
  private readonly listeners = new Set<(state: UpdateState) => void>()

  constructor(
    private readonly updater: UpdaterLike | null,
    currentVersion: string,
    private readonly enabled: boolean
  ) {
    this.state = { phase: enabled && updater ? 'idle' : 'disabled', currentVersion }
    if (!enabled || !updater) return

    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false

    updater.on('checking-for-update', () => this.patch({ phase: 'checking', message: undefined }))
    updater.on('update-available', (info) =>
      this.patch({
        phase: 'available',
        availableVersion: info.version,
        checkedAt: new Date().toISOString(),
        message: undefined
      })
    )
    updater.on('update-not-available', () =>
      this.patch({
        phase: 'up-to-date',
        availableVersion: undefined,
        checkedAt: new Date().toISOString(),
        message: undefined
      })
    )
    updater.on('download-progress', (progress) =>
      this.patch({
        phase: 'downloading',
        progress: {
          percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
          transferred: progress.transferred,
          total: progress.total
        }
      })
    )
    updater.on('update-downloaded', () => this.patch({ phase: 'ready', progress: undefined, message: undefined }))
    updater.on('error', (error) => {
      // 下载失败保留可用版本，用户可以直接重试下载。
      if (this.state.phase === 'downloading') {
        this.patch({ phase: 'available', progress: undefined, message: error.message })
      } else {
        this.patch({ phase: 'error', message: error.message })
      }
    })
  }

  getState(): UpdateState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : undefined }
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async check(): Promise<UpdateState> {
    const phase = this.state.phase
    if (!this.updater || phase === 'disabled' || phase === 'checking' || phase === 'downloading' || phase === 'ready') {
      return this.getState()
    }
    this.patch({ phase: 'checking', message: undefined, checkedAt: undefined, availableVersion: undefined })
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      this.patch({ phase: 'error', message: errorMessage(error) })
    }
    return this.getState()
  }

  async download(): Promise<UpdateState> {
    if (!this.updater || this.state.phase !== 'available') return this.getState()
    this.patch({
      phase: 'downloading',
      progress: { percent: 0, transferred: 0, total: 0 },
      message: undefined
    })
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      this.patch({ phase: 'available', progress: undefined, message: errorMessage(error) })
    }
    return this.getState()
  }

  install(): void {
    if (!this.updater || this.state.phase !== 'ready') return
    try {
      this.updater.quitAndInstall(false, true)
    } catch (error) {
      this.patch({ phase: 'ready', message: errorMessage(error) })
    }
  }

  private patch(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next }
    const snapshot = this.getState()
    for (const listener of this.listeners) listener(snapshot)
  }
}
