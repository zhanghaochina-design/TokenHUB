import { afterEach, describe, expect, it } from 'vitest'
import { createProviderFromPreset } from '../../core/providers/presets'
import { buildCatalog } from '../../core/providers/catalog'
import { RuntimeStore } from '../../core/router/runtime'
import { startServer } from '../../core/server/start'
import { startFakeUpstream } from '../helpers/fakeUpstream'
import { MAX_BODY_BYTES } from '../../core/appInfo'
import type { AppConfig, HistoryRecord, ProviderConfig } from '../../core/types'

type Handler = Parameters<typeof startFakeUpstream>[0]
type BootOptions = {
  localKey?: string
  paused?: () => boolean
  runtime?: RuntimeStore
  providerIds?: string[]
  getProviderKey?: (id: string) => string | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const noop: Handler = () => ({ status: 200, body: '{}' })

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

const textMessage = { model: 'm', max_tokens: 50, messages: [{ role: 'user', content: 'ping' }] }

describe('anthropic non-stream', () => {
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
      modelAliases: [],
      settings: { port: 0, localKeyEnabled: Boolean(opts.localKey), autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const server = await startServer({
      getConfig: () => config,
      getProviderKey: opts.getProviderKey ?? ((id) => `sk-${id}`),
      getLocalApiKey: () => opts.localKey ?? null,
      getCatalog: () => buildCatalog(providers),
      runtime,
      history: { append: async (r) => { records.push(r) } },
      isPaused: opts.paused ?? (() => false)
    }, 0)
    closeServer = server.close
    return { port: server.port, runtime, upstream, providers }
  }

  const base = (port: number) => `http://127.0.0.1:${port}`
  const postMessages = (port: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => fetch(`${base(port)}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })

  it('translates request and response', async () => {
    const { port } = await boot(() => ({
      status: 200,
      body: JSON.stringify({ id: 'x', choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 2 } })
    }))
    const res = await postMessages(port, textMessage)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    expect(await res.json()).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 6, output_tokens: 2 }
    })
    expect(requests[0].body).toContain('"messages":[{"role":"user","content":"ping"}]')
    expect(requests[0].body).toContain('"max_tokens":50')

    const record = await waitForRecord(records)
    expect(record).toMatchObject({
      protocol: 'anthropic', model: 'm', providerId: 'p1', upstreamModel: 'm', stream: false,
      httpStatus: 200, outcome: 'ok', promptTokens: 6, completionTokens: 2, errorKind: null, failoverFrom: []
    })
  })

  it('returns anthropic-shaped auth errors and records the failure', async () => {
    const { port } = await boot(() => ({ status: 401, body: 'bad' }))
    const res = await postMessages(port, { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })
    expect(res.status).toBe(401)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } })

    const record = await waitForRecord(records)
    expect(record).toMatchObject({
      protocol: 'anthropic', httpStatus: 401, outcome: 'error', errorKind: 'auth', providerId: 'p1', failoverFrom: []
    })
  })

  it('returns an anthropic 401 when the provider key is missing without calling upstream', async () => {
    const { port } = await boot(noop, { getProviderKey: () => null })
    const res = await postMessages(port, textMessage)
    expect(res.status).toBe(401)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error', message: 'missing api key' } })
    expect(requests).toHaveLength(0)

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ protocol: 'anthropic', httpStatus: 401, errorKind: 'auth', providerId: 'p1' })
  })

  it('records a 404 for an unknown model without a provider header', async () => {
    const { port } = await boot(noop)
    const res = await postMessages(port, { model: 'nope', max_tokens: 10, messages: [] })
    expect(res.status).toBe(404)
    expect(res.headers.get('x-tokenhub-provider')).toBeNull()
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'not_found_error', message: 'unknown model: nope' } })

    const record = await waitForRecord(records)
    expect(record).toMatchObject({
      protocol: 'anthropic', model: 'nope', httpStatus: 404, outcome: 'error', errorKind: 'model_missing',
      providerId: null, failoverFrom: []
    })
  })

  it('returns 503 and records history when no candidate is routable', async () => {
    const { port, runtime, providers } = await boot(noop)
    runtime.markFailure(providers[0], { kind: 'quota', status: 429, message: 'quota exceeded', retryAfterMs: 600_000 })
    const res = await postMessages(port, textMessage)
    expect(res.status).toBe(503)
    expect(res.headers.get('x-tokenhub-provider')).toBeNull()
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'api_error', message: 'no available provider for this model' } })
    expect(requests).toHaveLength(0)

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ protocol: 'anthropic', httpStatus: 503, outcome: 'error', providerId: null, failoverFrom: [] })
  })

  it('forwards Retry-After and maps a quota failure to rate_limit_error', async () => {
    const { port } = await boot(() => ({
      status: 429,
      headers: { 'retry-after': '7' },
      body: '{"error":{"message":"quota exceeded"}}'
    }))
    const res = await postMessages(port, textMessage)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('7')
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } })

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ protocol: 'anthropic', httpStatus: 429, errorKind: 'quota', providerId: 'p1' })
  })

  it('records a 502 and cools the provider when the upstream returns invalid json', async () => {
    const { port, runtime } = await boot(() => ({ status: 200, body: 'not json at all' }))
    const res = await postMessages(port, textMessage)
    expect(res.status).toBe(502)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'api_error', message: 'upstream returned invalid json' } })

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ protocol: 'anthropic', httpStatus: 502, outcome: 'error', errorKind: 'transient', providerId: 'p1' })
    // executeWithFailover 看到 200 就 markSuccess；body 不可解析时必须补偿失败，否则该供应商永远健康。
    expect(runtime.isRoutable('p1')).toBe(false)
    expect(runtime.get('p1').cooldownUntil).not.toBeNull()
  })

  it('fails over to the next provider and records the failover list', async () => {
    const { port } = await boot((path) => {
      if (path.startsWith('/p1/')) return { status: 429, body: '{"error":{"message":"weekly quota exceeded"}}' }
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'from p2' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }
    }, { providerIds: ['p1', 'p2'] })
    const res = await postMessages(port, textMessage)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p2')
    expect(await res.json()).toMatchObject({ content: [{ type: 'text', text: 'from p2' }] })

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ protocol: 'anthropic', providerId: 'p2', outcome: 'ok', failoverFrom: ['p1'] })
  })

  it('does not fail over or cool down a provider when the client aborts a non-stream request', async () => {
    const { port, runtime } = await boot(async () => {
      await sleep(400)
      return { status: 200, body: '{"choices":[]}' }
    }, { providerIds: ['p1', 'p2'] })
    const controller = new AbortController()
    const pending = fetch(`${base(port)}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(textMessage),
      signal: controller.signal
    }).catch(() => null)
    while (requests.length === 0) await sleep(5)
    controller.abort()
    await pending
    expect(requests).toHaveLength(1)
    expect(runtime.isRoutable('p1')).toBe(true)
    expect(runtime.get('p1').cooldownUntil).toBeNull()

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ protocol: 'anthropic', outcome: 'error', errorKind: 'request', providerId: 'p1' })
  })

  it('estimates input tokens for /v1/messages/count_tokens', async () => {
    const { port } = await boot(noop)
    const res = await fetch(`${base(port)}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] })
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { input_tokens?: number }
    expect(json.input_tokens).toBeGreaterThan(0)
    expect(requests).toHaveLength(0)

    const bad = await fetch(`${base(port)}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm' })
    })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } })
  })
})

describe('anthropic protocol detection by anthropic-version header', () => {
  let closeUpstream: (() => Promise<void>) | undefined
  let closeServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    await closeServer?.()
    await closeUpstream?.()
    closeServer = undefined
    closeUpstream = undefined
  })

  async function boot(opts: { localKey?: string; paused?: boolean } = {}) {
    const upstream = await startFakeUpstream(noop)
    closeUpstream = upstream.close
    const p1 = provider('p1', `${upstream.url}/p1/v1`)
    const config: AppConfig = {
      version: 1,
      providers: [p1],
      modelAliases: [],
      settings: { port: 0, localKeyEnabled: Boolean(opts.localKey), autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const server = await startServer({
      getConfig: () => config,
      getProviderKey: () => 'sk-p1',
      getLocalApiKey: () => opts.localKey ?? null,
      getCatalog: () => buildCatalog([p1]),
      runtime: new RuntimeStore(),
      history: { append: async () => {} },
      isPaused: () => Boolean(opts.paused)
    }, 0)
    closeServer = server.close
    return { port: server.port, upstream }
  }

  it('shapes 401 on /v1/models as anthropic when the header is present', async () => {
    const { port } = await boot({ localKey: 'local-secret' })
    const anthropic = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { 'anthropic-version': '2023-06-01' } })
    expect(anthropic.status).toBe(401)
    expect(await anthropic.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } })

    const openai = await fetch(`http://127.0.0.1:${port}/v1/models`)
    expect(openai.status).toBe(401)
    expect(await openai.json()).toMatchObject({ error: { message: 'invalid local api key', type: 'api_error' } })
  })

  it('shapes 503 while paused as anthropic when the header is present', async () => {
    const { port } = await boot({ paused: true })
    const paused = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { 'anthropic-version': '2023-06-01' } })
    expect(paused.status).toBe(503)
    expect(await paused.json()).toMatchObject({ type: 'error', error: { message: 'routing is paused' } })
  })

  it('shapes 413 and unknown-path 404 as anthropic when the header is present', async () => {
    const { port, upstream } = await boot()
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: 'x'.repeat(MAX_BODY_BYTES + 1)
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ type: 'error', error: { message: 'request body too large' } })
    expect(upstream.requests).toHaveLength(0)

    const missing = await fetch(`http://127.0.0.1:${port}/v1/nope`, { headers: { 'anthropic-version': '2023-06-01' } })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ type: 'error', error: { message: expect.stringContaining('not found') } })
  })
})
