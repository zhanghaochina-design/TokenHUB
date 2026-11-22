import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { downloadFile, type FetchFn } from '../../core/local/http'

const encoder = new TextEncoder()

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    }
  })
}

async function tempFile(): Promise<{ dir: string; dest: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tokenhub-http-'))
  return { dir, dest: join(dir, 'model.gguf') }
}

describe('downloadFile', () => {
  it('downloads a new file and reports progress', async () => {
    const { dest } = await tempFile()
    const progress: Array<[number, number | null]> = []
    const fetchFn: FetchFn = async () =>
      new Response(bodyOf('abcd'), { status: 200, headers: { 'content-length': '4' } })
    const result = await downloadFile({ url: 'http://x/file', dest, fetchFn, onProgress: (r, t) => progress.push([r, t]) })
    expect(await readFile(dest, 'utf8')).toBe('abcd')
    expect(result).toEqual({ received: 4, total: 4 })
    expect(progress.at(-1)).toEqual([4, 4])
  })

  it('resumes from an existing .part with Range and appends', async () => {
    const { dest } = await tempFile()
    await writeFile(`${dest}.part`, 'ab')
    let rangeHeader: string | undefined
    const fetchFn: FetchFn = async (_url, init) => {
      rangeHeader = (init?.headers as Record<string, string>).Range
      return new Response(bodyOf('cd'), {
        status: 206,
        headers: { 'content-range': 'bytes 2-3/4', 'content-length': '2' }
      })
    }
    const result = await downloadFile({ url: 'http://x/file', dest, fetchFn })
    expect(rangeHeader).toBe('bytes=2-')
    expect(await readFile(dest, 'utf8')).toBe('abcd')
    expect(result).toEqual({ received: 4, total: 4 })
  })

  it('restarts from scratch when the server ignores Range', async () => {
    const { dest } = await tempFile()
    await writeFile(`${dest}.part`, 'ab')
    const fetchFn: FetchFn = async () =>
      new Response(bodyOf('abcd'), { status: 200, headers: { 'content-length': '4' } })
    const result = await downloadFile({ url: 'http://x/file', dest, fetchFn })
    expect(await readFile(dest, 'utf8')).toBe('abcd')
    expect(result).toEqual({ received: 4, total: 4 })
  })

  it('keeps the .part file when the server fails', async () => {
    const { dest } = await tempFile()
    await writeFile(`${dest}.part`, 'ab')
    const fetchFn: FetchFn = async () => new Response('nope', { status: 404 })
    await expect(downloadFile({ url: 'http://x/file', dest, fetchFn })).rejects.toThrow('HTTP 404')
    expect(await readFile(`${dest}.part`, 'utf8')).toBe('ab')
  })

  it('recovers from 416 by dropping the .part and retrying without Range', async () => {
    const { dest } = await tempFile()
    await writeFile(`${dest}.part`, 'wxyz')
    const ranges: Array<string | undefined> = []
    const fetchFn: FetchFn = async (_url, init) => {
      ranges.push((init?.headers as Record<string, string> | undefined)?.Range)
      if (ranges.length === 1) return new Response(null, { status: 416 })
      return new Response(bodyOf('abcd'), { status: 200, headers: { 'content-length': '4' } })
    }
    const result = await downloadFile({ url: 'http://x/file', dest, fetchFn })
    expect(ranges).toEqual(['bytes=4-', undefined])
    expect(await readFile(dest, 'utf8')).toBe('abcd')
    expect(result).toEqual({ received: 4, total: 4 })
  })

  it('rewrites from scratch when the 206 range start mismatches the .part size', async () => {
    const { dest } = await tempFile()
    await writeFile(`${dest}.part`, 'ab')
    const fetchFn: FetchFn = async () =>
      new Response(bodyOf('abcd'), {
        status: 206,
        headers: { 'content-range': 'bytes 0-3/4', 'content-length': '4' }
      })
    const result = await downloadFile({ url: 'http://x/file', dest, fetchFn })
    expect(await readFile(dest, 'utf8')).toBe('abcd')
    expect(result).toEqual({ received: 4, total: 4 })
  })
})