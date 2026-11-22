export type LocalBackend = 'cuda' | 'vulkan' | 'rocm' | 'cpu'
export type BackendPreference = 'auto' | LocalBackend
export type HfEndpointKind = 'official' | 'mirror' | 'custom'
// KV 量化精度：llama.cpp 对非 f16 的 V 缓存强制要求 Flash Attention。
export type KvCacheType = 'f16' | 'q8_0' | 'q4_0'

export interface LocalSettings {
  // 空串表示使用 <dataDir>/models。
  modelsDir: string
  localPort: number
  backend: BackendPreference
  // llama-server `--device` 的取值（如 Vulkan0）；空串表示交给 llama.cpp 按默认策略选择。
  gpuDevice: string
  hfEndpoint: HfEndpointKind
  hfEndpointCustom: string
  // GitHub 资产下载前缀；空串为直连。
  githubMirror: string
  defaultContext: number
  // 加载模型的默认 KV 缓存精度；量化值会同时启用 Flash Attention。
  kvCache: KvCacheType
}

export interface GpuInfo {
  name: string
  vendor: 'nvidia' | 'amd' | 'intel' | 'other'
  vramBytes: number | null
  // true 表示显存是近似值：注册表按名称模糊匹配，或退化为 WMI AdapterRAM（uint32 截断），界面需提示估算。
  vramEstimated: boolean
  recommended: boolean
}

export interface HardwareReport {
  gpus: GpuInfo[]
  recommendedBackend: LocalBackend
  detectedAt: string
  error?: string
}

// 整机口径的资源占用：内存来自系统可用量，显存/GPU 取占用最多的适配器。
export interface SystemUsage {
  sampledAt: string
  ramUsedBytes: number
  ramTotalBytes: number
  vramUsedBytes: number
  // 取自硬件探测到的最大显存；未知时为 null，界面只显示已用量。
  vramTotalBytes: number | null
  // 整卡最忙引擎的占比，0-100。
  gpuPercent: number
}

export interface RuntimeInstall {
  backend: LocalBackend
  tag: string
  installedAt: string
  devices: string[]
  sourceUrl: string
  exePath: string
}

export interface InstalledModel {
  id: string
  // 相对 modelsDir。分片模型这里是**第一个**分片，其它分片用 library.shardPaths 枚举。
  path: string
  sizeBytes: number
  parts: number
  repo?: string
  quant?: string
  loaded: boolean
  // GGUF 头里的 KV 成本摘要；解析失败时缺省，界面按「未知」处理。
  kvInfo?: ModelKvInfo
}

// 训练上下文与 KV 占用（f16 口径）。全注意力层按 token 线性增长，滑动窗口层是固定窗口。
export interface ModelKvInfo {
  trainedContext: number | null
  kvBytesPerToken: number | null
  swaBytes: number | null
}

// 加载模型时由界面传入的可选覆盖；缺省沿用 local.json。
export interface LocalLoadOptions {
  contextSize?: number
  kvCache?: KvCacheType
}

// 超过模型训练长度时下发的 YaRN 参数：scale = 目标 / 训练长度。
export interface RopeScaling {
  scale: number
  origContext: number
}

export type RuntimePhase = 'not-installed' | 'stopped' | 'starting' | 'running' | 'error'

export interface LocalRuntimeStatus {
  phase: RuntimePhase
  backend: LocalBackend | null
  tag: string | null
  modelId: string | null
  modelPath: string | null
  port: number | null
  contextLength: number | null
  error: string | null
  logTail: string[]
  startedAt: string | null
}

export type DownloadPhase = 'queued' | 'downloading' | 'paused' | 'done' | 'error' | 'canceled'

export interface DownloadFile {
  // 仓库内相对路径，如 model.gguf 或 subdir/model.gguf
  path: string
  totalBytes: number
  receivedBytes: number
}

export interface DownloadTask {
  id: string
  repo: string
  files: DownloadFile[]
  phase: DownloadPhase
  error: string | null
  speedBps: number | null
  createdAt: string
  updatedAt: string
}

export interface LocalSnapshot {
  settings: LocalSettings
  hardware: HardwareReport
  install: RuntimeInstall | null
  runtime: LocalRuntimeStatus
  models: InstalledModel[]
  downloads: DownloadTask[]
  // 整机资源占用；首次采样完成前为 null，停止采样不影响已加载模型。
  usage: SystemUsage | null
  // 运行时安装进度：只有安装/导入进行中才有值，结束（成功或失败）后清回 null。
  installProgress?: { asset: string; index: number; count: number; received: number; total: number | null } | null
  hfTokenSet: boolean
}

export interface HfModelSummary {
  id: string
  downloads: number
  likes: number
  lastModified: string
  license: string | null
  gated: boolean
}

export interface HfModelFile {
  path: string
  sizeBytes: number
  quant: string | null
  split: { part: number; total: number } | null
  isAdapter: boolean
}

export interface HfModelDetail {
  id: string
  license: string | null
  gated: boolean
  files: HfModelFile[]
}