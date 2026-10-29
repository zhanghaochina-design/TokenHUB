import { describe, expect, it } from 'vitest'
import { startFakeUpstream } from '../helpers/fakeUpstream'
import { createProviderFromPreset } from '../../core/providers/presets'
import { buildCatalog } from '../../core/providers/catalog'
import { RuntimeStore } from '../../core/router/runtime'
import { startServer } from '../../core/server/start'
import type { AppConfig, HistoryRecord, ProviderConfig } from '../../core/types'

function provider(id: string, baseUrl: string, model: string): ProviderConfig {
  const p = createProviderFromPreset('custom', id)
  p.name = id
  p.baseUrl = baseUrl
  p.models.cached = [model]
  return p
}

const settings: AppConfig['settings'] = {
  port: 0,
  localKeyEnabled: false,
  autoStart: false,
  startMinimized: false,
  closeToTray: true,
  retentionDays: 30,
  quotaRefreshSec: 60
}

describe('canonical model aliases', () => {
  it('serves only the canonical id and sends each provider its own upstream id', async () => {
    const upstream = await startFakeUpstream((path) => {
      if (path.startsWith('/p1/')) return { status: 429, body: '{"error":{"message":"weekly quota exceeded"}}' }
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1 }
        })
      }
    })
    const p1 = provider('p1', `${upstream.url}/p1/v1`, 'deepseek-v4.1-flash')
    const p2 = provider('p2', `${upstream.url}/p2/v1`, 'deepseek/deepseek-v4.1-flash')
    const aliases = [
      {
        id: 'deepseek4.1flash',
        targets: [
          { providerId: 'p1', upstreamModel: 'deepseek-v4.1-flash' },
          { providerId: 'p2', upstreamModel: 'deepseek/deepseek-v4.1-flash' }
        ]
      }
    ]
    const config: AppConfig = { version: 1, providers: [p1, p2], modelAliases: aliases, settings }
    const records: HistoryRecord[] = []
    const runtime = new RuntimeStore()
    const server = await startServer(
      {
        getConfig: () => config,
        getProviderKey: () => 'sk',
        getLocalApiKey: () => null,
        getCatalog: () => buildCatalog(config.providers, config.modelAliases),
        runtime,
        history: { append: async (record) => { records.push(record) } },
        isPaused: () => false
      },
      0
    )

    const models = (await (await fetch(`http://127.0.0.1:${server.port}/v1/models`)).json()) as {
      data: Array<{ id: string }>
    }
    expect(models.data.map((model) => model.id)).toEqual(['deepseek4.1flash'])

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek4.1flash', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-tokenhub-provider')).toBe('p2')
    const bodies = upstream.requests.map((request) => JSON.parse(request.body) as { model: string })
    expect(bodies.map((body) => body.model)).toEqual([
      'deepseek-v4.1-flash',
      'deepseek/deepseek-v4.1-flash'
    ])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(records[0]).toMatchObject({
      model: 'deepseek4.1flash',
      providerId: 'p2',
      upstreamModel: 'deepseek/deepseek-v4.1-flash',
      failoverFrom: ['p1']
    })

    await server.close()
    await upstream.close()
  })

  it('supports providerId/canonicalId as a forced route', async () => {
    const upstream = await startFakeUpstream(() => ({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }))
    const p1 = provider('p1', `${upstream.url}/p1/v1`, 'upstream-model')
    const aliases = [{ id: 'local-model', targets: [{ providerId: 'p1', upstreamModel: 'upstream-model' }] }]
    const config: AppConfig = { version: 1, providers: [p1], modelAliases: aliases, settings }
    const server = await startServer(
      {
        getConfig: () => config,
        getProviderKey: () => 'sk',
        getLocalApiKey: () => null,
        getCatalog: () => buildCatalog(config.providers, config.modelAliases),
        runtime: new RuntimeStore(),
        history: { append: async () => {} },
        isPaused: () => false
      },
      0
    )
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'p1/local-model', messages: [] })
    })
    expect(response.status).toBe(200)
    expect((JSON.parse(upstream.requests[0].body) as { model: string }).model).toBe('upstream-model')
    await server.close()
    await upstream.close()
  })
})
