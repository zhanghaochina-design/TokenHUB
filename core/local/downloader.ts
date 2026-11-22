import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hfResolveUrl, isRepoId } from './hf'
import { downloadFile, type FetchFn } from './http'
import { isSafeRelativePath } from './library'
import type { DownloadTask } from './types'

export interface DownloadManagerOptions {
  dataDir: string
  modelsDir: () => string
  baseUrl: () => string
  token: () => string | null
  fetchFn: FetchFn
  freeSpace?: (dir: string) => Promise<number>
  now?: () => Date
  onUpdate?: () => void
  onDone?: () => void
}

// GGUF 单文件常在 4 GB 以上：可用空间少于 2 GB 时开下必然写半截失败，不如提前拒绝。
const MIN_FREE_BYTES = 2 * 1024 ** 3
// 同时跑两个任务：再多会互相抢带宽，进度条集体变慢。
const MAX_PARALLEL = 2
// 速度按 1 秒窗口采样：每个 chunk 都重算会让界面数字抖成噪声。
const SPEED_WINDOW_MS = 1_000
const WAIT_INTERVAL_MS = 5

function downloadFileOf(dataDir: string): string {
  return join(dataDir, 'local', 'downloads.json')
}

// 旧文件可能被手改或被部分写入：只认形状完整的任务，坏记录直接丢弃，不能让整个下载队列打不开。
function restoredTasks(parsed: unknown): DownloadTask[] {
  if (!Array.isArray(parsed)) return []
  const tasks: DownloadTask[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const task = raw as Partial<DownloadTask>
    const repo = task.repo
    if (typeof task.id !== 'string' || typeof repo !== 'string' || !isRepoId(repo) || !Array.isArray(task.files)) continue
    const files = task.files
      .filter((file) => Boolean(file) && typeof file.path === 'string' && isSafeRelativePath(file.path))
      .map((file) => ({
        path: file.path.replace(/\\/g, '/'),
        totalBytes: Number.isFinite(file.totalBytes) ? Number(file.totalBytes) : 0,
        receivedBytes: Number.isFinite(file.receivedBytes) ? Number(file.receivedBytes) : 0
      }))
    if (files.length === 0) continue
    tasks.push({
      id: task.id,
      repo,
      files,
      // 打开时绝不自动续传：重启后突然抢带宽会像是程序在偷偷下载，必须等用户点继续。
      phase: task.phase === 'done' ? 'done' : 'paused',
      error: typeof task.error === 'string' ? task.error : null,
      speedBps: null,
      createdAt: typeof task.createdAt === 'string' ? task.createdAt : '',
      updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : ''
    })
  }
  return tasks
}

export class DownloadManager {
  private tasks: DownloadTask[] = []
  private readonly aborters = new Map<string, AbortController>()
  // 正在跑的任务 Promise：pause/cancel/shutdown 要等它真正退出后再动文件，否则 Windows 上写入流未关会 EBUSY。
  private readonly settling = new Map<string, Promise<void>>()
  private running = 0
  private readonly now: () => Date
  private readonly freeSpace: (dir: string) => Promise<number>

  private constructor(private readonly options: DownloadManagerOptions) {
    this.now = options.now ?? (() => new Date())
    this.freeSpace = options.freeSpace ?? defaultFreeSpace
  }

  static async open(options: DownloadManagerOptions): Promise<DownloadManager> {
    const manager = new DownloadManager(options)
    const text = await readFile(downloadFileOf(options.dataDir), 'utf8').catch(() => null)
    if (text && text.trim()) {
      try {
        manager.tasks = restoredTasks(JSON.parse(text))
      } catch {
        manager.tasks = []
      }
    }
    return manager
  }

  getTasks(): DownloadTask[] {
    return this.tasks.map((task) => ({ ...task, files: task.files.map((file) => ({ ...file })) }))
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.options.dataDir, 'local'), { recursive: true })
    await writeFile(downloadFileOf(this.options.dataDir), JSON.stringify(this.tasks, null, 2), 'utf8')
  }

  private update(id: string, patch: Partial<DownloadTask>): void {
    this.tasks = this.tasks.map((task) =>
      task.id === id ? { ...task, ...patch, updatedAt: this.now().toISOString() } : task
    )
    this.options.onUpdate?.()
  }

  async enqueue(repo: string, files: string[]): Promise<void> {
    // 仓库 ID 与文件路径都会拼进 modelsDir 并进入下载地址：非法值必须在任何磁盘探测之前拒绝。
    if (!isRepoId(repo)) throw new Error('模型 ID 必须形如 org/repo')
    if (!Array.isArray(files)) throw new Error('至少选择一个文件')
    const normalized = files.map((file) => (typeof file === 'string' ? file.replace(/\\/g, '/') : ''))
    if (normalized.length === 0) throw new Error('至少选择一个文件')
    for (const file of normalized) {
      if (!isSafeRelativePath(file)) throw new Error(`不安全的下载路径：${file}`)
    }
    const available = await this.freeSpace(this.options.modelsDir())
    if (available < MIN_FREE_BYTES) throw new Error('模型目录所在磁盘空间不足（至少需要 2 GB 可用）')
    const now = this.now().toISOString()
    const task: DownloadTask = {
      id: randomUUID(),
      repo,
      files: normalized.map((path) => ({ path, totalBytes: 0, receivedBytes: 0 })),
      phase: 'queued',
      error: null,
      speedBps: null,
      createdAt: now,
      updatedAt: now
    }
    this.tasks = [...this.tasks, task]
    await this.persist()
    this.options.onUpdate?.()
    void this.pump()
  }

  async pause(id: string): Promise<void> {
    const task = this.tasks.find((candidate) => candidate.id === id)
    if (!task || task.phase === 'done' || task.phase === 'canceled') return
    this.aborters.get(id)?.abort()
    this.aborters.delete(id)
    if (task.phase === 'downloading') {
      // 状态由 run 的 catch 收敛并落盘；等它退出后返回，调用方拿到的快照才是 paused。
      await this.settling.get(id)?.catch(() => {})
      return
    }
    this.update(id, { phase: 'paused', speedBps: null })
    await this.persist()
  }

  async resume(id: string): Promise<void> {
    const task = this.tasks.find((candidate) => candidate.id === id)
    // 已完成/已取消/已在队列里的任务再 resume 只会多开一条下载，必须忽略。
    if (!task || task.phase === 'done' || task.phase === 'canceled' || task.phase === 'queued') return
    if (task.phase === 'downloading') return
    // 等上一轮中止真正退出：否则新旧两次写同一个 `.part` 会交错。
    await this.settling.get(id)?.catch(() => {})
    this.update(id, { phase: 'queued', error: null, speedBps: null })
    await this.persist()
    void this.pump()
  }

  async cancel(id: string): Promise<void> {
    const task = this.tasks.find((candidate) => candidate.id === id)
    if (!task) return
    this.aborters.get(id)?.abort()
    this.aborters.delete(id)
    await this.settling.get(id)?.catch(() => {})
    for (const file of task.files) {
      // `.part` 可能来自更早一次运行（receivedBytes 为 0 时也存在），一律清掉。
      await rm(join(this.options.modelsDir(), task.repo, `${file.path}.part`), { force: true }).catch(() => {})
    }
    this.update(id, { phase: 'canceled', speedBps: null })
    await this.persist()
  }

  async waitForIdle(): Promise<void> {
    while (this.running > 0 || this.tasks.some((task) => task.phase === 'queued')) {
      await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS))
    }
  }

  private async pump(): Promise<void> {
    if (this.running >= MAX_PARALLEL) return
    const next = this.tasks.find((task) => task.phase === 'queued')
    if (!next) return
    this.running += 1
    const settled = this.run(next.id)
    this.settling.set(next.id, settled)
    void settled.finally(() => {
      this.settling.delete(next.id)
      this.running -= 1
      void this.pump()
    })
  }

  private async run(id: string): Promise<void> {
    const task = this.tasks.find((candidate) => candidate.id === id)
    if (!task || task.phase !== 'queued') return
    this.update(id, { phase: 'downloading', error: null })
    const controller = new AbortController()
    this.aborters.set(id, controller)
    try {
      for (const file of task.files) {
        const dest = join(this.options.modelsDir(), task.repo, file.path)
        // 同一任务里的多文件是顺序下的：已完整落盘的文件（上次暂停前完成）直接跳过，否则 .part 已不存在会整份重下。
        if (file.totalBytes > 0 && (await stat(dest).catch(() => null))?.size === file.totalBytes) {
          this.markFile(id, file.path, file.totalBytes)
          continue
        }
        const token = this.options.token()
        let lastAt = Date.now()
        let lastBytes = file.receivedBytes
        const started = await downloadFile({
          url: hfResolveUrl(this.options.baseUrl(), task.repo, file.path),
          dest,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          fetchFn: this.options.fetchFn,
          signal: controller.signal,
          onProgress: (received, total) => {
            const now = Date.now()
            const elapsed = now - lastAt
            const speed = elapsed >= SPEED_WINDOW_MS ? ((received - lastBytes) * 1000) / elapsed : null
            if (speed !== null) {
              lastAt = now
              lastBytes = received
            }
            this.markFile(id, file.path, received, total, speed)
          }
        })
        // 结束时再对齐一次总量：没有回调（极小文件只有一个 chunk）时也能显示正确总大小。
        this.markFile(id, file.path, started.received, started.total)
      }
      this.update(id, { phase: 'done', speedBps: null })
      this.options.onDone?.()
    } catch (error) {
      if (controller.signal.aborted) {
        // 用户主动暂停不算失败：保留已下载的字节等续传。
        this.update(id, { phase: 'paused', speedBps: null })
      } else {
        this.update(id, { phase: 'error', error: error instanceof Error ? error.message : String(error), speedBps: null })
      }
    } finally {
      this.aborters.delete(id)
      // 落盘失败不该把任务判成失败（进度已在内存里），也不能让 run 变成未处理的 rejection。
      await this.persist().catch(() => {})
    }
  }

  private markFile(
    id: string,
    path: string,
    received: number,
    total: number | null = null,
    speed: number | null = null
  ): void {
    this.tasks = this.tasks.map((candidate) =>
      candidate.id === id
        ? {
            ...candidate,
            files: candidate.files.map((item) =>
              item.path === path
                ? { ...item, receivedBytes: received, totalBytes: total ?? (item.totalBytes || received) }
                : item
            ),
            speedBps: speed ?? candidate.speedBps
          }
        : candidate
    )
    this.options.onUpdate?.()
  }

  async shutdown(): Promise<void> {
    for (const aborter of this.aborters.values()) aborter.abort()
    this.aborters.clear()
    // 等下载真正退出再落盘，否则最后几字节的进度会被覆盖回旧值。
    await Promise.all([...this.settling.values()].map((promise) => promise.catch(() => {})))
    await this.persist()
  }
}

async function defaultFreeSpace(dir: string): Promise<number> {
  const info = await statfs(dir)
  return info.bavail * info.bsize
}