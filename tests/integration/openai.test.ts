import { afterEach, describe, expect, it } from 'vitest'
import { createProviderFromPreset } from '../../core/providers/presets'
import { buildCatalog } from '../../core/providers/catalog'
import { RuntimeStore } from '../../core/router/runtime'
import { startServer } from '../../core/server/start'
import { startFakeUpstream } from '../helpers/fakeUpstream'
import type { AppConfig, HistoryRecord, HistorySink, ProviderConfig } from '../../core/types'

function provider(id: string, baseUrl: string, models: string[]): ProviderConfig {
  const p = createProviderFromPreset('custom', id)
  p.name = id
  p.baseUrl = baseUrl
  p.models.cached = models
  return p
}

function makeDeps(providers: ProviderConfig[], history: HistorySink, opts: { localKey?: string } = {}): Parameters<typeof startServer>[0] {
  const config: AppConfig = {
    version: 1,
    providers,
    settings: { port: 0, localKeyEnabled: Boolean(opts.localKey), autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
  }
  return {
    getConfig: () => config,
    getProviderKey: (id) => `sk-${id}`,
    getLocalApiKey: () => opts.localKey ?? null,
    getCatalog: () => buildCatalog(providers),
    runtime: new RuntimeStore(),
    history,
    isPaused: () => false
  }
}

describe('openai non-stream proxy', () => {
  let closeUpstream: (() => Promise<void>) | undefined
  let closeServer: (() => Promise<void>) | undefined
  let baseUrl = ''
  let requests: Array<{ path: string; body: string }> = []
  let records: HistoryRecord[] = []

  async function boot(handler: Parameters<typeof startFakeUpstream>[0], opts: { localKey?: string } = {}) {
    const upstream = await startFakeUpstream(handler)
    baseUrl = upstream.url
    requests = upstream.requests
    closeUpstream = upstream.close
    const providers = [provider('p1', `${baseUrl}/p1/v1`, ['m']), provider('p2', `${baseUrl}/p2/v1`, ['m'])]
    const history: HistorySink = { append: async (r) => { records.push(r) } }
    const started = await startServer(makeDeps(providers, history, opts), 0)
    closeServer = started.close
    return started.port
  }

  afterEach(async () => {
    await closeServer?.()
    await closeUpstream?.()
    records = []
  })

  it('proxies a chat completion and records metadata', async () => {
    const port = await boot((path) => {
      if (path.endsWith('/chat/completions')) {
        return { status: 200, body: JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }) }
      }
      return { status: 404, body: '{}' }
    })
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello' }] })
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ choices: [{ message: { content: 'hi' } }] })
    expect(res.headers.get('x-tokenhub-provider')).toBe('p1')
    expect(requests[0].body).toContain('"model":"m"')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ providerId: 'p1', promptTokens: 5, completionTokens: 3, outcome: 'ok' })
  })

  it('fails over when the first provider is out of quota', async () => {
    const port = await boot((path) => {
      if (path.startsWith('/p1/')) return { status: 429, body: '{"error":{"message":"weekly quota exceeded"}}' }
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'from p2' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }
    })
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] })
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-tokenhub-provider')).toBe('p2')
    expect(records[0].failoverFrom).toEqual(['p1'])
  })

  it('does not fail over on invalid request', async () => {
    const port = await boot(() => ({ status: 400, body: '{"error":{"message":"bad"}}' }))
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] })
    })
    expect(res.status).toBe(400)
    expect(requests).toHaveLength(1)
  })

  it('enforces the optional local key', async () => {
    const port = await boot(() => ({ status: 200, body: '{}' }), { localKey: 'local-secret' })
    const denied = await fetch(`http://127.0.0.1:${port}/v1/models`)
    expect(denied.status).toBe(401)
    const allowed = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { 'x-api-key': 'local-secret' } })
    expect(allowed.status).toBe(200)
  })

  it('returns merged models', async () => {
    const port = await boot(() => ({ status: 200, body: '{}' }))
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`)
    const json = await res.json() as { data: Array<{ id: string }> }
    expect(json.data.map((m) => m.id)).toEqual(['m'])
  })
})
