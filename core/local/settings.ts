import type { BackendPreference, HfEndpointKind, LocalSettings } from './types'

export const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
  modelsDir: '',
  localPort: 8788,
  backend: 'auto',
  gpuDevice: '',
  hfEndpoint: 'official',
  hfEndpointCustom: '',
  githubMirror: '',
  defaultContext: 8192
}

const BACKENDS = new Set<BackendPreference>(['auto', 'cuda', 'vulkan', 'rocm', 'cpu'])
const ENDPOINTS = new Set<HfEndpointKind>(['official', 'mirror', 'custom'])

// 上下文长度上下限：设置页与加载模型（含 IPC 传入的显式值）都用这一组区间收敛。
export const MIN_CONTEXT_TOKENS = 512
export const MAX_CONTEXT_TOKENS = 262144

function intInRange(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
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
    defaultContext: intInRange(input.defaultContext, DEFAULT_LOCAL_SETTINGS.defaultContext, MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS)
  }
}

export function hfBaseUrl(settings: Pick<LocalSettings, 'hfEndpoint' | 'hfEndpointCustom'>): string {
  if (settings.hfEndpoint === 'mirror') return 'https://hf-mirror.com'
  if (settings.hfEndpoint === 'custom' && settings.hfEndpointCustom) return settings.hfEndpointCustom
  return 'https://huggingface.co'
}