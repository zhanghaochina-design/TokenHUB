import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
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
 * 已有 `.part` 时带 `Range` 续传：只有响应 206 才追加，服务器忽略 Range（200）则从头重写；
 * 任何失败的 HTTP 响应都不删除 `.part`，以便下次继续断点续传。
 */
export async function downloadFile(options: DownloadFileOptions): Promise<{ received: number; total: number | null }> {
  const part = `${options.dest}.part`
  const existing = await stat(part).then((info) => info.size).catch(() => 0)
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (existing > 0) headers.Range = `bytes=${existing}-`

  const response = await options.fetchFn(options.url, { headers, signal: options.signal })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)

  const resumed = response.status === 206 && existing > 0
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