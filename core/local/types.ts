export type LocalBackend = 'cuda' | 'vulkan' | 'rocm' | 'cpu'
export type BackendPreference = 'auto' | LocalBackend
export type HfEndpointKind = 'official' | 'mirror' | 'custom'

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