import { afterEach, describe, expect, it } from 'vitest'
import { createProviderFromPreset } from '../../core/providers/presets'
import { buildCatalog } from '../../core/providers/catalog'
import { RuntimeStore } from '../../core/router/runtime'
import { startServer } from '../../core/server/start'
import { startFakeUpstream } from '../helpers/fakeUpstream'
import { APP_NAME, MAX_BODY_BYTES } from '../../core/appInfo'
import type { AppDeps } from '../../core/server/app'
import type { AppConfig, HistoryRecord, ProviderConfig } from '../../core/types'

type Handler = Parameters<typeof startFakeUpstream>[0]
type BootOptions = {
  localKey?: string
  paused?: () => boolean
  runtime?: RuntimeStore
  getProviderKey?: (id: string) => string | null
  providerIds?: string[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const noop: Handler = () => ({ status: 200, body: '{}' })

function provider(id: string, baseUrl: string): ProviderConfig {
  const p = createProviderFromPreset('custom', id)
  p.name = id
  p.baseUrl = baseUrl
  p.models.cached = ['m']
  return p
}

describe('server behavior', () => {
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
    const deps: AppDeps = {
      getConfig: () => config,
      getProviderKey: opts.getProviderKey ?? ((id) => `sk-${id}`),
      getLocalApiKey: () => opts.localKey ?? null,
      getCatalog: () => buildCatalog(providers),
      runtime,
      history: { append: async (r) => { records.push(r) } },
      isPaused: opts.paused ?? (() => false)
    }
    const server = await startServer(deps, 0)
    closeServer = server.close
    return { port: server.port, providers, runtime }
  }

  const base = (port: number) => `http://127.0.0.1:${port}`
  const chat = (port: number, body: Record<string, unknown>) => fetch(`${base(port)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  it('serves /health without any authentication', async () => {
    const { port } = await boot(noop, { localKey: 'local-secret' })
    const res = await fetch(`${base(port)}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', name: APP_NAME, paused: false })
  })

  it('returns 503 for /v1/* while routing is paused', async () => {
    const { port } = await boot(noop, { paused: () => true })
    const res = await fetch(`${base(port)}/v1/models`)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { message: 'routing is paused' } })
  })

  it('rejects request bodies over 20MB with 413', async () => {
    const { port } = await boot(noop)
    const res = await fetch(`${base(port)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(MAX_BODY_BYTES + 1)
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: { message: 'request body too large' } })
  })

  it('returns a 404 and a failure history record for an unknown model', async () => {
    const { port } = await boot(noop)
    const res = await chat(port, { model: 'nope', messages: [] })
    expect(res.status).toBe(404)
    expect(res.headers.get('x-tokenhub-provider')).toBeNull()
    await sleep(20)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      model: 'nope', stream: false, httpStatus: 404, outcome: 'error', errorKind: 'model_missing',
      providerId: null, failoverFrom: []
    })
  })

  it('lists models with owned_by and the app name', async () => {
    const { port } = await boot(noop)
    const res = await fetch(`${base(port)}/v1/models`)
    const json = await res.json() as { data: Array<Record<string, unknown>> }
    expect(json.data[0]).toMatchObject({ id: 'm', object: 'model', owned_by: APP_NAME })
    expect(json.data[0]).not.toHaveProperty('created_by')
  })

  it('answers unknown paths with a protocol-shaped 404', async () => {
    const { port } = await boot(noop)
    const res = await fetch(`${base(port)}/v1/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { message: expect.stringContaining('not found') } })
    expect(requests).toHaveLength(0)
  })

  it('returns 503 and records history when no candidate is routable', async () => {
    const runtime = new RuntimeStore()
    const { port, providers } = await boot(noop, { runtime })
    runtime.markFailure(providers[0], { kind: 'quota', status: 429, message: 'quota exceeded', retryAfterMs: null })
    const res = await chat(port, { model: 'm', messages: [] })
    expect(res.status).toBe(503)
    expect(res.headers.get('x-tokenhub-provider')).toBeNull()
    expect(requests).toHaveLength(0)
    await sleep(20)
    expect(records[0]).toMatchObject({ httpStatus: 503, outcome: 'error', providerId: null, failoverFrom: [] })
  })

  it('records the last provider and failover list when all candidates fail', async () => {
    const { port } = await boot((path) => ({ status: 500, body: path.startsWith('/p1/') ? '{"error":{"message":"p1 down"}}' : '{"error":{"message":"p2 down"}}' }), { providerIds: ['p1', 'p2'] })
    const res = await chat(port, { model: 'm', messages: [] })
    expect(res.status).toBe(500)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p2')
    await sleep(20)
    expect(records[0]).toMatchObject({
      httpStatus: 500, outcome: 'error', errorKind: 'transient', providerId: 'p2', failoverFrom: ['p1']
    })
  })

  it('records an upstream 400 and sets the provider header', async () => {
    const { port } = await boot(() => ({ status: 400, body: '{"error":{"message":"bad request"}}' }))
    const res = await chat(port, { model: 'm', messages: [] })
    expect(res.status).toBe(400)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    await sleep(20)
    expect(records[0]).toMatchObject({
      httpStatus: 400, outcome: 'error', errorKind: 'request', providerId: 'p1', failoverFrom: []
    })
  })

  it('records a 502 and cools the provider when the upstream returns invalid JSON', async () => {
    const { port, runtime } = await boot(() => ({ status: 200, body: 'not json at all' }))
    const res = await chat(port, { model: 'm', messages: [] })
    expect(res.status).toBe(502)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    await sleep(20)
    expect(records[0]).toMatchObject({
      httpStatus: 502, outcome: 'error', errorKind: 'transient', providerId: 'p1', failoverFrom: []
    })
    // executeWithFailover 看到 200 就 markSuccess；body 不可解析时必须补偿失败，否则该供应商永远健康。
    expect(runtime.isRoutable('p1')).toBe(false)
    expect(runtime.get('p1').cooldownUntil).not.toBeNull()
  })

  it('records a 401 when the provider key is missing and never calls upstream', async () => {
    const { port } = await boot(noop, { getProviderKey: () => null })
    const res = await chat(port, { model: 'm', messages: [] })
    expect(res.status).toBe(401)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    expect(requests).toHaveLength(0)
    await sleep(20)
    expect(records[0]).toMatchObject({
      httpStatus: 401, outcome: 'error', errorKind: 'auth', providerId: 'p1', failoverFrom: []
    })
  })

  it('forwards Retry-After in seconds when the failure carries retryAfterMs', async () => {
    const { port } = await boot(() => ({
      status: 429,
      headers: { 'retry-after': '7' },
      body: '{"error":{"message":"quota exceeded"}}'
    }))
    const res = await chat(port, { model: 'm', messages: [] })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('7')
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    await sleep(20)
    expect(records[0]).toMatchObject({ httpStatus: 429, outcome: 'error', errorKind: 'quota', providerId: 'p1' })
  })

  it('does not fail over or cool down a provider when the client aborts a non-stream request', async () => {
    const { port, runtime } = await boot(async () => {
      await sleep(400)
      return { status: 200, body: '{"choices":[]}' }
    }, { providerIds: ['p1', 'p2'] })
    const controller = new AbortController()
    const pending = fetch(`${base(port)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
      signal: controller.signal
    }).catch(() => null)
    while (requests.length === 0) await sleep(5)
    controller.abort()
    await pending
    await sleep(100)
    expect(requests).toHaveLength(1)
    expect(runtime.isRoutable('p1')).toBe(true)
    expect(runtime.get('p1').cooldownUntil).toBeNull()
    expect(records[0]).toMatchObject({ outcome: 'error', errorKind: 'request', providerId: 'p1' })
  })
})
