import type { FetchFn } from './http'
import type { LocalBackend, LocalRuntimeStatus, RuntimeInstall } from './types'

export interface ChildHandle {
  pid?: number
  kill(): boolean
  once(event: 'exit', cb: (code: number | null) => void): void
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
}

export interface RuntimeSpawnPorts {
  spawn(file: string, args: string[], options: { windowsHide: boolean }): ChildHandle
  /** 兜底杀掉整棵进程树；llama-server 退出后可能留下子进程。失败不得让 `stop()` 抛错。 */
  killTree?(pid: number): Promise<void>
}

export interface LocalRuntimeOptions {
  getInstall: (backend: LocalBackend) => RuntimeInstall | null
  getPort: () => number
  spawnPorts: RuntimeSpawnPorts
  fetchFn: FetchFn
  healthPollMs?: number
  loadTimeoutMs?: number
  now?: () => Date
  onState?: (status: LocalRuntimeStatus) => void
}

const LOG_LINES = 200
const TAIL_LINES = 20
// 进度条之类长时间不换行的输出，攒到这么多字符就当成一行落盘，避免缓冲区无限增长。
const MAX_PENDING_CHARS = 4000
const DEFAULT_LOAD_TIMEOUT_MS = 180_000
const DEFAULT_HEALTH_POLL_MS = 500

/**
 * llama-server 的启动参数。契约：
 * - 只绑定 127.0.0.1，不暴露到局域网；
 * - `-ngl 99` 全部层交给 GPU，CPU 后端由 llama.cpp 自行忽略；
 * - `-np 1` 单并发槽，与本地网关「一次只服务一个会话」的口径一致；
 * - `--jinja` 使用模型自带聊天模板，网关转译不注入模板。
 */
export function buildLlamaArgs(input: { modelPath: string; port: number; contextSize: number; parallel: number }): string[] {
  return [
    '-m', input.modelPath,
    '--host', '127.0.0.1',
    '--port', String(input.port),
    '-c', String(input.contextSize),
    '-ngl', '99',
    '-np', String(input.parallel),
    '--jinja'
  ]
}

function idleStatus(): LocalRuntimeStatus {
  return {
    phase: 'stopped',
    backend: null,
    tag: null,
    modelId: null,
    modelPath: null,
    port: null,
    contextLength: null,
    error: null,
    logTail: [],
    startedAt: null
  }
}

function timeoutLabel(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
}

export class LocalRuntime {
  private status = idleStatus()
  private child: ChildHandle | null = null
  // 当前子进程是否已发过 exit；轮询循环据此提前结束，避免继续等一个已死的进程。
  private childExited = false
  private logs: string[] = []
  private exitHook: (() => void) | null = null
  // 每次 load/stop 递增：并发 load 时旧的那次循环必须自行退出，不能回写状态。
  private loadToken = 0
  private readonly now: () => Date

  constructor(private readonly options: LocalRuntimeOptions) {
    this.now = options.now ?? (() => new Date())
  }

  getStatus(): LocalRuntimeStatus {
    return { ...this.status, logTail: [...this.status.logTail] }
  }

  setOnExit(cb: () => void): void {
    this.exitHook = cb
  }

  private emit(status: Partial<LocalRuntimeStatus>): void {
    this.status = { ...this.status, ...status }
    this.options.onState?.(this.getStatus())
  }

  private appendLog(line: string): void {
    const text = line.trimEnd()
    if (!text) return
    this.logs.push(text)
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES)
    this.status = { ...this.status, logTail: this.logs.slice(-TAIL_LINES) }
    this.options.onState?.(this.getStatus())
  }

  /** 按行切分输出流，日志环只保存整行，最后一行残缺部分留到下一块数据或流结束时再落。 */
  private attachLogs(child: ChildHandle): void {
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue
      let pending = ''
      const flush = (): void => {
        if (!pending) return
        this.appendLog(pending)
        pending = ''
      }
      stream.on('data', (chunk: Buffer | string) => {
        pending += String(chunk)
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) this.appendLog(line)
        if (pending.length > MAX_PENDING_CHARS) flush()
      })
      stream.on('end', flush)
    }
  }

  private async probeHealthy(base: string): Promise<boolean> {
    try {
      const response = await this.options.fetchFn(`${base}/health`)
      const ok = response.ok
      // 健康探针每秒一次，不消费响应体会让连接一直被 undici 占着。
      await response.body?.cancel().catch(() => {})
      return ok
    } catch {
      // 进程还没开始监听，按未就绪处理。
      return false
    }
  }

  /** `/props` 给出 llama-server 实际生效的上下文（-c 可能被模型上限截断），失败时沿用请求值。 */
  private async readContext(base: string, fallback: number): Promise<number> {
    try {
      const response = await this.options.fetchFn(`${base}/props`)
      if (!response.ok) return fallback
      const props = (await response.json()) as { default_generation_settings?: { n_ctx?: unknown } }
      const nCtx = props.default_generation_settings?.n_ctx
      return typeof nCtx === 'number' && Number.isFinite(nCtx) && nCtx > 0 ? Math.floor(nCtx) : fallback
    } catch {
      return fallback
    }
  }

  /**
   * 启动 llama-server 并等待 `/health` 就绪。
   * 失败（未安装运行时、spawn 抛错、进程退出、健康检查超时）只把状态置为 error，不向调用方抛错；
   * 上层从 `getStatus()` 与 `setOnExit` 观察结果。
   */
  async load(model: { modelId: string; modelPath: string }, backend: LocalBackend, contextSize: number): Promise<void> {
    await this.stop()
    const token = ++this.loadToken
    const install = this.options.getInstall(backend)
    if (!install) {
      this.emit({ phase: 'error', backend, modelId: model.modelId, error: `未安装 ${backend} 运行时` })
      return
    }
    const port = this.options.getPort()
    this.logs = []
    this.childExited = false
    this.emit({
      phase: 'starting',
      backend,
      tag: install.tag,
      modelId: model.modelId,
      modelPath: model.modelPath,
      port,
      contextLength: contextSize,
      error: null,
      logTail: [],
      startedAt: this.now().toISOString()
    })

    const args = buildLlamaArgs({ modelPath: model.modelPath, port, contextSize, parallel: 1 })
    let child: ChildHandle
    try {
      child = this.options.spawnPorts.spawn(install.exePath, args, { windowsHide: true })
    } catch (error) {
      this.emit({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
      return
    }
    this.child = child
    this.attachLogs(child)
    child.once('exit', (code) => {
      // 主动 stop/kill 时 this.child 已被清空，或已被新的 load 顶替：这次退出既不算当前进程状态也不报错，
      // 更不能翻转 childExited，否则会把新进程的等待循环误判成「已退出」。
      if (this.child !== child) return
      this.childExited = true
      this.child = null
      this.emit({ phase: 'error', error: `llama-server 退出（code ${code ?? 'unknown'}）` })
      this.exitHook?.()
    })

    const timeoutMs = this.options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
    const pollMs = this.options.healthPollMs ?? DEFAULT_HEALTH_POLL_MS
    const deadline = Date.now() + timeoutMs
    const base = `http://127.0.0.1:${port}`

    while (Date.now() < deadline) {
      if (this.childExited || token !== this.loadToken) return
      const healthy = await this.probeHealthy(base)
      // 探针在途期间进程可能已经退出或被新的 load 顶替，此时不能把状态改回 running。
      if (this.childExited || token !== this.loadToken) return
      if (healthy) {
        this.emit({ phase: 'running', error: null, contextLength: await this.readContext(base, contextSize) })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    if (token !== this.loadToken) return
    this.emit({ phase: 'error', error: `等待 llama-server 就绪超时（${timeoutLabel(timeoutMs)}）` })
    await this.kill()
  }

  /** 立即结束子进程：先 kill，再用 taskkill 兜底进程树；不做任何等待或优雅收尾。 */
  private async kill(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.kill()
    } catch {
      // 进程已退出时 kill 可能抛错，忽略。
    }
    const killTree = this.options.spawnPorts.killTree
    if (child.pid !== undefined && killTree) await killTree(child.pid).catch(() => {})
  }

  async stop(): Promise<void> {
    this.loadToken += 1
    const keepNotInstalled = this.status.phase === 'not-installed'
    await this.kill()
    this.logs = []
    this.emit({ ...idleStatus(), phase: keepNotInstalled ? 'not-installed' : 'stopped' })
  }

  async shutdown(): Promise<void> {
    await this.stop()
  }
}