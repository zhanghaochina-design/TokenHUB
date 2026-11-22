import type { BackendPreference, HfEndpointKind, LocalSettings } from './types'

export const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
  modelsDir: '',
  localPort: 8788,
  backend: 'auto',
  hfEndpoint: 'official',
  hfEndpointCustom: '',
  githubMirror: '',
  defaultContext: 8192
}

const BACKENDS = new Set<BackendPreference>(['auto', 'cuda', 'vulkan', 'rocm', 'cpu'])
const ENDPOINTS = new Set<HfEndpointKind>(['official', 'mirror', 'custom'])

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
    hfEndpoint,
    hfEndpointCustom:
      typeof input.hfEndpointCustom === 'string' ? input.hfEndpointCustom.trim().replace(/\/+$/, '') : '',
    githubMirror: typeof input.githubMirror === 'string' ? input.githubMirror.trim() : '',
    defaultContext: intInRange(input.defaultContext, DEFAULT_LOCAL_SETTINGS.defaultContext, 512, 262144)
  }
}

export function hfBaseUrl(settings: Pick<LocalSettings, 'hfEndpoint' | 'hfEndpointCustom'>): string {
  if (settings.hfEndpoint === 'mirror') return 'https://hf-mirror.com'
  if (settings.hfEndpoint === 'custom' && settings.hfEndpointCustom) return settings.hfEndpointCustom
  return 'https://huggingface.co'
}