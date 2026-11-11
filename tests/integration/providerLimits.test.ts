import { afterEach, describe, expect, it } from 'vitest'
import { buildCatalog } from '../../core/providers/catalog'
import { createProviderFromPreset } from '../../core/providers/presets'
import { RuntimeStore } from '../../core/router/runtime'
import { startServer, type RunningServer } from '../../core/server/start'
import { startFakeUpstream, type FakeResponse } from '../helpers/fakeUpstream'
import type { AppConfig, HistoryRecord, ProviderConfig } from '../../core/types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const openAiJson = JSON.stringify({
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 }
})

function provider(id: string, baseUrl: string, maxConcurrency: number): ProviderConfig {
  const p = createProviderFromPreset('custom', id)
  p.name = id
  p.baseUrl = baseUrl
  p.models.cached = ['m']
  p.maxConcurrency = maxConcurrency
  return p
}

describe('provider concurrency and rate-limit retry', () => {
  let closeServer: RunningServer | undefined
  let closeUpstream: (() => Promise<void>) | undefined

  afterEach(async () => {
    await closeServer?.close()
    await closeUpstream?.()
    closeServer = undefined
    closeUpstream = undefined
  })

  async function boot(
    handler: (path: string, body: string) => FakeResponse | Promise<FakeResponse>,
    maxConcurrency: number,
    rateLimitRetryMs = 0
  ) {
    const upstream = await startFakeUpstream(handler)
    closeUpstream = upstream.close
    const providers = [provider('p1', `${upstream.url}/p1/v1`, maxConcurrency)]
    const runtime = new RuntimeStore()
    const history: HistoryRecord[] = []
    const config: AppConfig = {
      version: 1,
      providers,
      modelAliases: [],
      settings: { port: 0, localKeyEnabled: false, autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const server = await startServer({
      getConfig: () => config,
      getProviderKey: () => 'sk-p1',
      getLocalApiKey: () => null,
      getCatalog: () => buildCatalog(providers),
      runtime,
      history: { append: async (record) => { history.push(record) } },
      isPaused: () => false,
      rateLimitRetryMs
    }, 0)
    closeServer = server
    return { port: server.port, runtime, history, upstream }
  }

  async function bootTwo(
    handler: (path: string, body: string) => FakeResponse | Promise<FakeResponse>
  ) {
    const upstream = await startFakeUpstream(handler)
    closeUpstream = upstream.close
    const providers = [
      provider('p1', `${upstream.url}/p1/v1`, 1),
      provider('p2', `${upstream.url}/p2/v1`, 1)
    ]
    const runtime = new RuntimeStore()
    const history: HistoryRecord[] = []
    const config: AppConfig = {
      version: 1,
      providers,
      modelAliases: [],
      settings: { port: 0, localKeyEnabled: false, autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const server = await startServer({
      getConfig: () => config,
      getProviderKey: () => 'sk-p1',
      getLocalApiKey: () => null,
      getCatalog: () => buildCatalog(providers),
      runtime,
      history: { append: async (record) => { history.push(record) } },
      isPaused: () => false,
      rateLimitRetryMs: 0
    }, 0)
    closeServer = server
    return { port: server.port, runtime, history, upstream }
  }

  const post = (port: number) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'ping' }] })
  })

  it('queues upstream attempts above the provider concurrency limit', async () => {
    let active = 0
    let maxActive = 0
    const { port, upstream } = await boot(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(80)
      active -= 1
      return { status: 200, body: openAiJson }
    }, 1)

    const responses = await Promise.all([post(port), post(port)])
    expect(responses.map((res) => res.status)).toEqual([200, 200])
    expect(upstream.requests).toHaveLength(2)
    expect(maxActive).toBe(1)
  })

  it('overflows to the next provider when the first is at its concurrency limit', async () => {
    let firstArrived!: () => void
    const seen = new Promise<void>((resolve) => { firstArrived = resolve })
    let releaseFirst!: () => void
    const hold = new Promise<void>((resolve) => { releaseFirst = resolve })
    const { port, upstream } = await bootTwo(async (path) => {
      if (path.startsWith('/p1/')) {
        firstArrived()
        await hold
      }
      return { status: 200, body: openAiJson }
    })

    const first = post(port)
    await seen
    const second = await post(port)

    expect(second.status).toBe(200)
    expect(second.headers.get('x-tokenhub-provider')).toBe('p2')

    releaseFirst()
    expect((await first).status).toBe(200)
    expect(upstream.requests.map((request) => request.path)).toEqual([
      '/p1/v1/chat/completions',
      '/p2/v1/chat/completions'
    ])
  })

  it('keeps the slot while a stream is open and overflows the second request', async () => {
    let firstArrived!: () => void
    const seen = new Promise<void>((resolve) => { firstArrived = resolve })
    const { port, upstream } = await bootTwo(async (path) => {
      if (path.startsWith('/p1/')) {
        firstArrived()
        return {
          status: 200,
          body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          headers: { 'content-type': 'text/event-stream' },
          holdOpen: true
        }
      }
      return { status: 200, body: openAiJson }
    })

    const controller = new AbortController()
    const first = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'ping' }] }),
      signal: controller.signal
    }).catch(() => null)

    await seen
    // 上游已返回响应头且流保持打开：槽位必须继续占用，第二个请求才会转给 p2。
    await sleep(50)
    const second = await post(port)
    expect(second.headers.get('x-tokenhub-provider')).toBe('p2')

    controller.abort()
    await first
    expect(upstream.requests.map((request) => request.path)).toEqual([
      '/p1/v1/chat/completions',
      '/p2/v1/chat/completions'
    ])
  })

  it('retries a rate-limit 429 once before cooling the provider', async () => {
    let calls = 0
    const { port, runtime } = await boot(() => {
      calls += 1
      if (calls === 1) return { status: 429, body: '{"error":{"message":"slow down"}}' }
      return { status: 200, body: openAiJson }
    }, 0)

    const res = await post(port)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    expect(calls).toBe(2)
    expect(runtime.isRoutable('p1')).toBe(true)
  })

  it('does not retry a quota-classified 429', async () => {
    let calls = 0
    const { port, runtime } = await boot(() => {
      calls += 1
      return { status: 429, body: '{"error":{"message":"weekly quota exceeded"}}' }
    }, 0)

    const res = await post(port)
    expect(res.status).toBe(429)
    expect(calls).toBe(1)
    expect(runtime.isRoutable('p1')).toBe(false)
  })
})
