import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detectHardware, runCommand } from './hardware'
import { downloadFile, type FetchFn } from './http'
import { scanModels, shardPaths } from './library'
import { LocalRuntime, type ChildHandle, type RuntimeSpawnPorts } from './runtime'
import { RuntimeInstaller, type InstallerPorts } from './runtimeInstaller'
import { DEFAULT_LOCAL_SETTINGS, normalizeLocalSettings } from './settings'
import type {
  BackendPreference,
  HardwareReport,
  LocalBackend,
  LocalRuntimeStatus,
  LocalSettings,
  LocalSnapshot,
  RuntimeInstall
} from './types'

export interface LocalHubPort {
  syncLocalProvider(input: {
    baseUrl: string
    models: string[]
    meta?: Record<string, { contextLength?: number | null; vision?: boolean | null }>
  }): Promise<void>
}

export interface LocalSecretPort {
  getHfToken(): string | null
  hasHfToken(): boolean
  setHfToken(token: string | null): Promise<void>
}

export interface LocalLoggerPort {
  info(message: string): Promise<void> | void
  warn(message: string): Promise<void> | void
  error(message: string): Promise<void> | void
}

export interface LocalRuntimePort {
  getStatus(): LocalRuntimeStatus
  load(model: { modelId: string; modelPath: string }, backend: LocalBackend, contextSize: number): Promise<void>
  stop(): Promise<void>
  shutdown(): Promise<void>
  setOnExit(cb: () => void): void
}

export interface RuntimeInstallerPort {
  install(backend: LocalBackend): Promise<RuntimeInstall>
  importZip(zipPath: string, backend: LocalBackend): Promise<RuntimeInstall>
  remove(backend: LocalBackend): Promise<void>
  getExe(backend: LocalBackend): Promise<RuntimeInstall | null>
  listInstalled(): Promise<RuntimeInstall[]>
}

export interface LocalServiceOptions {
  dataDir: string
  // 测试注入：覆盖 local.json 中的模型目录。
  modelsDirOverride?: string
  hub: LocalHubPort
  secrets: LocalSecretPort
  logger?: LocalLoggerPort
  fetchFn?: FetchFn
  detect?: (preference: BackendPreference) => Promise<HardwareReport>
  installer?: RuntimeInstallerPort
  runtime?: LocalRuntimePort
  onSnapshot?: (snapshot: LocalSnapshot) => void
  now?: () => Date
}

function emptyHardware(): HardwareReport {
  return { gpus: [], recommendedBackend: 'cpu', detectedAt: '', error: '尚未检测' }
}

// 快照广播的节流窗口：llama-server 的日志是逐行刷新的，不合并会把 IPC 打满。
const EMIT_THROTTLE_MS = 300

export class LocalService {
  private settings: LocalSettings = DEFAULT_LOCAL_SETTINGS
  private hardware: HardwareReport = emptyHardware()
  private installs: RuntimeInstall[] = []
  private models: LocalSnapshot['models'] = []
  private installProgress: LocalSnapshot['installProgress'] = null
  private readonly runtime: LocalRuntimePort
  private readonly installer: RuntimeInstallerPort
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => Date
  private readonly fetchFn: FetchFn

  private constructor(private readonly options: LocalServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.fetchFn = options.fetchFn ?? (fetch as unknown as FetchFn)
    this.runtime =
      options.runtime ??
      new LocalRuntime({
        getInstall: (backend) => this.installFor(backend),
        getPort: () => this.settings.localPort,
        spawnPorts: defaultSpawnPorts,
        fetchFn: this.fetchFn,
        now: this.now,
        onState: () => this.scheduleEmit()
      })
    this.installer =
      options.installer ??
      new RuntimeInstaller({
        dataDir: options.dataDir,
        fetchFn: this.fetchFn,
        mirror: () => this.settings.githubMirror,
        now: this.now,
        ports: defaultInstallerPorts(this.fetchFn),
        onProgress: (progress) => {
          this.installProgress = progress
          this.scheduleEmit()
        }
      })
    this.runtime.setOnExit(() => void this.onRuntimeExit())
  }

  static async open(options: LocalServiceOptions): Promise<LocalService> {
    const service = new LocalService(options)
    await service.init()
    return service
  }

  private get modelsDir(): string {
    return this.options.modelsDirOverride ?? (this.settings.modelsDir || join(this.options.dataDir, 'models'))
  }

  private get settingsFile(): string {
    return join(this.options.dataDir, 'local.json')
  }

  private async init(): Promise<void> {
    const text = await readFile(this.settingsFile, 'utf8').catch(() => null)
    if (text) {
      try {
        this.settings = normalizeLocalSettings(JSON.parse(text))
      } catch {
        await this.options.logger?.warn('local.json 无法解析，已回退默认设置')
      }
    }
    if (this.options.modelsDirOverride) this.settings.modelsDir = this.options.modelsDirOverride
    await mkdir(this.modelsDir, { recursive: true }).catch(() => {})
    this.installs = await this.installer.listInstalled()
    await this.detect()
    await this.refreshModels()
    // 启动时还没有加载任何模型：先让本地供应商退到「无模型」，别继承上次运行的列表。
    await this.options.hub.syncLocalProvider({ baseUrl: this.baseUrl, models: [] })
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.settings.localPort}/v1`
  }

  private installFor(backend: LocalBackend): RuntimeInstall | null {
    return this.installs.find((install) => install.backend === backend) ?? null
  }

  private preferredInstall(): RuntimeInstall | null {
    const preferred = this.settings.backend === 'auto' ? this.hardware.recommendedBackend : this.settings.backend
    return this.installFor(preferred) ?? this.installs[0] ?? null
  }

  getSnapshot(): LocalSnapshot {
    const install = this.preferredInstall()
    return {
      settings: { ...this.settings },
      hardware: structuredClone(this.hardware),
      // 快照会被 IPC 序列化后交给界面：这里先复制，避免调用方就地改到内存里的安装记录。
      install: install ? { ...install, devices: [...install.devices] } : null,
      runtime: this.runtime.getStatus(),
      models: this.models.map((model) => ({ ...model })),
      downloads: [],
      installProgress: this.installProgress ?? null,
      hfTokenSet: this.options.secrets.hasHfToken()
    }
  }

  private snapshot(): LocalSnapshot {
    return this.getSnapshot()
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.options.onSnapshot?.(this.snapshot())
    }, EMIT_THROTTLE_MS)
  }

  private emitNow(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    this.options.onSnapshot?.(this.snapshot())
  }

  async detect(): Promise<LocalSnapshot> {
    const detect = this.options.detect ?? ((preference) => detectHardware(runCommand, preference, this.now))
    this.hardware = await detect(this.settings.backend)
    this.emitNow()
    return this.snapshot()
  }

  async detectHardware(): Promise<LocalSnapshot> {
    return this.detect()
  }

  async installRuntime(backend?: LocalBackend): Promise<LocalSnapshot> {
    const target =
      backend ?? (this.settings.backend === 'auto' ? this.hardware.recommendedBackend : this.settings.backend)
    try {
      const install = await this.installer.install(target)
      this.installs = (await this.installer.listInstalled()).filter((item) => item.backend !== target).concat(install)
    } finally {
      // 成功或失败都要清进度并广播：否则界面会停在最后一个字节数上。
      this.clearInstallProgress()
    }
    return this.snapshot()
  }

  async importRuntimeZip(zipPath: string): Promise<LocalSnapshot> {
    const backend = this.hardware.recommendedBackend
    try {
      const install = await this.installer.importZip(zipPath, backend)
      this.installs = (await this.installer.listInstalled()).filter((item) => item.backend !== backend).concat(install)
    } finally {
      this.clearInstallProgress()
    }
    return this.snapshot()
  }

  private clearInstallProgress(): void {
    this.installProgress = null
    this.emitNow()
  }

  async removeRuntime(backend: LocalBackend): Promise<LocalSnapshot> {
    await this.runtime.stop()
    await this.installer.remove(backend)
    this.installs = this.installs.filter((install) => install.backend !== backend)
    this.models = this.models.map((model) => ({ ...model, loaded: false }))
    await this.options.hub.syncLocalProvider({ baseUrl: this.baseUrl, models: [] })
    this.emitNow()
    return this.snapshot()
  }

  async refreshModels(): Promise<LocalSnapshot> {
    const scanned = await scanModels(this.modelsDir)
    const loadedId = this.runtime.getStatus().modelId
    this.models = scanned.map((model) => ({ ...model, loaded: model.id === loadedId }))
    this.emitNow()
    return this.snapshot()
  }

  async loadModel(id: string, contextSize?: number): Promise<LocalSnapshot> {
    const model = this.models.find((candidate) => candidate.id === id)
    if (!model) throw new Error(`unknown local model: ${id}`)
    const install = this.preferredInstall()
    if (!install) throw new Error('请先安装 llama.cpp 运行时')
    await this.runtime.load(
      { modelId: model.id, modelPath: join(this.modelsDir, model.path) },
      install.backend,
      contextSize ?? this.settings.defaultContext
    )
    const status = this.runtime.getStatus()
    if (status.phase !== 'running') {
      // 上一次加载成功的模型已经被这次 load 停掉了，供应商必须跟着清空，不能继续路由到已死的进程。
      this.models = this.models.map((candidate) => ({ ...candidate, loaded: false }))
      await this.options.hub.syncLocalProvider({ baseUrl: this.baseUrl, models: [] }).catch(() => {})
      this.emitNow()
      return this.snapshot()
    }
    this.models = this.models.map((candidate) => ({ ...candidate, loaded: candidate.id === model.id }))
    await this.options.hub.syncLocalProvider({
      baseUrl: this.baseUrl,
      models: [model.id],
      meta: { [model.id]: { contextLength: status.contextLength, vision: false } }
    })
    this.emitNow()
    return this.snapshot()
  }

  async stopModel(): Promise<LocalSnapshot> {
    await this.runtime.stop()
    this.models = this.models.map((model) => ({ ...model, loaded: false }))
    await this.options.hub.syncLocalProvider({ baseUrl: this.baseUrl, models: [] })
    this.emitNow()
    return this.snapshot()
  }

  async deleteModel(id: string): Promise<LocalSnapshot> {
    const model = this.models.find((candidate) => candidate.id === id)
    if (!model) throw new Error(`unknown local model: ${id}`)
    if (this.runtime.getStatus().modelId === id) await this.stopModel()
    // 分片模型是多个文件：只删 path 会留下无法加载的残片。
    for (const relative of shardPaths(model)) await rm(join(this.modelsDir, relative), { force: true })
    return await this.refreshModels()
  }

  // llama-server 崩溃退出：状态由 runtime 自己写成 error，这里只负责把模型标记与供应商列表对齐。
  private async onRuntimeExit(): Promise<void> {
    this.models = this.models.map((model) => ({ ...model, loaded: false }))
    await this.options.hub.syncLocalProvider({ baseUrl: this.baseUrl, models: [] }).catch(() => {})
    this.emitNow()
  }

  async updateSettings(patch: Partial<LocalSettings>): Promise<LocalSnapshot> {
    const next = normalizeLocalSettings({ ...this.settings, ...patch })
    const portChanged = next.localPort !== this.settings.localPort
    const dirChanged = next.modelsDir !== this.settings.modelsDir || Boolean(this.options.modelsDirOverride)
    this.settings = next
    await mkdir(this.modelsDir, { recursive: true }).catch(() => {})
    await writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf8')
    if (portChanged) {
      await this.stopModel()
      // 端口变了，旧 baseUrl 立刻失效：即使没有模型在跑也要把供应商指到新端口，避免下一次请求打到旧地址。
      await this.options.hub.syncLocalProvider({ baseUrl: this.baseUrl, models: [] })
    }
    if (dirChanged) await this.refreshModels()
    this.emitNow()
    return this.snapshot()
  }

  async setHfToken(token: string | null): Promise<LocalSnapshot> {
    await this.options.secrets.setHfToken(token)
    this.emitNow()
    return this.snapshot()
  }

  async shutdown(): Promise<void> {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    await this.runtime.shutdown()
  }

  getModelsDir(): string {
    return this.modelsDir
  }

  getSettings(): LocalSettings {
    return { ...this.settings }
  }
}

const defaultSpawnPorts: RuntimeSpawnPorts = {
  spawn: (file, args, options) =>
    spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildHandle,
  killTree: async (pid) => {
    // taskkill /T 才能带走 llama-server 可能派生的子进程；失败（进程已退出）不得影响 stop()。
    await new Promise<void>((resolve) =>
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve())
    )
  }
}

function defaultInstallerPorts(fetchFn: FetchFn): InstallerPorts {
  return {
    download: async ({ url, dest, onProgress, signal }) => {
      await downloadFile({ url, dest, fetchFn, onProgress, signal })
    },
    extract: async (zipPath, destDir) => {
      // 单引号转义后交给 PowerShell 的 Expand-Archive；不引第三方解压依赖。
      const script = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
      await new Promise<void>((resolve, reject) =>
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (error) =>
          error ? reject(new Error(error.message)) : resolve()
        )
      )
    },
    validate: async (exePath) => {
      const run = (flag: string) =>
        new Promise<string>((resolve) =>
          execFile(exePath, [flag], { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) =>
            resolve(error ? '' : `${stdout}${stderr}`)
          )
        )
      const devices = await run('--list-devices')
      return devices
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    }
  }
}