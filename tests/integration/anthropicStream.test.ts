import { afterEach, describe, expect, it } from 'vitest'
import { createProviderFromPreset } from '../../core/providers/presets'
import { buildCatalog } from '../../core/providers/catalog'
import { RuntimeStore } from '../../core/router/runtime'
import { startServer } from '../../core/server/start'
import { startFakeUpstream, type FakeResponse } from '../helpers/fakeUpstream'
import type { AppConfig, HistoryRecord, ProviderConfig } from '../../core/types'

type Handler = Parameters<typeof startFakeUpstream>[0]
type BootOptions = {
  providerIds?: string[]
  runtime?: RuntimeStore
  getProviderKey?: (id: string) => string | null
  fetchFn?: NonNullable<Parameters<typeof startServer>[0]['fetchFn']>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function provider(id: string, baseUrl: string): ProviderConfig {
  const p = createProviderFromPreset('custom', id)
  p.name = id
  p.baseUrl = baseUrl
  p.models.cached = ['m']
  return p
}

/** 有界等待历史写入：轮询 + 截止时间，避免固定 sleep 造成的挂起或慢机抖动。 */
async function waitForRecord(records: HistoryRecord[], timeoutMs = 3_000): Promise<HistoryRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (records.length > 0) return records[0]
    await sleep(10)
  }
  throw new Error('timed out waiting for a history record')
}

/** 有界读取直到出现目标片段；超时抛错而不是无限等待。 */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, timeoutMs = 3_000): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), deadline - Date.now())
    })
    try {
      const { done, value } = await Promise.race([reader.read(), timeout])
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes(needle)) return text
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  throw new Error(`did not receive ${needle} before the deadline`)
}

/** 读完整个 SSE 响应；截断场景允许读取报错并保留已收到的片段。 */
async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    // 预期内的截断/错误路径
  }
  return text
}

function parseEvents(text: string): Array<{ event: string; data: any }> {
  return text.split('\n\n').filter((block) => block.trim().length > 0).map((block) => {
    const lines = block.split('\n')
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? ''
    const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim() ?? '{}'
    return { event, data: JSON.parse(data) }
  })
}

const streamMessage = { model: 'm', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'ping' }] }

describe('anthropic streaming transcode', () => {
  let closeUpstream: (() => Promise<void>) | undefined
  let closeServer: (() => Promise<void>) | undefined
  let records: HistoryRecord[] = []
  let requests: Array<{ path: string; body: string }> = []

  afterEach(async () => {
    await closeServer?.()
    await closeUpstream?.()
    closeServer = undefined
    closeUpstream = undefined
    records = []
    requests = []
  })

  async function boot(handler: Handler, opts: BootOptions = {}) {
    const upstream = await startFakeUpstream(handler)
    closeUpstream = upstream.close
    requests = upstream.requests
    const providers = (opts.providerIds ?? ['p1']).map((id) => provider(id, `${upstream.url}/${id}/v1`))
    const runtime = opts.runtime ?? new RuntimeStore()
    const config: AppConfig = {
      version: 1,
      providers,
      settings: { port: 0, localKeyEnabled: false, autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const server = await startServer({
      getConfig: () => config,
      getProviderKey: opts.getProviderKey ?? ((id) => `sk-${id}`),
      getLocalApiKey: () => null,
      getCatalog: () => buildCatalog(providers),
      runtime,
      history: { append: async (r) => { records.push(r) } },
      isPaused: () => false,
      fetchFn: opts.fetchFn
    }, 0)
    closeServer = server.close
    return { port: server.port, runtime, upstream, providers }
  }

  const postMessages = (port: number, body: Record<string, unknown>, signal?: AbortSignal) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })

  it('translates the upstream stream into anthropic SSE and records the real usage', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n'
    ].join('')
    const { port } = await boot(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse }))
    const res = await postMessages(port, streamMessage)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')

    const text = await res.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('event: content_block_delta')
    expect(text).toContain('"text":"hi"')
    expect(text).toContain('event: message_delta')
    expect(text).toContain('event: message_stop')
    expect(text).not.toContain('event: error')

    const events = parseEvents(text)
    // message_start 用本地估算值，history 用上游真实 usage（9）
    expect(events[0].event).toBe('message_start')
    expect(events[0].data.message.usage.input_tokens).toBeGreaterThan(0)
    expect(events[0].data.message.usage.input_tokens).not.toBe(9)
    const delta = events.find((e) => e.event === 'message_delta')
    expect(delta?.data).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })

    expect(requests).toHaveLength(1)
    expect(requests[0].body).toContain('"stream":true')
    const record = await waitForRecord(records)
    expect(record).toMatchObject({
      protocol: 'anthropic', model: 'm', providerId: 'p1', upstreamModel: 'm', stream: true,
      httpStatus: 200, outcome: 'ok', promptTokens: 9, completionTokens: 1, errorKind: null, failoverFrom: []
    })
    expect(record.firstByteMs).not.toBeNull()
  })

  it('fails over before the first byte when p1 is rate limited', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"from p2"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const { port, runtime } = await boot((path): FakeResponse => {
      if (path.startsWith('/p1/')) return { status: 429, headers: { 'retry-after': '5' }, body: '{"error":{"message":"slow down"}}' }
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse }
    }, { providerIds: ['p1', 'p2'] })
    const res = await postMessages(port, streamMessage)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p2')
    expect(await res.text()).toContain('from p2')
    expect(requests).toHaveLength(2)

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ protocol: 'anthropic', providerId: 'p2', stream: true, outcome: 'ok', failoverFrom: ['p1'] })
    expect(runtime.get('p1').lastErrorKind).toBe('rate_limit')
    expect(runtime.isRoutable('p1')).toBe(false)
  })

  it('returns an anthropic establishment error with provider and retry-after headers', async () => {
    const { port } = await boot(() => ({ status: 429, headers: { 'retry-after': '7' }, body: '{"error":{"message":"slow down"}}' }))
    const res = await postMessages(port, streamMessage)
    expect(res.status).toBe(429)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    expect(res.headers.get('retry-after')).toBe('7')
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } })

    const record = await waitForRecord(records)
    expect(record).toMatchObject({
      protocol: 'anthropic', stream: true, httpStatus: 429, outcome: 'error', errorKind: 'rate_limit', providerId: 'p1', failoverFrom: []
    })
  })

  it('records an auth failure without calling upstream when the provider key is missing', async () => {
    const { port } = await boot(() => ({ status: 200, body: '{}' }), { getProviderKey: () => null })
    const res = await postMessages(port, streamMessage)
    expect(res.status).toBe(401)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } })
    expect(requests).toHaveLength(0)

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ protocol: 'anthropic', stream: true, httpStatus: 401, outcome: 'error', errorKind: 'auth', providerId: 'p1' })
  })

  it('ends with an error event, cools the provider and never fails over when the upstream truncates after the first byte', async () => {
    const partial = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
    const { port, runtime } = await boot(() => ({
      status: 200, headers: { 'content-type': 'text/event-stream' }, body: partial, truncate: true
    }), { providerIds: ['p1', 'p2'] })
    const res = await postMessages(port, streamMessage)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')

    const text = await readAll(res)
    expect(text).toContain('"text":"partial"')
    expect(text).toContain('event: error')
    expect(text).not.toContain('event: message_delta')
    expect(text).not.toContain('event: message_stop')
    expect(requests).toHaveLength(1)

    const record = await waitForRecord(records)
    expect(record).toMatchObject({
      protocol: 'anthropic', stream: true, providerId: 'p1', httpStatus: 200, outcome: 'error', errorKind: 'transient',
      promptTokens: null, completionTokens: null, failoverFrom: []
    })
    expect(runtime.get('p1').lastErrorKind).toBe('transient')
    expect(runtime.get('p1').cooldownUntil).not.toBeNull()
    expect(runtime.isRoutable('p1')).toBe(false)
    expect(runtime.isRoutable('p2')).toBe(true)
  })

  it('treats an upstream error frame as a failed stream and cools the provider down', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"part"}}]}\n\n',
      'data: {"error":{"message":"upstream overloaded"}}\n\n'
    ].join('')
    const { port, runtime } = await boot(() => ({
      status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse
    }), { providerIds: ['p1', 'p2'] })
    const res = await postMessages(port, streamMessage)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')

    const text = await readAll(res)
    expect(text).toContain('"text":"part"')
    expect(text).toContain('event: error')
    expect(text).toContain('upstream overloaded')
    expect(text).not.toContain('event: message_delta')
    expect(text).not.toContain('event: message_stop')
    expect(requests).toHaveLength(1)

    const record = await waitForRecord(records)
    expect(record).toMatchObject({
      protocol: 'anthropic', stream: true, providerId: 'p1', httpStatus: 200, outcome: 'error', errorKind: 'transient',
      promptTokens: null, completionTokens: null, failoverFrom: []
    })
    expect(runtime.get('p1').lastErrorKind).toBe('transient')
    expect(runtime.get('p1').cooldownUntil).not.toBeNull()
    expect(runtime.isRoutable('p1')).toBe(false)
    expect(runtime.isRoutable('p2')).toBe(true)
  })

  it('returns 502, cools the provider and records a failure when the upstream 200 has no body', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      // 上游对 stream:true 返回 200 但没有响应体
      return new Response(null, { status: 200 })
    }) as unknown as NonNullable<Parameters<typeof startServer>[0]['fetchFn']>
    const { port, runtime } = await boot(() => ({ status: 200 }), { fetchFn })

    const res = await postMessages(port, streamMessage)
    expect(res.status).toBe(502)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    expect(await res.json()).toMatchObject({ type: 'error', error: { message: 'upstream returned no body', type: 'api_error' } })
    expect(calls).toBe(1)
    expect(requests).toHaveLength(0)

    const record = await waitForRecord(records)
    expect(record).toMatchObject({
      protocol: 'anthropic', stream: true, httpStatus: 502, outcome: 'error', errorKind: 'transient', providerId: 'p1'
    })
    // executeWithFailover 在拿到响应头时已 markSuccess，路由必须补记失败，否则供应商一直判健康
    expect(runtime.get('p1').lastErrorKind).toBe('transient')
    expect(runtime.get('p1').cooldownUntil).not.toBeNull()
    expect(runtime.isRoutable('p1')).toBe(false)
  })

  it('does not cool down or fail over when the client aborts after the first byte', async () => {
    const first = 'data: {"choices":[{"delta":{"content":"part"}}]}\n\n'
    const { port, runtime } = await boot(() => ({
      status: 200, headers: { 'content-type': 'text/event-stream' }, body: first, holdOpen: true
    }), { providerIds: ['p1', 'p2'] })

    const controller = new AbortController()
    const pending = postMessages(port, streamMessage, controller.signal)
    const res = await pending
    expect(res.status).toBe(200)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')

    const reader = res.body!.getReader()
    const seen = await readUntil(reader, '"text":"part"')
    expect(seen).toContain('event: content_block_delta')

    controller.abort()
    await reader.cancel().catch(() => {})
    await pending.catch(() => null)

    const record = await waitForRecord(records)
    expect(record).toMatchObject({
      protocol: 'anthropic', stream: true, providerId: 'p1', outcome: 'error', errorKind: 'request',
      promptTokens: null, completionTokens: null
    })
    expect(requests).toHaveLength(1)
    expect(runtime.isRoutable('p1')).toBe(true)
    expect(runtime.get('p1').cooldownUntil).toBeNull()
  })
})
