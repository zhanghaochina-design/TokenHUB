import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DownloadManager } from '../../core/local/downloader'
import type { FetchFn } from '../../core/local/http'

const encoder = new TextEncoder()
function body(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    }
  })
}

// 进度是异步刷新的（chunk 落盘后才轮到下一轮事件循环）：轮询比固定 sleep 稳，也不会拖慢成功路径。
async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待条件超时')
}

const GB = 1024 ** 3

describe('DownloadManager', () => {
  it('downloads requested files into the models dir and persists tasks', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-dl-'))
    const modelsDir = join(dataDir, 'models')
    const fetchFn: FetchFn = async (url) =>
      new Response(body(url.endsWith('a.gguf') ? 'aaaa' : 'bb'), {
        status: 200,
        headers: { 'content-length': url.endsWith('a.gguf') ? '4' : '2' }
      })
    const manager = await DownloadManager.open({
      dataDir,
      modelsDir: () => modelsDir,
      baseUrl: () => 'https://huggingface.co',
      token: () => null,
      fetchFn,
      freeSpace: async () => 10 * GB
    })
    await manager.enqueue('Qwen/Qwen3-8B-GGUF', ['a.gguf', 'b.gguf'])
    await manager.waitForIdle()
    expect(await readFile(join(modelsDir, 'Qwen/Qwen3-8B-GGUF/a.gguf'), 'utf8')).toBe('aaaa')
    expect(await readFile(join(modelsDir, 'Qwen/Qwen3-8B-GGUF/b.gguf'), 'utf8')).toBe('bb')
    expect(manager.getTasks()[0].phase).toBe('done')
    await manager.shutdown()
  })

  it('rejects unsafe paths and insufficient disk space', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-dl-'))
    const manager = await DownloadManager.open({
      dataDir,
      modelsDir: () => join(dataDir, 'models'),
      baseUrl: () => 'https://huggingface.co',
      token: () => null,
      fetchFn: async () => new Response('x', { status: 200 }),
      freeSpace: async () => 1
    })
    await expect(manager.enqueue('Qwen/Qwen3-8B-GGUF', ['../evil.gguf'])).rejects.toThrow('路径')
    await expect(manager.enqueue('Qwen/Qwen3-8B-GGUF', ['ok.gguf'])).rejects.toThrow('空间')
    await manager.shutdown()
  })

  it('rejects an unsafe repo or file before touching the disk', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-dl-'))
    let diskChecks = 0
    const manager = await DownloadManager.open({
      dataDir,
      modelsDir: () => join(dataDir, 'models'),
      baseUrl: () => 'https://huggingface.co',
      token: () => null,
      fetchFn: async () => new Response('x', { status: 200 }),
      freeSpace: async () => {
        diskChecks += 1
        return 10 * GB
      }
    })

    // 仓库 ID 会拼成目录名：'Qwen'、'a/b/c' 与 '..' 都必须在探测磁盘空间之前被拒绝。
    await expect(manager.enqueue('Qwen', ['a.gguf'])).rejects.toThrow('org/repo')
    await expect(manager.enqueue('a/b/c', ['a.gguf'])).rejects.toThrow('org/repo')
    await expect(manager.enqueue('Org/..', ['a.gguf'])).rejects.toThrow('org/repo')
    await expect(manager.enqueue('Org/Repo', ['C:/evil.gguf'])).rejects.toThrow('路径')
    await expect(manager.enqueue('Org/Repo', [])).rejects.toThrow('至少选择一个文件')
    expect(diskChecks).toBe(0)
    expect(manager.getTasks()).toEqual([])
    await manager.shutdown()
  })

  it('restores persisted tasks as paused and never auto-resumes them', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-dl-'))
    await mkdir(join(dataDir, 'local'), { recursive: true })
    await writeFile(
      join(dataDir, 'local', 'downloads.json'),
      JSON.stringify([
        {
          id: 't1',
          repo: 'Org/Repo',
          files: [{ path: 'a.gguf', totalBytes: 4, receivedBytes: 2 }],
          phase: 'downloading',
          error: null,
          speedBps: 128,
          createdAt: 'x',
          updatedAt: 'x'
        },
        {
          id: 't2',
          repo: 'Org/Repo',
          files: [{ path: 'b.gguf', totalBytes: 4, receivedBytes: 4 }],
          phase: 'done',
          error: null,
          speedBps: null,
          createdAt: 'x',
          updatedAt: 'x'
        }
      ])
    )
    let requests = 0
    const manager = await DownloadManager.open({
      dataDir,
      modelsDir: () => join(dataDir, 'models'),
      baseUrl: () => 'https://huggingface.co',
      token: () => null,
      fetchFn: async () => {
        requests += 1
        return new Response('x', { status: 200 })
      },
      freeSpace: async () => 10 * GB
    })

    // 重启后立刻抢带宽等于替用户做决定：未完成的任务一律暂停，等用户点继续。
    expect(manager.getTasks().map((task) => task.phase)).toEqual(['paused', 'done'])
    expect(manager.getTasks()[0].speedBps).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toBe(0)
    await manager.shutdown()
  })

  it('keeps totalBytes unknown when the server sends no length', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-dl-'))
    const modelsDir = join(dataDir, 'models')
    // 200 且没有 content-length / content-range：下载器无从得知总量，不能拿已收字节冒充 100%。
    const fetchFn: FetchFn = async () => new Response(body('unknown'), { status: 200 })
    const manager = await DownloadManager.open({
      dataDir,
      modelsDir: () => modelsDir,
      baseUrl: () => 'https://huggingface.co',
      token: () => null,
      fetchFn,
      freeSpace: async () => 10 * GB
    })

    await manager.enqueue('Org/Repo', ['u.gguf'])
    await manager.waitForIdle()

    const task = manager.getTasks()[0]
    expect(task.phase).toBe('done')
    expect(task.files[0].totalBytes).toBe(0)
    expect(task.files[0].receivedBytes).toBe('unknown'.length)
    expect(await readFile(join(modelsDir, 'Org/Repo/u.gguf'), 'utf8')).toBe('unknown')
    await manager.shutdown()
  })

  it('pauses on abort and finishes on resume', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-dl-'))
    const modelsDir = join(dataDir, 'models')
    const full = 'abcdefghij'
    const ranges: Array<string | null> = []
    const fetchFn: FetchFn = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const range = headers.Range ?? null
      ranges.push(range)
      if (ranges.length === 1) {
        // 首个请求只吐 4 字节并挂住；pause 的中断必须让 pipeline 失败，而不是等流自然结束。
        let stream: ReadableStreamDefaultController<Uint8Array> | null = null
        const pending = new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
            controller.enqueue(encoder.encode(full.slice(0, 4)))
          }
        })
        init?.signal?.addEventListener('abort', () => stream?.error(new Error('aborted')))
        return new Response(pending, { status: 200, headers: { 'content-length': String(full.length) } })
      }
      const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
      return new Response(body(full.slice(start)), {
        status: range ? 206 : 200,
        headers: {
          'content-length': String(full.length - start),
          ...(range ? { 'content-range': `bytes ${start}-${full.length - 1}/${full.length}` } : {})
        }
      })
    }
    const manager = await DownloadManager.open({
      dataDir,
      modelsDir: () => modelsDir,
      baseUrl: () => 'https://huggingface.co',
      token: () => null,
      fetchFn,
      freeSpace: async () => 10 * GB
    })

    await manager.enqueue('Org/Repo', ['m.gguf'])
    await waitUntil(() => (manager.getTasks()[0].files[0].receivedBytes ?? 0) >= 4)
    const id = manager.getTasks()[0].id
    await manager.pause(id)
    await manager.waitForIdle()
    expect(manager.getTasks()[0]).toMatchObject({ phase: 'paused', speedBps: null })

    await manager.resume(id)
    await manager.waitForIdle()
    expect(manager.getTasks()[0].phase).toBe('done')
    expect(await readFile(join(modelsDir, 'Org/Repo/m.gguf'), 'utf8')).toBe(full)
    // 暂停后只剩 `.part`，续传必然再请求一次；官方与镜像都支持 Range，第二次要么带 Range 要么从零重来。
    expect(ranges).toHaveLength(2)
    await manager.shutdown()
  })

  it('removes the partial file when an in-flight task is canceled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-dl-'))
    const modelsDir = join(dataDir, 'models')
    const fetchFn: FetchFn = async (_url, init) => {
      // 真 fetch 被中断时会报错响应体：这里照抄这个语义，否则 pipeline 会一直等下一块数据，跑不出取消。
      let stream: ReadableStreamDefaultController<Uint8Array> | null = null
      const pending = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
          controller.enqueue(encoder.encode('abcd'))
        }
      })
      init?.signal?.addEventListener('abort', () => stream?.error(new Error('aborted')))
      return new Response(pending, { status: 200, headers: { 'content-length': '100' } })
    }
    const manager = await DownloadManager.open({
      dataDir,
      modelsDir: () => modelsDir,
      baseUrl: () => 'https://huggingface.co',
      token: () => null,
      fetchFn,
      freeSpace: async () => 10 * GB
    })
    await manager.enqueue('Org/Repo', ['m.gguf'])
    // 等首批字节真正落到 `.part`：取消要验证的是「下载途中作废」，不是空闲任务的状态迁移。
    await waitUntil(() => (manager.getTasks()[0]?.files[0].receivedBytes ?? 0) >= 4)
    const id = manager.getTasks()[0].id
    expect(manager.getTasks()[0].phase).toBe('downloading')

    await manager.cancel(id)

    expect(manager.getTasks()[0]).toMatchObject({ phase: 'canceled', speedBps: null })
    // 取消等于作废：留着 `.part` 既占空间，也会让下次重新下载误续上旧数据。
    await expect(readFile(join(modelsDir, 'Org', 'Repo', 'm.gguf.part'), 'utf8')).rejects.toThrow()
    // 取消后的任务不再被 resume 复活。
    await manager.resume(id)
    await manager.waitForIdle()
    expect(manager.getTasks()[0].phase).toBe('canceled')
    await manager.shutdown()
  })

  it('rejects a duplicate task for a file that is already queued or downloading', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-dl-'))
    const modelsDir = join(dataDir, 'models')
    // 永不返回（只在 abort 时 reject）：让首条任务一直停在 downloading。
    const fetchFn: FetchFn = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const manager = await DownloadManager.open({
      dataDir,
      modelsDir: () => modelsDir,
      baseUrl: () => 'https://huggingface.co',
      token: () => null,
      fetchFn,
      freeSpace: async () => 10 * GB
    })
    await manager.enqueue('Org/Repo', ['a.gguf'])
    await waitUntil(() => manager.getTasks()[0]?.phase === 'downloading')

    // 同一仓库同一路径会写同一个 `.part`：重复入队必须在建任务之前被拒，队列里仍只有一条。
    await expect(manager.enqueue('Org/Repo', ['a.gguf'])).rejects.toThrow('该文件已在下载队列中')
    await expect(manager.enqueue('Org/Repo', ['a.gguf', 'b.gguf'])).rejects.toThrow('该文件已在下载队列中')
    expect(manager.getTasks()).toHaveLength(1)

    // 没有交集的请求不受影响：不同文件、不同仓库的同名文件落在不同目录。
    await manager.enqueue('Org/Repo', ['b.gguf'])
    await manager.enqueue('Other/Repo', ['a.gguf'])
    expect(manager.getTasks()).toHaveLength(3)
    await manager.shutdown()
  })

  it('keeps canceled and error tasks as-is when reopened', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-dl-'))
    await mkdir(join(dataDir, 'local'), { recursive: true })
    const persisted = (id: string, path: string, phase: string, error: string | null = null) => ({
      id,
      repo: 'Org/Repo',
      files: [{ path, totalBytes: 4, receivedBytes: 1 }],
      phase,
      error,
      speedBps: null,
      createdAt: 'x',
      updatedAt: 'x'
    })
    await writeFile(
      join(dataDir, 'local', 'downloads.json'),
      JSON.stringify([
        persisted('c1', 'a.gguf', 'canceled'),
        persisted('e1', 'b.gguf', 'error', 'download failed: HTTP 500'),
        persisted('q1', 'c.gguf', 'queued'),
        persisted('d1', 'd.gguf', 'downloading')
      ])
    )
    const manager = await DownloadManager.open({
      dataDir,
      modelsDir: () => join(dataDir, 'models'),
      baseUrl: () => 'https://huggingface.co',
      token: () => null,
      fetchFn: async () => new Response('x', { status: 200 }),
      freeSpace: async () => 10 * GB
    })
    const byId = new Map(manager.getTasks().map((entry) => [entry.id, entry]))

    // 只有「本该在跑」的两种状态降级为暂停；取消/失败是用户已经看到过的终态，不能被改写。
    expect(byId.get('c1')?.phase).toBe('canceled')
    expect(byId.get('e1')).toMatchObject({ phase: 'error', error: 'download failed: HTTP 500' })
    expect(byId.get('q1')?.phase).toBe('paused')
    expect(byId.get('d1')?.phase).toBe('paused')

    await manager.resume('c1')
    expect(manager.getTasks().find((entry) => entry.id === 'c1')?.phase).toBe('canceled')
    await manager.shutdown()
  })

  it('resolves shutdown even when a fetch ignores the abort signal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-dl-'))
    const manager = await DownloadManager.open({
      dataDir,
      modelsDir: () => join(dataDir, 'models'),
      baseUrl: () => 'https://huggingface.co',
      token: () => null,
      // 既不理会 signal 也永不返回：只能靠 shutdown 自己的超时兜底。
      fetchFn: () => new Promise<Response>(() => {}),
      freeSpace: async () => 10 * GB
    })
    await manager.enqueue('Org/Repo', ['a.gguf'])
    await waitUntil(() => manager.getTasks()[0]?.phase === 'downloading')

    const startedAt = Date.now()
    await manager.shutdown()
    expect(Date.now() - startedAt).toBeLessThan(6_000)
    // 超时收敛成 paused：重启后是「可续传的暂停」，而不是永远挂在下载中。
    expect(manager.getTasks()[0].phase).toBe('paused')
    const persisted = JSON.parse(await readFile(join(dataDir, 'local', 'downloads.json'), 'utf8')) as Array<{
      phase: string
    }>
    expect(persisted[0].phase).toBe('paused')
  }, 15_000)
})