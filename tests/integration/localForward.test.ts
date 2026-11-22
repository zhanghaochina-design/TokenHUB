import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../../core/server/start'
import { buildCatalog } from '../../core/providers/catalog'
import { createProviderFromPreset } from '../../core/providers/presets'
import { RuntimeStore } from '../../core/router/runtime'
import { startFakeUpstream } from '../helpers/fakeUpstream'
import type { AppConfig } from '../../core/types'

describe('local provider forwarding', () => {
  let closeServer: (() => Promise<void>) | undefined
  let closeUpstream: (() => Promise<void>) | undefined

  afterEach(async () => {
    await closeServer?.()
    await closeUpstream?.()
    closeServer = undefined
    closeUpstream = undefined
  })

  async function boot(preset: 'local' | 'custom') {
    const upstream = await startFakeUpstream(() => ({
      status: 200,
      body: JSON.stringify({ id: 'x', choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }))
    closeUpstream = upstream.close
    const provider = createProviderFromPreset(preset, preset)
    provider.name = preset
    provider.baseUrl = `${upstream.url}/v1`
    provider.models.cached = ['m']
    const providers = [provider]
    const config: AppConfig = {
      version: 1,
      providers,
      modelAliases: [],
      settings: { port: 0, localKeyEnabled: false, autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const server = await startServer({
      getConfig: () => config,
      getProviderKey: () => null,
      getLocalApiKey: () => null,
      getCatalog: () => buildCatalog(providers),
      runtime: new RuntimeStore(),
      history: { append: async () => {} },
      isPaused: () => false
    }, 0)
    closeServer = server.close
    return { port: server.port, requests: upstream.requests }
  }

  const post = (port: number) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    })

  it('forwards keyless local requests without an Authorization header', async () => {
    const { port, requests } = await boot('local')
    const response = await post(port)
    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0].headers.authorization).toBeUndefined()
  })

  it('still rejects cloud providers without a key', async () => {
    const { port, requests } = await boot('custom')
    const response = await post(port)
    expect(response.status).toBe(401)
    expect(requests).toHaveLength(0)
  })
})