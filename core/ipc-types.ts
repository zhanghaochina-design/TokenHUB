import type { AppState, HistoryRecord, ModelAlias, ModelMeta, Preset, ProtocolScanResult, ProviderConfig, ProviderSpeedStats, ProviderUsageStats, QuotaAdapterId, QuotaSnapshot, Settings } from './types'
import type { HfModelDetail, HfModelSummary, LocalBackend, LocalSettings, LocalSnapshot } from './local/types'

export interface ProviderInput {
  preset: Preset
  name: string
  baseUrl: string
  anthropicBaseUrl?: string
  apiKey: string
  // 省略时沿用预设自带的适配器（Task 10 测试与预设页都不必重复填写）。
  quotaAdapter?: QuotaAdapterId
  quota?: Partial<ProviderConfig['quota']>
  maxConcurrency?: number
  manualModels?: string[]
}

export interface ProviderPatch {
  name?: string
  baseUrl?: string
  anthropicBaseUrl?: string
  apiKey?: string
  quotaAdapter?: QuotaAdapterId
  quota?: Partial<ProviderConfig['quota']>
  maxConcurrency?: number
  manualModels?: string[]
  enabled?: boolean
}

export interface TestResult {
  models: string[]
  quota: QuotaSnapshot | null
  error?: string
}

// 本地模型功能的完整 IPC 面；P2 的 HF 搜索/下载方法在 Task 12 接入前没有处理器，
// 调用会直接 reject，界面此时也不应该调用它们。
export interface LocalApi {
  getState(): Promise<LocalSnapshot>
  detectHardware(): Promise<LocalSnapshot>
  installRuntime(backend?: LocalBackend): Promise<LocalSnapshot>
  removeRuntime(backend: LocalBackend): Promise<LocalSnapshot>
  // 用户在系统对话框里取消时返回 null，不当作错误。
  importRuntimeZip(): Promise<LocalSnapshot | null>
  loadModel(id: string, contextSize?: number): Promise<LocalSnapshot>
  stopModel(): Promise<LocalSnapshot>
  deleteModel(id: string): Promise<LocalSnapshot>
  refreshModels(): Promise<LocalSnapshot>
  updateSettings(patch: Partial<LocalSettings>): Promise<LocalSnapshot>
  searchHf(query: string): Promise<HfModelSummary[]>
  getHfModel(repo: string): Promise<HfModelDetail>
  download(repo: string, files: string[]): Promise<LocalSnapshot>
  pauseDownload(id: string): Promise<LocalSnapshot>
  resumeDownload(id: string): Promise<LocalSnapshot>
  cancelDownload(id: string): Promise<LocalSnapshot>
  setHfToken(token: string | null): Promise<LocalSnapshot>
  chooseModelsDir(): Promise<string | null>
  revealModelsDir(): Promise<void>
  // 返回退订函数；快照由主进程节流后推送，订阅者不必自己轮询。
  onState(cb: (snapshot: LocalSnapshot) => void): () => void
}

export interface TokenHubApi {
  getState(): Promise<AppState>
  addProvider(input: ProviderInput): Promise<void>
  updateProvider(id: string, patch: ProviderPatch): Promise<void>
  deleteProvider(id: string): Promise<void>
  reorderProviders(ids: string[]): Promise<void>
  setProviderEnabled(id: string, enabled: boolean): Promise<void>
  testProvider(input: ProviderInput, id?: string): Promise<TestResult>
  refreshModels(id?: string): Promise<void>
  scanProviderProtocols(id: string): Promise<ProtocolScanResult>
  resetProvider(id: string): Promise<void>
  saveModelAlias(alias: ModelAlias, previousId?: string): Promise<void>
  deleteModelAlias(id: string): Promise<void>
  // meta 为 null 时恢复内置建议。
  saveModelMeta(providerId: string, upstreamModel: string, meta: ModelMeta | null): Promise<void>
  // 展示层隐藏：不影响路由，隐藏的模型仍可被调用。
  setModelHidden(providerId: string, upstreamModel: string, hidden: boolean): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  setLocalKey(key: string | null): Promise<void>
  setPaused(paused: boolean): Promise<void>
  getHistory(day: string, limit?: number): Promise<HistoryRecord[]>
  getSpeedStats(day: string): Promise<ProviderSpeedStats[]>
  getUsageStats(): Promise<ProviderUsageStats[]>
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  installUpdate(): Promise<void>
  onUpdate(cb: (state: UpdateState) => void): () => void
  onState(cb: (state: AppState) => void): () => void
  local: LocalApi
}

export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
}

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  availableVersion?: string
  progress?: UpdateProgress
  message?: string
  checkedAt?: string
}
