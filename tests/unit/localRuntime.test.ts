import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { LocalRuntime, buildLlamaArgs, type ChildHandle, type LocalRuntimeOptions, type RuntimeSpawnPorts } from '../../core/local/runtime'
import type { FetchFn } from '../../core/local/http'

const install = {
  backend: 'vulkan' as const,
  tag: 'b1',
  installedAt: '2026-01-01T00:00:00.000Z',
  devices: ['Vulkan0: AMD Radeon RX 7900 XTX'],
  sourceUrl: 'x',
  exePath: 'C:/rt/llama-server.exe'
}

function fakeFetch(ok: boolean): FetchFn {
  return async (url) => {
    if (url.endsWith('/health')) return new Response(ok ? 'ok' : 'loading', { status: ok ? 200 : 503 })
    if (url.endsWith('/props')) {
      return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// 假 stdout：真 Readable，不需要进程也不开 socket；测试自己决定什么时候推数据、推多少。
function fakeStdout(): { stream: Readable; write: (text: string) => void } {
  const stream = new Readable({ read: () => {} })
  return { stream, write: (text) => stream.push(text) }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function makeRuntime(
  options: Partial<LocalRuntimeOptions> & Pick<LocalRuntimeOptions, 'spawnPorts' | 'fetchFn'>
): LocalRuntime {
  return new LocalRuntime({
    getInstall: () => install,
    getPort: () => 8788,
    healthPollMs: 1,
    loadTimeoutMs: 200,
    ...options
  })
}

function fakeChild(pid: number, hooks?: { exit: ((code: number | null) => void) | null }): ChildHandle {
  return {
    pid,
    kill: () => true,
    once: (_event, cb) => {
      if (hooks) hooks.exit = cb
    },
    stdout: null,
    stderr: null
  }
}

describe('llama args', () => {
  it('builds loopback-only GPU args', () => {
    expect(buildLlamaArgs({ modelPath: 'C:/m.gguf', port: 8788, contextSize: 8192, parallel: 1 })).toEqual([
      '-m', 'C:/m.gguf',
      '--host', '127.0.0.1',
      '--port', '8788',
      '-c', '8192',
      '-ngl', '99',
      '-np', '1',
      '-fa', 'off',
      '--jinja'
    ])
  })

  it('passes the selected device next to the GPU offload flag', () => {
    expect(
      buildLlamaArgs({ modelPath: 'C:/m.gguf', port: 8788, contextSize: 8192, parallel: 1, device: 'Vulkan0' })
    ).toEqual([
      '-m', 'C:/m.gguf',
      '--host', '127.0.0.1',
      '--port', '8788',
      '-c', '8192',
      '-ngl', '99',
      '--device', 'Vulkan0',
      '-np', '1',
      '-fa', 'off',
      '--jinja'
    ])
  })
})

describe('LocalRuntime', () => {
  it('loads a model, reports running and stops it', async () => {
    let exitCb: ((code: number | null) => void) | null = null
    let killed = false
    const child: ChildHandle = {
      pid: 42,
      kill: () => {
        killed = true
        exitCb?.(0)
        return true
      },
      once: (_event, cb) => {
        exitCb = cb
      },
      stdout: null,
      stderr: null
    }
    const ports: RuntimeSpawnPorts = { spawn: () => child }
    const runtime = new LocalRuntime({
      getInstall: () => install,
      getPort: () => 8788,
      spawnPorts: ports,
      fetchFn: fakeFetch(true),
      healthPollMs: 1,
      loadTimeoutMs: 200
    })
    await runtime.load({ modelId: 'm', modelPath: 'C:/m.gguf' }, 'vulkan', 8192)
    expect(runtime.getStatus()).toMatchObject({ phase: 'running', modelId: 'm', port: 8788, contextLength: 8192 })
    await runtime.stop()
    expect(killed).toBe(true)
    expect(runtime.getStatus()).toMatchObject({ phase: 'stopped', modelId: null })
  })

  it('reports an error when the process never becomes healthy', async () => {
    const child: ChildHandle = { pid: 7, kill: () => true, once: () => {}, stdout: null, stderr: null }
    const runtime = new LocalRuntime({
      getInstall: () => install,
      getPort: () => 8788,
      spawnPorts: { spawn: () => child },
      fetchFn: fakeFetch(false),
      healthPollMs: 1,
      loadTimeoutMs: 30
    })
    await runtime.load({ modelId: 'm', modelPath: 'C:/m.gguf' }, 'vulkan', 8192)
    expect(runtime.getStatus().phase).toBe('error')
    expect(runtime.getStatus().error).toContain('超时')
  })

  it('reports an error when the process exits during load', async () => {
    // 回调存在对象里：用 `let` 变量时 TS 的控制流分析会把它当成恒为 null，`exitCb?.()` 直接报 never。
    const hooks: { exit: ((code: number | null) => void) | null } = { exit: null }
    const child: ChildHandle = {
      pid: 8,
      kill: () => true,
      once: (_event, cb) => {
        hooks.exit = cb
      },
      stdout: null,
      stderr: null
    }
    const runtime = new LocalRuntime({
      getInstall: () => install,
      getPort: () => 8788,
      spawnPorts: { spawn: () => child },
      fetchFn: fakeFetch(false),
      healthPollMs: 1,
      loadTimeoutMs: 200
    })
    const loading = runtime.load({ modelId: 'm', modelPath: 'C:/m.gguf' }, 'vulkan', 8192)
    await new Promise((resolve) => setTimeout(resolve, 5))
    hooks.exit?.(1)
    await loading
    expect(runtime.getStatus().phase).toBe('error')
    expect(runtime.getStatus().error).toContain('退出')
  })

  it('keeps the exit error when the child dies while /props is in flight', async () => {
    const hooks: { exit: ((code: number | null) => void) | null } = { exit: null }
    const props = deferred<Response>()
    let propsRequested = false
    const fetchFn: FetchFn = async (url) => {
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.endsWith('/props')) {
        propsRequested = true
        return props.promise
      }
      return new Response('{}', { status: 200 })
    }
    const runtime = makeRuntime({ spawnPorts: { spawn: () => fakeChild(9, hooks) }, fetchFn, loadTimeoutMs: 500 })

    const loading = runtime.load({ modelId: 'm', modelPath: 'C:/m.gguf' }, 'vulkan', 8192)
    await waitFor(() => propsRequested, '/props 请求')
    hooks.exit?.(1)
    props.resolve(new Response(JSON.stringify({ default_generation_settings: { n_ctx: 4096 } }), { status: 200 }))
    await loading

    // 退出路径写的 error 必须保留：`/props` 晚到不能把它翻成 running，也不能采纳 n_ctx 4096。
    expect(runtime.getStatus()).toMatchObject({ phase: 'error', contextLength: 8192 })
    expect(runtime.getStatus().error).toContain('退出')
  })

  it('keeps stopped when the user stops while /props is in flight', async () => {
    const props = deferred<Response>()
    let propsRequested = false
    const fetchFn: FetchFn = async (url) => {
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.endsWith('/props')) {
        propsRequested = true
        return props.promise
      }
      return new Response('{}', { status: 200 })
    }
    const runtime = makeRuntime({ spawnPorts: { spawn: () => fakeChild(10) }, fetchFn, loadTimeoutMs: 500 })

    const loading = runtime.load({ modelId: 'm', modelPath: 'C:/m.gguf' }, 'vulkan', 8192)
    await waitFor(() => propsRequested, '/props 请求')
    await runtime.stop()
    expect(runtime.getStatus().phase).toBe('stopped')

    props.resolve(new Response(JSON.stringify({ default_generation_settings: { n_ctx: 4096 } }), { status: 200 }))
    await loading
    expect(runtime.getStatus()).toMatchObject({ phase: 'stopped', modelId: null, contextLength: null })
  })

  it('does not report an error when the exit arrives after stop', async () => {
    const hooks: { exit: ((code: number | null) => void) | null } = { exit: null }
    const phases: string[] = []
    const runtime = makeRuntime({
      spawnPorts: { spawn: () => fakeChild(5, hooks) },
      fetchFn: fakeFetch(true),
      onState: (status) => phases.push(status.phase)
    })

    await runtime.load({ modelId: 'm', modelPath: 'C:/m.gguf' }, 'vulkan', 8192)
    expect(runtime.getStatus().phase).toBe('running')
    await runtime.stop()
    // kill 后才到的 exit 属于主动停止，不能把 stopped 改成 error。
    hooks.exit?.(0)
    expect(runtime.getStatus().phase).toBe('stopped')
    expect(phases).not.toContain('error')
  })

  it('kills the whole process tree on stop when killTree is provided', async () => {
    const killed: number[] = []
    const runtime = makeRuntime({
      spawnPorts: {
        spawn: () => fakeChild(42),
        killTree: async (pid) => {
          killed.push(pid)
        }
      },
      fetchFn: fakeFetch(true)
    })

    await runtime.load({ modelId: 'm', modelPath: 'C:/m.gguf' }, 'vulkan', 8192)
    await runtime.stop()
    expect(killed).toEqual([42])
  })

  it('keeps only the last 20 log lines of a chatty child', async () => {
    const out = fakeStdout()
    const child: ChildHandle = { ...fakeChild(11), stdout: out.stream }
    const runtime = makeRuntime({ spawnPorts: { spawn: () => child }, fetchFn: fakeFetch(true) })

    await runtime.load({ modelId: 'm', modelPath: 'C:/m.gguf' }, 'vulkan', 8192)
    for (let i = 0; i < 250; i += 1) out.write(`line-${i}\n`)
    await waitFor(() => runtime.getStatus().logTail.at(-1) === 'line-249', '最后一行日志')

    const logTail = runtime.getStatus().logTail
    expect(logTail).toHaveLength(20)
    expect(logTail[0]).toBe('line-230')
    expect(logTail[19]).toBe('line-249')
  })

  it('flushes the trailing partial log line when the child exits', async () => {
    const out = fakeStdout()
    const hooks: { exit: ((code: number | null) => void) | null } = { exit: null }
    const child: ChildHandle = { ...fakeChild(12, hooks), stdout: out.stream }
    const runtime = makeRuntime({ spawnPorts: { spawn: () => child }, fetchFn: fakeFetch(true) })

    await runtime.load({ modelId: 'm', modelPath: 'C:/m.gguf' }, 'vulkan', 8192)
    out.write('failed to bind port 8788\n')
    out.write('fatal: address already in use')
    await waitFor(() => runtime.getStatus().logTail.length === 1, '第一行日志')

    // 真正的 close 常常只发 exit 不发 end：没有 flush 时这段报错会丢。
    hooks.exit?.(0)
    expect(runtime.getStatus().logTail).toEqual(['failed to bind port 8788', 'fatal: address already in use'])
    expect(runtime.getStatus().phase).toBe('error')
  })

  it('falls back to the requested context when /props fails', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.endsWith('/health')) return new Response('ok', { status: 200 })
      if (url.endsWith('/props')) return new Response('nope', { status: 500 })
      return new Response('{}', { status: 200 })
    }
    const runtime = makeRuntime({ spawnPorts: { spawn: () => fakeChild(13) }, fetchFn })

    await runtime.load({ modelId: 'm', modelPath: 'C:/m.gguf' }, 'vulkan', 4096)
    expect(runtime.getStatus()).toMatchObject({ phase: 'running', contextLength: 4096 })
  })

  it('bounds hung probes with a timeout signal so the load timeout still fires', async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    const fetchFn: FetchFn = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        signals.push(signal)
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const runtime = makeRuntime({ spawnPorts: { spawn: () => fakeChild(6) }, fetchFn, loadTimeoutMs: 30 })

    await runtime.load({ modelId: 'm', modelPath: 'C:/m.gguf' }, 'vulkan', 8192)
    expect(runtime.getStatus().phase).toBe('error')
    expect(runtime.getStatus().error).toContain('超时')
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
  })
})