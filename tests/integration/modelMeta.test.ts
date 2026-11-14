import { describe, expect, it } from 'vitest'
import { startServer } from '../../core/server/start'
import { buildCatalog } from '../../core/providers/catalog'
import { createProviderFromPreset } from '../../core/providers/presets'
import { RuntimeStore } from '../../core/router/runtime'
import type { AppConfig, ProviderConfig } from '../../core/types'

const settings: AppConfig['settings'] = {
  port: 0,
  localKeyEnabled: false,
  autoStart: false,
  startMinimized: false,
  closeToTray: true,
  retentionDays: 30,
  quotaRefreshSec: 60
}

function provider(): ProviderConfig {
  const p = createProviderFromPreset('custom', 'p1')
  p.name = 'P1'
  p.baseUrl = 'https://p1.example/v1'
  p.models = { cached: ['claude-sonnet-4-5', 'plain-model'], manual: [], lastSyncedAt: null }
  p.modelMeta = { 'plain-model': { contextLength: 4096, vision: false, thinking: null } }
  return p
}

describe('/v1/models capability metadata', () => {
  it('appends context length and capabilities to both protocol shapes', async () => {
    const config: AppConfig = { version: 1, providers: [provider()], modelAliases: [], settings }
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
    const url = `http://127.0.0.1:${server.port}/v1/models`
    try {
      const openai = (await (await fetch(url)).json()) as {
        data: Array<{ id: string; context_length: number | null; capabilities: { vision: boolean | null; thinking: { param: string; values: string[] } | null } }>
      }
      const claude = openai.data.find((model) => model.id === 'claude-sonnet-4-5')
      expect(claude).toMatchObject({
        context_length: 200_000,
        capabilities: { vision: true, thinking: { param: 'thinking.budget_tokens' } }
      })

      const plain = openai.data.find((model) => model.id === 'plain-model')
      expect(plain).toMatchObject({
        context_length: 4096,
        capabilities: { vision: false, thinking: null }
      })

      const anthropic = (await (await fetch(url, { headers: { 'anthropic-version': '2023-06-01' } })).json()) as {
        data: Array<{ id: string; type: string; context_length: number | null }>
      }
      const entry = anthropic.data.find((model) => model.id === 'claude-sonnet-4-5')
      expect(entry).toMatchObject({ type: 'model', context_length: 200_000 })
    } finally {
      await server.close()
    }
  })
})