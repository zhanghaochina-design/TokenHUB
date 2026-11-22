import { describe, expect, it } from 'vitest'
import { LocalRuntime, buildLlamaArgs, type ChildHandle, type RuntimeSpawnPorts } from '../../core/local/runtime'
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

describe('llama args', () => {
  it('builds loopback-only GPU args', () => {
    expect(buildLlamaArgs({ modelPath: 'C:/m.gguf', port: 8788, contextSize: 8192, parallel: 1 })).toEqual([
      '-m', 'C:/m.gguf',
      '--host', '127.0.0.1',
      '--port', '8788',
      '-c', '8192',
      '-ngl', '99',
      '-np', '1',
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
})