import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface DownloadFileOptions {
  url: string
  dest: string
  headers?: Record<string, string>
  fetchFn: FetchFn
  signal?: AbortSignal
  onProgress?: (received: number, total: number | null) => void
}

// 已存在的 .part 长度即续传起点；只有「文件不存在」才算没有 .part，其余 stat 失败必须上抛（如 EACCES），
// 否则会被误判成从零下载并覆盖掉可续传的数据。
async function partSize(part: string): Promise<number> {
  try {
    return (await stat(part)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

// 优先读 content-range 的总长度（断点续传时 content-length 只是剩余字节），缺省时按「起点 + 长度」推算。
function totalFromHeaders(headers: Headers, startAt: number): number | null {
  const range = headers.get('content-range')
  if (range) {
    const match = /\/(\d+)$/.exec(range)
    if (match) return Number(match[1])
  }
  const length = headers.get('content-length')
  if (length) return startAt + Number(length)
  return null
}

// 206 的区间起点；解析不到时返回 null（调用方按「无法校验」处理，保持原有续传语义）。
function rangeStartFromHeaders(headers: Headers): number | null {
  const range = headers.get('content-range')
  if (!range) return null
  const match = /bytes\s+(\d+)-/.exec(range)
  return match ? Number(match[1]) : null
}

// 失败响应已不再需要响应体；显式取消，避免连接与流悬挂到 GC。
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

// Windows 上杀毒软件/索引进程可能短暂占用目标文件，重命名失败时按递增间隔重试。
async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      if (attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

/**
 * 下载单个文件，写入 `${dest}.part` 后原子重命名到 `dest`。
 * 已有 `.part` 时带 `Range` 续传：只有 206 且区间起点等于本地长度才追加，服务器忽略 Range（200）或起点不符则从头重写。
 * 416（`.part` 已不小于远端文件，通常因上游替换/缩小）会删掉 `.part` 后不带 Range 重试一次，避免永久卡死。
 * 除 416 外任何失败的 HTTP 响应都不删除 `.part`，以便下次继续断点续传。
 */
export async function downloadFile(options: DownloadFileOptions): Promise<{ received: number; total: number | null }> {
  const part = `${options.dest}.part`
  let existing = await partSize(part)
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  const request = (): Promise<Response> => {
    const ranged = existing > 0 ? { ...headers, Range: `bytes=${existing}-` } : { ...headers }
    return options.fetchFn(options.url, { headers: ranged, signal: options.signal })
  }

  let response = await request()
  if (response.status === 416 && existing > 0) {
    await discardBody(response)
    await rm(part, { force: true })
    existing = 0
    response = await request()
  }
  if (!response.ok) {
    await discardBody(response)
    throw new Error(`download failed: HTTP ${response.status} ${options.url}`)
  }
  if (!response.body) throw new Error(`empty response body: ${options.url}`)

  const rangeStart = rangeStartFromHeaders(response.headers)
  // 起点与本地长度不一致说明服务器给的不是我们要的区间，追加会错位，只能整份重写。
  const resumed = response.status === 206 && existing > 0 && (rangeStart === null || rangeStart === existing)
  const startAt = resumed ? existing : 0
  const total = totalFromHeaders(response.headers, startAt)

  await mkdir(dirname(options.dest), { recursive: true })
  const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' })
  let received = startAt
  const source = Readable.fromWeb(response.body as never)
  await pipeline(
    source,
    async function* (chunks) {
      for await (const chunk of chunks) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        received += buffer.length
        options.onProgress?.(received, total)
        yield buffer
      }
    },
    out
  )
  await renameWithRetry(part, options.dest)
  return { received, total }
}