import type { BackendPreference, HfEndpointKind, KvCacheType, LocalSettings } from './types'

export const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
  modelsDir: '',
  localPort: 8788,
  backend: 'auto',
  gpuDevice: '',
  hfEndpoint: 'official',
  hfEndpointCustom: '',
  githubMirror: '',
  defaultContext: 8192,
  kvCache: 'q8_0'
}

const BACKENDS = new Set<BackendPreference>(['auto', 'cuda', 'vulkan', 'rocm', 'cpu'])
const ENDPOINTS = new Set<HfEndpointKind>(['official', 'mirror', 'custom'])
export const KV_CACHE_TYPES: readonly KvCacheType[] = ['f16', 'q8_0', 'q4_0']

// 上下文长度上下限：设置页与加载模型（含 IPC 传入的显式值）都用这一组区间收敛。
// 上限 1M 与 YaRN 扩展配套：超过模型训练长度时由 service 自动补 rope 参数。
export const MIN_CONTEXT_TOKENS = 512
export const MAX_CONTEXT_TOKENS = 1_048_576

function intInRange(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

export function normalizeKvCache(raw: unknown, fallback: KvCacheType): KvCacheType {
  return typeof raw === 'string' && (KV_CACHE_TYPES as readonly string[]).includes(raw) ? (raw as KvCacheType) : fallback
}

export function normalizeLocalSettings(raw: unknown): LocalSettings {
  const input = (raw ?? {}) as Partial<LocalSettings>
  const backend = BACKENDS.has(input.backend as BackendPreference) ? (input.backend as BackendPreference) : 'auto'
  const hfEndpoint = ENDPOINTS.has(input.hfEndpoint as HfEndpointKind)
    ? (input.hfEndpoint as HfEndpointKind)
    : 'official'
  return {
    modelsDir: typeof input.modelsDir === 'string' ? input.modelsDir.trim() : '',
    localPort: intInRange(input.localPort, DEFAULT_LOCAL_SETTINGS.localPort, 1, 65535),
    backend,
    // 设备标识来自 `--list-devices`，这里只清洗空白；是否可用由加载时对照当前运行时安装记录判断。
    gpuDevice: typeof input.gpuDevice === 'string' ? input.gpuDevice.trim() : '',
    hfEndpoint,
    hfEndpointCustom:
      typeof input.hfEndpointCustom === 'string' ? input.hfEndpointCustom.trim().replace(/\/+$/, '') : '',
    githubMirror: typeof input.githubMirror === 'string' ? input.githubMirror.trim() : '',
    defaultContext: intInRange(input.defaultContext, DEFAULT_LOCAL_SETTINGS.defaultContext, MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS),
    kvCache: normalizeKvCache(input.kvCache, DEFAULT_LOCAL_SETTINGS.kvCache)
  }
}

export function hfBaseUrl(settings: Pick<LocalSettings, 'hfEndpoint' | 'hfEndpointCustom'>): string {
  if (settings.hfEndpoint === 'mirror') return 'https://hf-mirror.com'
  if (settings.hfEndpoint === 'custom' && settings.hfEndpointCustom) return settings.hfEndpointCustom
  return 'https://huggingface.co'
}