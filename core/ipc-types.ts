import type { AppState, HistoryRecord, ModelAlias, Preset, ProtocolScanResult, ProviderConfig, ProviderSpeedStats, QuotaAdapterId, QuotaSnapshot, Settings } from './types'

export interface ProviderInput {
  preset: Preset
  name: string
  baseUrl: string
  anthropicBaseUrl?: string
  apiKey: string
  // 省略时沿用预设自带的适配器（Task 10 测试与预设页都不必重复填写）。
  quotaAdapter?: QuotaAdapterId
  quota?: Partial<ProviderConfig['quota']>
  manualModels?: string[]
}

export interface ProviderPatch {
  name?: string
  baseUrl?: string
  anthropicBaseUrl?: string
  apiKey?: string
  quotaAdapter?: QuotaAdapterId
  quota?: Partial<ProviderConfig['quota']>
  manualModels?: string[]
  enabled?: boolean
}

export interface TestResult {
  models: string[]
  quota: QuotaSnapshot | null
  error?: string
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
  updateSettings(patch: Partial<Settings>): Promise<void>
  setLocalKey(key: string | null): Promise<void>
  setPaused(paused: boolean): Promise<void>
  getHistory(day: string, limit?: number): Promise<HistoryRecord[]>
  getSpeedStats(day: string): Promise<ProviderSpeedStats[]>
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  installUpdate(): Promise<void>
  onUpdate(cb: (state: UpdateState) => void): () => void
  onState(cb: (state: AppState) => void): () => void
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
