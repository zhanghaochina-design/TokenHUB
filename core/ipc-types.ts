import type { AppState, HistoryRecord, Preset, ProviderConfig, QuotaAdapterId, QuotaSnapshot, Settings } from './types'

export interface ProviderInput {
  preset: Preset
  name: string
  baseUrl: string
  apiKey: string
  // 省略时沿用预设自带的适配器（Task 10 测试与预设页都不必重复填写）。
  quotaAdapter?: QuotaAdapterId
  quota?: Partial<ProviderConfig['quota']>
  manualModels?: string[]
}

export interface ProviderPatch {
  name?: string
  baseUrl?: string
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
  resetProvider(id: string): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  setLocalKey(key: string | null): Promise<void>
  setPaused(paused: boolean): Promise<void>
  getHistory(day: string, limit?: number): Promise<HistoryRecord[]>
  onState(cb: (state: AppState) => void): () => void
}
