export type LocalBackend = 'cuda' | 'vulkan' | 'rocm' | 'cpu'
export type BackendPreference = 'auto' | LocalBackend
export type HfEndpointKind = 'official' | 'mirror' | 'custom'

export interface LocalSettings {
  // 空串表示使用 <dataDir>/models。
  modelsDir: string
  localPort: number
  backend: BackendPreference
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
  // true 表示来自 WMI AdapterRAM（uint32 截断），界面需提示估算。
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