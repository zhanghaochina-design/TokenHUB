import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../store/fsUtil'
import { parseRuntimeDevices } from './devices'
import { DownloadManager } from './downloader'
import { detectHardware, runCommand } from './hardware'
import { HfClient, isRepoId } from './hf'
import { downloadFile, type FetchFn } from './http'
import { scanModels, shardPaths } from './library'
import { LocalRuntime, type ChildHandle, type RuntimeSpawnPorts } from './runtime'
import { RuntimeInstaller, type InstallerPorts } from './runtimeInstaller'
import { DEFAULT_LOCAL_SETTINGS, MAX_CONTEXT_TOKENS, MIN_CONTEXT_TOKENS, hfBaseUrl, normalizeKvCache, normalizeLocalSettings } from './settings'
import type {
  BackendPreference,
  DownloadTask,
  HardwareReport,
  HfModelDetail,
  HfModelSummary,
  KvCacheType,
  LocalBackend,
  LocalLoadOptions,
  LocalRuntimeStatus,
  LocalSettings,
  LocalSnapshot,
  RopeScaling,
  RuntimeInstall,
  SystemUsage
} from './types'
import { USAGE_SAMPLE_MS, sampleSystemUsage } from './usage'

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
  load(
    model: { modelId: string; modelPath: string },
    backend: LocalBackend,
    contextSize: number,
    device?: string | null,
    options?: { kvCache?: KvCacheType; rope?: RopeScaling | null }
  ): Promise<void>
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

export interface HfPort {
  search(query: string): Promise<HfModelSummary[]>
  model(repo: string): Promise<HfModelDetail>
}

export interface DownloadManagerPort {
  getTasks(): DownloadTask[]
  enqueue(repo: string, files: string[]): Promise<void>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  cancel(id: string): Promise<void>
  shutdown(): Promise<void>
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
  // 测试注入：覆盖整机资源采样（默认走 PowerShell 性能计数器）。
  sampleUsage?: () => Promise<SystemUsage | null>
  installer?: RuntimeInstallerPort
  runtime?: LocalRuntimePort
  hf?: HfPort
  downloads?: DownloadManagerPort
  onSnapshot?: (snapshot: LocalSnapshot) => void
  now?: () => Date
}

function emptyHardware(): HardwareReport {
  return { gpus: [], recommendedBackend: 'cpu', detectedAt: '', error: '尚未检测' }
}

// 显式上下文长度来自渲染进程（用户可以填任意数字）：越界值直接传给 llama-server 会让它启动失败或
// 按模型上限偷改，和设置页同一区间收敛后再下发。
function clampContext(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(MAX_CONTEXT_TOKENS, Math.max(MIN_CONTEXT_TOKENS, Math.floor(value)))
}

// 超过训练长度必须显式启用 YaRN：llama.cpp 只在显式 YaRN 且缩放系数与训练值不同时
// 才把每槽上下文上限从 n_ctx_train 重算为目标长度，否则 server 会静默截回训练上限。
function ropeFor(contextSize: number, trainedContext: number | null): RopeScaling | null {
  if (!trainedContext || contextSize <= trainedContext) return null
  return { scale: Math.round((contextSize / trainedContext) * 10_000) / 10_000, origContext: trainedContext }
}

// 启动自检探针：本地端口已被一个「上次没退干净的 llama-server」占用时，新进程会因为绑定失败而
// 静默路由到那个旧模型。只报警，不杀进程（可能是用户自己起的服务）。
const STALE_PROBE_TIMEOUT_MS = 1_500

// 快照广播的节流窗口：llama-server 的日志是逐行刷新的，不合并会把 IPC 打满。
const EMIT_THROTTLE_MS = 300

// 允许的后端值与 `LocalBackend` 一致；IPC 传来的是任意字符串，必须先对照白名单再拼路径。
const LOCAL_BACKENDS: readonly string[] = ['cuda', 'vulkan', 'rocm', 'cpu']

export class LocalService {
  private settings: LocalSettings = DEFAULT_LOCAL_SETTINGS
  private hardware: HardwareReport = emptyHardware()
  private installs: RuntimeInstall[] = []
  private models: LocalSnapshot['models'] = []
  private installProgress: LocalSnapshot['installProgress'] = null
  private usage: SystemUsage | null = null
  private usageTimer: ReturnType<typeof setInterval> | null = null
  private usageInFlight = false
  private readonly runtime: LocalRuntimePort
  private readonly installer: RuntimeInstallerPort
  private readonly sampleUsage: () => Promise<SystemUsage | null>
  private hf!: HfPort
  private downloads: DownloadManagerPort | null = null
  // 安装/导入互斥：两条流程会并行解压到同一个运行时目录，进度与安装记录都会互相覆盖。
  private installing = false
  // 扫描令牌：下载完成的重扫、设置页刷新、删除模型都可能同时发起扫描，只有最后发起的那一次能写回结果。
  private scanToken = 0
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => Date
  private readonly fetchFn: FetchFn
  // 可变：`open()` 会在 `init()` 里先广播，调用方只能等它返回后再订阅。
  private onSnapshot: ((snapshot: LocalSnapshot) => void) | undefined

  private constructor(private readonly options: LocalServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.fetchFn = options.fetchFn ?? (fetch as unknown as FetchFn)
    this.onSnapshot = options.onSnapshot
    this.sampleUsage =
      options.sampleUsage ??
      (() => sampleSystemUsage({ run: runCommand, vramTotalBytes: this.vramTotalBytes(), now: this.now }))
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

  /**
   * 替换快照订阅。`open()` 期间（`init()` 里的检测/扫描）已经在广播，构造参数订阅不到那一段，
   * 因此调用方需要在 `open()` 返回后补订阅，并用 `getSnapshot()` 补上当前状态。
   */
  setOnSnapshot(cb: (snapshot: LocalSnapshot) => void): void {
    this.onSnapshot = cb
  }

  private get modelsDir(): string {
    return this.options.modelsDirOverride ?? (this.settings.modelsDir || join(this.options.dataDir, 'models'))
  }

  private get settingsFile(): string {
    return join(this.options.dataDir, 'local.json')
  }

  private async init(): Promise<void> {
    const text = await readFile(this.settingsFile, 'utf8').catch(() => null)
    // 写入被打断留下的零长度/纯空白文件没有可解析内容：按默认设置启动，不要让本地功能整体报错。
    if (text && text.trim()) {
      try {
        this.settings = normalizeLocalSettings(JSON.parse(text))
      } catch {
        await this.options.logger?.warn('local.json 无法解析，已回退默认设置')
      }
    }
    if (this.options.modelsDirOverride) this.settings.modelsDir = this.options.modelsDirOverride
    await this.probeStaleRuntime()
    await mkdir(this.modelsDir, { recursive: true }).catch(() => {})
    this.installs = await this.installer.listInstalled()
    await this.detect()
    // 整机资源与模型是否加载无关：窗口一出现就应有读数，先立刻采一次再按间隔刷新。
    this.startUsageSampling()
    await this.refreshModels()
    this.hf =
      this.options.hf ??
      new HfClient({
        fetchFn: this.fetchFn,
        baseUrl: () => hfBaseUrl(this.settings),
        token: () => this.options.secrets.getHfToken()
      })
    this.downloads =
      this.options.downloads ??
      (await DownloadManager.open({
        dataDir: this.options.dataDir,
        // 每次调用都重读：用户可能在设置页改过模型目录，下载要落到新目录里。
        modelsDir: () => this.modelsDir,
        baseUrl: () => hfBaseUrl(this.settings),
        token: () => this.options.secrets.getHfToken(),
        fetchFn: this.fetchFn,
        now: this.now,
        onUpdate: () => this.scheduleEmit(),
        // 新文件落盘后立刻重扫模型并广播：界面不必等用户点刷新。
        onDone: () => void this.refreshModels().catch(() => {})
      }))
    // 启动时还没有加载任何模型：先让本地供应商退到「无模型」，别继承上次运行的列表。
    await this.options.hub.syncLocalProvider({ baseUrl: this.baseUrl, models: [] })
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.settings.localPort}/v1`
  }

  /**
   * 启动时探一次 `/health`：上次退出被打断（强杀、崩溃）留下的 llama-server 会继续占着端口，
   * 本实例随后加载模型才会因绑定失败暴露问题，且请求会静默打到旧模型上。
   * 只写 WARN，不结束未知进程：那可能是用户自己的服务。
   */
  private async probeStaleRuntime(): Promise<void> {
    const port = this.settings.localPort
    try {
      const response = await this.fetchFn(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(STALE_PROBE_TIMEOUT_MS)
      })
      await response.body?.cancel().catch(() => {})
      if (!response.ok) return
      // 已经由本实例启动过运行时就不算「残留」，避免重复告警。
      if (this.runtime.getStatus().phase !== 'stopped') return
      await this.options.logger?.warn(`local port ${port} already responds before load; a stale llama-server may be running`)
    } catch {
      // 端口空闲（ECONNREFUSED）或超时都是正常情况：探测只用于报警，绝不能拖住启动。
    }
  }

  // 后端选择口径：设置里的显式值优先，auto 时用硬件推荐。安装与导入必须共用，否则二者会落到不同目录。
  private resolveBackend(): LocalBackend {
    return this.settings.backend === 'auto' ? this.hardware.recommendedBackend : this.settings.backend
  }

  private installFor(backend: LocalBackend): RuntimeInstall | null {
    return this.installs.find((install) => install.backend === backend) ?? null
  }

  private preferredInstall(): RuntimeInstall | null {
    const preferred = this.settings.backend === 'auto' ? this.hardware.recommendedBackend : this.settings.backend
    return this.installFor(preferred) ?? this.installs[0] ?? null
  }

  // 设备名来自当前后端的安装记录；换运行时/后端后旧名字可能已不存在，此时必须回退自动，
  // 否则 llama-server 会带着未知 `--device` 启动失败。
  private resolveDevice(install: RuntimeInstall): string | null {
    const wanted = this.settings.gpuDevice
    if (!wanted) return null
    const match = parseRuntimeDevices(install.devices).find(
      (device) => device.id.toLowerCase() === wanted.toLowerCase()
    )
    return match?.id ?? null
  }

  // 显存进度条的分母：优先用用户选中的那块卡（设备行的驱动名包含硬件探测的显卡名），
  // 自动时取本机最大显存。只影响分母展示，不参与采样与路由。
  private vramTotalBytes(): number | null {
    const install = this.preferredInstall()
    const wanted = this.settings.gpuDevice.toLowerCase()
    if (install && wanted) {
      const device = parseRuntimeDevices(install.devices).find((item) => item.id.toLowerCase() === wanted)
      const label = device?.label.toLowerCase() ?? ''
      const match = label ? this.hardware.gpus.find((gpu) => label.includes(gpu.name.toLowerCase())) : undefined
      if (match?.vramBytes) return match.vramBytes
    }
    const max = this.hardware.gpus.reduce((best, gpu) => Math.max(best, gpu.vramBytes ?? 0), 0)
    return max > 0 ? max : null
  }

  private startUsageSampling(): void {
    if (this.usageTimer) return
    const tick = async (): Promise<void> => {
      // 上一轮还没返回时跳过本轮：PowerShell 偶发卡住不应堆积进程。
      if (this.usageInFlight) return
      this.usageInFlight = true
      try {
        const next = await this.sampleUsage()
        // 采样失败保留上一次读数，避免资源条在瞬时失败时闪回空表。
        if (next) {
          this.usage = next
          this.scheduleEmit()
        }
      } finally {
        this.usageInFlight = false
      }
    }
    void tick()
    this.usageTimer = setInterval(() => void tick(), USAGE_SAMPLE_MS)
  }

  private stopUsageSampling(): void {
    if (!this.usageTimer) return
    clearInterval(this.usageTimer)
    this.usageTimer = null
  }

  getSnapshot(): LocalSnapshot {
    const install = this.preferredInstall()
    return {
      settings: { ...this.settings },
      hardware: structuredClone(this.hardware),
      // 快照会被 IPC 序列化后交给界面：这里先复制，避免调用方就地改到内存里的安装记录。
      install: install ? { ...install, devices: [...install.devices] } : null,
      runtime: this.runtime.getStatus(),
      models: this.models.map((model) => ({ ...model, kvInfo: model.kvInfo ? { ...model.kvInfo } : undefined })),
      downloads: this.downloads?.getTasks() ?? [],
      installProgress: this.installProgress ?? null,
      usage: this.usage ? { ...this.usage } : null,
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
      this.onSnapshot?.(this.snapshot())
    }, EMIT_THROTTLE_MS)
  }

  private emitNow(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    this.onSnapshot?.(this.snapshot())
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

  // 后端值来自渲染进程，会直接拼进运行时目录（见 RuntimeInstaller.remove 的 rm）：'../..' 之类
  // 必须在这里拒掉，否则递归删除会跑出 runtimeRoot。
  private assertBackend(value: unknown): LocalBackend {
    if (typeof value === 'string' && LOCAL_BACKENDS.includes(value)) return value as LocalBackend
    throw new Error(`invalid local backend: ${String(value)}`)
  }

  // 互斥进入：第二个并发的安装/导入直接拒绝，而不是排队（用户重复点击时应当看到明确反馈）。
  private beginInstall(): void {
    if (this.installing) throw new Error('运行时安装已在进行中')
    this.installing = true
  }

  async installRuntime(backend?: LocalBackend): Promise<LocalSnapshot> {
    // 不传后端时沿用设置；显式传值（哪怕是空串）一律按白名单校验。
    const requested = backend === undefined ? undefined : this.assertBackend(backend)
    const target = requested ?? this.resolveBackend()
    this.beginInstall()
    try {
      const install = await this.installer.install(target)
      this.installs = (await this.installer.listInstalled()).filter((item) => item.backend !== target).concat(install)
    } catch (error) {
      // 打包后界面只能看到一次 toast；落盘保存失败原因，便于事后定位下载/解压/校验阶段。
      void this.options.logger?.error(
        `runtime install failed (${target}): ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    } finally {
      this.installing = false
      // 成功或失败都要清进度并广播：否则界面会停在最后一个字节数上。
      this.clearInstallProgress()
    }
    return this.snapshot()
  }

  async importRuntimeZip(zipPath: string): Promise<LocalSnapshot> {
    // 与 installRuntime 同一口径：用户在设置里指定了后端时，导入必须落到同一个后端目录。
    const backend = this.resolveBackend()
    this.beginInstall()
    try {
      const install = await this.installer.importZip(zipPath, backend)
      this.installs = (await this.installer.listInstalled()).filter((item) => item.backend !== backend).concat(install)
    } catch (error) {
      void this.options.logger?.error(
        `runtime import failed (${backend}, ${zipPath}): ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    } finally {
      this.installing = false
      this.clearInstallProgress()
    }
    return this.snapshot()
  }

  private clearInstallProgress(): void {
    this.installProgress = null
    this.emitNow()
  }

  async removeRuntime(backend: LocalBackend): Promise<LocalSnapshot> {
    // 先校验再做任何文件/进程操作：非法值不能进到 installer.remove。
    const target = this.assertBackend(backend)
    await this.runtime.stop()
    await this.installer.remove(target)
    this.installs = this.installs.filter((install) => install.backend !== target)
    this.models = this.models.map((model) => ({ ...model, loaded: false }))
    await this.options.hub.syncLocalProvider({ baseUrl: this.baseUrl, models: [] })
    this.emitNow()
    return this.snapshot()
  }

  async refreshModels(): Promise<LocalSnapshot> {
    const token = ++this.scanToken
    const scanned = await scanModels(this.modelsDir)
    // 期间有更晚的扫描发起：本次读到的已是旧目录内容，写回会把新结果覆盖掉，只能让位。
    if (token !== this.scanToken) return this.snapshot()
    const status = this.runtime.getStatus()
    // 只有进程真的在跑才能标 loaded：崩溃/停止后 runtime 仍可能保留 modelId，不能凭 id 相等就点亮。
    const runningId = status.phase === 'running' ? status.modelId : null
    this.models = scanned.map((model) => ({ ...model, loaded: model.id === runningId }))
    this.emitNow()
    return this.snapshot()
  }

  async loadModel(id: string, options: LocalLoadOptions = {}): Promise<LocalSnapshot> {
    const model = this.models.find((candidate) => candidate.id === id)
    if (!model) throw new Error(`unknown local model: ${id}`)
    const install = this.preferredInstall()
    if (!install) throw new Error('请先安装 llama.cpp 运行时')
    const contextSize = clampContext(options.contextSize, this.settings.defaultContext)
    const kvCache = normalizeKvCache(options.kvCache, this.settings.kvCache)
    await this.runtime.load(
      { modelId: model.id, modelPath: join(this.modelsDir, model.path) },
      install.backend,
      contextSize,
      this.resolveDevice(install),
      { kvCache, rope: ropeFor(contextSize, model.kvInfo?.trainedContext ?? null) }
    )
    const status = this.runtime.getStatus()
    if (status.phase !== 'running') {
      // 上一次加载成功的模型已经被这次 load 停掉了，供应商必须跟着清空，不能继续路由到已死的进程。
      void this.options.logger?.error(`local model load failed (${model.id}): ${status.error ?? 'unknown error'}`)
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
    // 原子写：写到一半崩溃时零长度/半截文件会被启动逻辑当成默认设置，静默丢掉用户配置。
    await writeFileAtomic(this.settingsFile, JSON.stringify(this.settings, null, 2))
    if (portChanged) {
      // 有模型（或在启动/报错）才需要停；空闲时没有可依赖的 stopModel 副作用，
      // 下面的同步必须由这里自己发，否则旧 baseUrl 会一直留在 Hub 里。
      if (this.runtime.getStatus().phase !== 'stopped') await this.stopModel()
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

  // 搜索词是自由文本（用户输入什么就搜什么），只做细节接口与下载的仓库 ID 校验。
  async searchHf(query: string): Promise<HfModelSummary[]> {
    return await this.hf.search(query)
  }

  async getHfModel(repo: string): Promise<HfModelDetail> {
    if (!isRepoId(repo)) throw new Error('模型 ID 必须形如 org/repo')
    return await this.hf.model(repo)
  }

  async download(repo: string, files: string[]): Promise<LocalSnapshot> {
    // 仓库 ID 来自渲染进程：先在这里拦一次，错误才能带着明确原因回到界面（下载器内部还会再校验）。
    if (!isRepoId(repo)) throw new Error('模型 ID 必须形如 org/repo')
    if (!this.downloads) throw new Error('下载器尚未初始化')
    await this.downloads.enqueue(repo, files)
    // 入队后立刻广播：队列卡片要马上出现，不能等第一次进度回调。
    this.emitNow()
    return this.snapshot()
  }

  async pauseDownload(id: string): Promise<LocalSnapshot> {
    await this.downloads?.pause(id)
    this.emitNow()
    return this.snapshot()
  }

  async resumeDownload(id: string): Promise<LocalSnapshot> {
    await this.downloads?.resume(id)
    this.emitNow()
    return this.snapshot()
  }

  async cancelDownload(id: string): Promise<LocalSnapshot> {
    await this.downloads?.cancel(id)
    this.emitNow()
    return this.snapshot()
  }

  async shutdown(): Promise<void> {
    this.stopUsageSampling()
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    // 先杀 llama-server 再停下载：下载收尾（落盘、拖到超时）期间进程仍在跑，退出后就会变成孤儿
    // 进程占着端口。runtime.shutdown 不依赖下载队列，因此顺序调换是安全的。
    await this.runtime.shutdown()
    await this.downloads?.shutdown()
  }

  getModelsDir(): string {
    return this.modelsDir
  }

  getSettings(): LocalSettings {
    return { ...this.settings }
  }
}

const PROBE_TIMEOUT_MS = 15_000

export interface RuntimeProbeResult {
  ok: boolean
  /** 退出码；被信号杀死/超时时为 null。Windows 上缺 DLL 会给出 3221225781 这类大数。 */
  exitCode: number | string | null
  /** stdout + stderr 的合并输出（已 trim）。 */
  output: string
}

export type RuntimeProbe = (exePath: string, flag: string) => Promise<RuntimeProbeResult>

// llama-server 的报错可能写在 stdout 也可能写在 stderr：两个流都拼起来，失败时才不会只剩空字符串。
function runProbe(exePath: string, flag: string): Promise<RuntimeProbeResult> {
  return new Promise((resolve) => {
    execFile(exePath, [flag], { windowsHide: true, timeout: PROBE_TIMEOUT_MS }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
      if (!error) {
        resolve({ ok: true, exitCode: 0, output })
        return
      }
      const rawCode = (error as { code?: unknown }).code
      const exitCode = typeof rawCode === 'number' || typeof rawCode === 'string' ? rawCode : null
      resolve({ ok: false, exitCode, output: output || error.message })
    })
  })
}

/**
 * 运行时自检。`--version` 先确认二进制真的能跑（CUDA 包缺 cudart 时进程启动即非零退出），
 * `--list-devices` 再确认能探测设备；任一非零退出或没有输出都按坏包拒绝。
 * 只跑 `--list-devices` 时失败/空输出会被解析成空数组，坏包就被记成「安装成功」。
 */
export async function probeRuntime(exePath: string, probe: RuntimeProbe = runProbe): Promise<string[]> {
  const version = await probe(exePath, '--version')
  if (!version.ok) {
    throw new Error(`llama-server --version 失败（退出码 ${version.exitCode ?? 'unknown'}）：${version.output}`)
  }
  if (!version.output) throw new Error('llama-server --version 没有输出')
  const devices = await probe(exePath, '--list-devices')
  if (!devices.ok) {
    throw new Error(`llama-server --list-devices 失败（退出码 ${devices.exitCode ?? 'unknown'}）：${devices.output}`)
  }
  const lines = devices.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) throw new Error('llama-server --list-devices 没有输出设备列表')
  return lines
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

export function defaultInstallerPorts(fetchFn: FetchFn, probe: RuntimeProbe = runProbe): InstallerPorts {
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
    validate: (exePath) => probeRuntime(exePath, probe)
  }
}