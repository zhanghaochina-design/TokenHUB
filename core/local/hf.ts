import type { FetchFn } from './http'
import { quantFromFileName, splitInfo } from './library'
import type { HfModelDetail, HfModelFile, HfModelSummary } from './types'

// HF 仓库 ID 固定为 org/repo 两段；不校验会让请求路径被 `..` 或多余斜杠带出 API 目录。
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/
const GGUF_EXT = '.gguf'

// 字面上 `..`/`.` 也符合 REPO_PATTERN 的字符集，必须单独拒绝，否则 resolve 地址会逃出仓库路径。
function isRepoId(repo: string): boolean {
  if (!REPO_PATTERN.test(repo)) return false
  return repo.split('/').every((segment) => segment !== '.' && segment !== '..')
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, '')
}

// 官方/镜像/自定义共用同一套 API 形状；URLSearchParams 按 application/x-www-form-urlencoded
// 把空格编码成 `+`，与 HF 官网一致。
export function hfSearchUrl(base: string, query: string): string {
  const params = new URLSearchParams({
    search: query.trim(),
    filter: 'gguf',
    sort: 'downloads',
    direction: '-1',
    limit: '50'
  })
  return `${trimBase(base)}/api/models?${params.toString()}`
}

export function hfModelUrl(base: string, repo: string): string {
  return `${trimBase(base)}/api/models/${repo}?blobs=true`
}

// 下载地址不在 API 路径下：/{repo}/resolve/main/{path}，逐段编码以保留子目录分隔符。
export function hfResolveUrl(base: string, repo: string, path: string): string {
  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${trimBase(base)}/${repo}/resolve/main/${encoded}`
}

function licenseOf(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null
  const tag = tags.find((item) => typeof item === 'string' && item.startsWith('license:'))
  return typeof tag === 'string' ? tag.slice('license:'.length) : null
}

// gated 有三种取值：false / "auto" / "manual"，后两者都需要用户先同意条款并携带 Token。
function gatedOf(raw: unknown): boolean {
  return raw === true || raw === 'auto' || raw === 'manual'
}

// 上游字段可能是字符串或缺失；非有限数值统一归零，避免 NaN 流到界面。
function countOf(raw: unknown): number {
  const value = Number(raw ?? 0)
  return Number.isFinite(value) ? value : 0
}

export function parseHfSearch(payload: unknown): HfModelSummary[] {
  if (!Array.isArray(payload)) return []
  return payload
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      id: String(item.id ?? ''),
      downloads: countOf(item.downloads),
      likes: countOf(item.likes),
      lastModified: String(item.lastModified ?? ''),
      license: licenseOf(item.tags),
      gated: gatedOf(item.gated)
    }))
    .filter((item) => item.id)
}

export function parseHfModel(repoId: string, payload: unknown): HfModelDetail {
  const data = (payload ?? {}) as Record<string, unknown>
  const siblings = Array.isArray(data.siblings) ? data.siblings : []
  const files: HfModelFile[] = []
  for (const raw of siblings) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { rfilename?: unknown; size?: unknown; lfs?: { size?: unknown } }
    const path = typeof entry.rfilename === 'string' ? entry.rfilename : ''
    // 只保留可推理的 GGUF；README、tokenizer 等其它文件由下载层过滤，不需要暴露给界面。
    if (!path.toLowerCase().endsWith(GGUF_EXT)) continue
    // LFS 文件（托管的大权重）真实大小只在 lfs.size，顶层 size 是占位值。
    const size = Number(entry.lfs?.size ?? entry.size ?? 0)
    const name = path.split('/').pop() ?? path
    const split = splitInfo(name)
    files.push({
      path,
      sizeBytes: Number.isFinite(size) ? size : 0,
      quant: quantFromFileName(name),
      split: split ? { part: split.part, total: split.total } : null,
      // mmproj-*.gguf 是视觉投影权重（adapter），须与主模型一起下载，但不能作为独立模型。
      isAdapter: name.toLowerCase().startsWith('mmproj')
    })
  }
  // 按码点排序（不用 localeCompare）：与文件系统/界面的稳定顺序一致，大小写混排时不因区域设置变化。
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { id: repoId, license: licenseOf(data.tags), gated: gatedOf(data.gated), files }
}

export interface HfClientOptions {
  fetchFn: FetchFn
  baseUrl: () => string
  token: () => string | null
}

export class HfClient {
  constructor(private readonly options: HfClientOptions) {}

  private async getJson(url: string): Promise<unknown> {
    const token = this.options.token()
    const response = await this.options.fetchFn(url, {
      headers: token
        ? { Authorization: `Bearer ${token}`, accept: 'application/json' }
        : { accept: 'application/json' }
    })
    // 401/403 对 HF 意味着「缺 Token 或未同意访问条款」，提示用户去设置 Token，而不是当成网络故障。
    if (response.status === 401 || response.status === 403) {
      throw new Error('需要 HuggingFace Token（或该模型需要授权访问）')
    }
    if (response.status === 404) throw new Error('模型不存在或已被删除')
    if (!response.ok) throw new Error(`HF 请求失败：HTTP ${response.status}`)
    return await response.json()
  }

  async search(query: string): Promise<HfModelSummary[]> {
    return parseHfSearch(await this.getJson(hfSearchUrl(this.options.baseUrl(), query)))
  }

  async model(repo: string): Promise<HfModelDetail> {
    if (!isRepoId(repo)) throw new Error('模型 ID 必须形如 org/repo')
    return parseHfModel(repo, await this.getJson(hfModelUrl(this.options.baseUrl(), repo)))
  }
}