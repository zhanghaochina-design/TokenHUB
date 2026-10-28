import { afterEach, describe, expect, it } from 'vitest'
import { createProviderFromPreset } from '../../core/providers/presets'
import { buildCatalog } from '../../core/providers/catalog'
import { RuntimeStore } from '../../core/router/runtime'
import { startServer } from '../../core/server/start'
import { startFakeUpstream } from '../helpers/fakeUpstream'
import type { AppConfig, HistoryRecord, ProviderConfig } from '../../core/types'

function provider(id: string, baseUrl: string): ProviderConfig {
  const p = createProviderFromPreset('custom', id)
  p.baseUrl = baseUrl
  p.models.cached = ['m']
  return p
}

/** 有界等待历史写入：轮询 + 截止时间，避免固定 sleep 造成的挂起或慢机抖动。 */
async function waitForRecord(records: HistoryRecord[], timeoutMs = 3_000): Promise<HistoryRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (records.length > 0) return records[0]
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for a history record')
}

describe('streaming proxy', () => {
  let closeUpstream: (() => Promise<void>) | undefined
  let closeServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    await closeServer?.()
    await closeUpstream?.()
    closeServer = undefined
    closeUpstream = undefined
  })

  it('streams SSE and records usage', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n'
    const upstream = await startFakeUpstream(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse }))
    closeUpstream = upstream.close
    const p1 = provider('p1', `${upstream.url}/p1/v1`)
    const config: AppConfig = {
      version: 1, providers: [p1],
      settings: { port: 0, localKeyEnabled: false, autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const records: HistoryRecord[] = []
    const server = await startServer({
      getConfig: () => config,
      getProviderKey: () => 'sk-p1',
      getLocalApiKey: () => null,
      getCatalog: () => buildCatalog([p1]),
      runtime: new RuntimeStore(),
      history: { append: async (r) => { records.push(r) } },
      isPaused: () => false
    }, 0)
    closeServer = server.close

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [] })
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(sse)
    await new Promise((r) => setTimeout(r, 50))
    expect(records[0]).toMatchObject({ stream: true, promptTokens: 4, completionTokens: 2 })
  })

  it('fails over before the first byte when the first provider is out of quota', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"from p2"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const upstream = await startFakeUpstream((path) => {
      if (path.startsWith('/p1/')) return { status: 429, body: '{"error":{"message":"quota exceeded"}}' }
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse }
    })
    closeUpstream = upstream.close
    const p1 = provider('p1', `${upstream.url}/p1/v1`)
    const p2 = provider('p2', `${upstream.url}/p2/v1`)
    const config: AppConfig = {
      version: 1, providers: [p1, p2],
      settings: { port: 0, localKeyEnabled: false, autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const records: HistoryRecord[] = []
    const server = await startServer({
      getConfig: () => config, getProviderKey: () => 'sk', getLocalApiKey: () => null,
      getCatalog: () => buildCatalog([p1, p2]), runtime: new RuntimeStore(),
      history: { append: async (r) => { records.push(r) } }, isPaused: () => false
    }, 0)
    closeServer = server.close
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [] })
    })
    expect(res.headers.get('x-tokenhub-provider')).toBe('p2')
    expect(await res.text()).toContain('from p2')
    await new Promise((r) => setTimeout(r, 50))
    expect(records[0].failoverFrom).toEqual(['p1'])
  })

  it('does not fail over or cool down a provider when the client aborts', async () => {
    const upstream = await startFakeUpstream(async () => {
      await new Promise((r) => setTimeout(r, 400))
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: [DONE]\n\n' }
    })
    closeUpstream = upstream.close
    const p1 = provider('p1', `${upstream.url}/p1/v1`)
    const p2 = provider('p2', `${upstream.url}/p2/v1`)
    const config: AppConfig = {
      version: 1, providers: [p1, p2],
      settings: { port: 0, localKeyEnabled: false, autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const runtime = new RuntimeStore()
    const records: HistoryRecord[] = []
    const server = await startServer({
      getConfig: () => config, getProviderKey: () => 'sk', getLocalApiKey: () => null,
      getCatalog: () => buildCatalog([p1, p2]), runtime,
      history: { append: async (r) => { records.push(r) } }, isPaused: () => false
    }, 0)
    closeServer = server.close

    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [] }),
      signal: controller.signal
    }).catch(() => null)
    while (upstream.requests.length === 0) await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    await pending
    await new Promise((r) => setTimeout(r, 100))
    expect(upstream.requests).toHaveLength(1)
    expect(runtime.isRoutable('p1')).toBe(true)
    expect(runtime.get('p1').cooldownUntil).toBeNull()
    expect(records[0]).toMatchObject({ outcome: 'error', errorKind: 'request', providerId: 'p1' })
  })

  it('records a transient failure and cools the provider down when the stream breaks after headers', async () => {
    const upstream = await startFakeUpstream(() => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      truncate: true
    }))
    closeUpstream = upstream.close
    const p1 = provider('p1', `${upstream.url}/p1/v1`)
    const p2 = provider('p2', `${upstream.url}/p2/v1`)
    const config: AppConfig = {
      version: 1, providers: [p1, p2],
      settings: { port: 0, localKeyEnabled: false, autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const runtime = new RuntimeStore()
    const records: HistoryRecord[] = []
    const server = await startServer({
      getConfig: () => config, getProviderKey: () => 'sk', getLocalApiKey: () => null,
      getCatalog: () => buildCatalog([p1, p2]), runtime,
      history: { append: async (r) => { records.push(r) } }, isPaused: () => false
    }, 0)
    closeServer = server.close

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [] })
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      // 上游截断后客户端读取预期报错
    }
    expect(text).toContain('partial')
    expect(text).not.toContain('[DONE]')
    expect(upstream.requests).toHaveLength(1)

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ stream: true, outcome: 'error', errorKind: 'transient', providerId: 'p1', httpStatus: 200 })
    expect(record.promptTokens).toBeNull()
    expect(runtime.isRoutable('p1')).toBe(false)
    expect(runtime.get('p1').cooldownUntil).not.toBeNull()
    expect(runtime.get('p1').lastErrorKind).toBe('transient')
    expect(runtime.isRoutable('p2')).toBe(true)
  })

  it('returns 502 and records a failure when the upstream 200 has no body', async () => {
    const p1 = provider('p1', 'http://127.0.0.1:1/p1/v1')
    const config: AppConfig = {
      version: 1, providers: [p1],
      settings: { port: 0, localKeyEnabled: false, autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const records: HistoryRecord[] = []
    const runtime = new RuntimeStore()
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      // 上游对 stream:true 返回 200 但没有响应体
      return new Response(null, { status: 200 })
    }) as unknown as NonNullable<Parameters<typeof startServer>[0]['fetchFn']>
    const server = await startServer({
      getConfig: () => config, getProviderKey: () => 'sk', getLocalApiKey: () => null,
      getCatalog: () => buildCatalog([p1]), runtime,
      history: { append: async (r) => { records.push(r) } }, isPaused: () => false, fetchFn
    }, 0)
    closeServer = server.close

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [] })
    })
    expect(res.status).toBe(502)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    const payload = (await res.json()) as { error?: { message?: string; type?: string } }
    expect(payload.error).toMatchObject({ message: 'upstream returned no body', type: 'api_error' })
    expect(calls).toBe(1)

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ stream: true, outcome: 'error', errorKind: 'transient', providerId: 'p1', httpStatus: 502 })
    // executeWithFailover 在拿到响应头时已 markSuccess，路由必须补记失败，否则供应商一直判健康
    expect(runtime.get('p1').lastErrorKind).toBe('transient')
    expect(runtime.get('p1').cooldownUntil).not.toBeNull()
    expect(runtime.isRoutable('p1')).toBe(false)
  })
})
