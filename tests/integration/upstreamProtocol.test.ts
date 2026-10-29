import { afterEach, describe, expect, it } from 'vitest'
import { createProviderFromPreset } from '../../core/providers/presets'
import { buildCatalog } from '../../core/providers/catalog'
import { RuntimeStore } from '../../core/router/runtime'
import { startServer } from '../../core/server/start'
import { startFakeUpstream } from '../helpers/fakeUpstream'
import type { AppConfig, HistoryRecord, ProviderConfig } from '../../core/types'

const anthropicJson = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 3 }
}

const anthropicSse = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":11,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'
].join('')

const openAiJson = {
  id: 'chatcmpl_1',
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 1 }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForRecord(records: HistoryRecord[], timeoutMs = 3_000): Promise<HistoryRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (records.length > 0) return records[0]
    await sleep(10)
  }
  throw new Error('timed out waiting for a history record')
}

function provider(preset: 'commandcode' | 'opencode-go', id: string, baseUrl: string, models: string[]): ProviderConfig {
  const p = createProviderFromPreset(preset, id)
  p.name = id
  p.baseUrl = baseUrl
  p.models.cached = models
  return p
}

const anthropicBody = (model: string, stream = false) => JSON.stringify({
  model,
  max_tokens: 64,
  stream,
  messages: [{ role: 'user', content: 'ping' }]
})

describe('anthropic-shaped upstream', () => {
  let closeServer: (() => Promise<void>) | undefined
  let closeUpstream: (() => Promise<void>) | undefined
  let records: HistoryRecord[] = []
  let requests: Array<{ path: string; body: string; headers: Record<string, string | string[] | undefined> }> = []

  afterEach(async () => {
    await closeServer?.()
    await closeUpstream?.()
    closeServer = undefined
    closeUpstream = undefined
    records = []
    requests = []
  })

  async function boot(handler: Parameters<typeof startFakeUpstream>[0]) {
    const upstream = await startFakeUpstream(handler)
    closeUpstream = upstream.close
    requests = upstream.requests
    const providers = [
      provider('commandcode', 'cc', `${upstream.url}/cc/v1`, ['claude-opus-5-5', 'deepseek/deepseek-v4-pro']),
      provider('opencode-go', 'oc', `${upstream.url}/oc/v1`, ['glm-5.3'])
    ]
    const config: AppConfig = {
      version: 1,
      providers,
      modelAliases: [],
      settings: { port: 0, localKeyEnabled: false, autoStart: false, startMinimized: false, closeToTray: true, retentionDays: 30, quotaRefreshSec: 60 }
    }
    const server = await startServer({
      getConfig: () => config,
      getProviderKey: (id) => `sk-${id}`,
      getLocalApiKey: () => null,
      getCatalog: () => buildCatalog(providers),
      runtime: new RuntimeStore(),
      history: { append: async (record) => { records.push(record) } },
      isPaused: () => false
    }, 0)
    closeServer = server.close
    return server.port
  }

  it('sends anthropic clients to /messages and passes the response through', async () => {
    const port = await boot(() => ({ status: 200, body: JSON.stringify(anthropicJson) }))
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: anthropicBody('claude-opus-5-5')
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(anthropicJson)
    expect(requests[0].path).toBe('/cc/v1/messages')
    expect(requests[0].headers['x-api-key']).toBe('sk-cc')
    expect(requests[0].headers['anthropic-version']).toBe('2023-06-01')
    expect((JSON.parse(requests[0].body) as { model: string }).model).toBe('claude-opus-5-5')
    expect(await waitForRecord(records)).toMatchObject({
      protocol: 'anthropic',
      providerId: 'cc',
      promptTokens: 11,
      completionTokens: 3,
      outcome: 'ok'
    })
  })

  it('passes an anthropic SSE stream through untouched', async () => {
    const port = await boot(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: anthropicSse }))
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: anthropicBody('claude-opus-5-5', true)
    })

    const text = await res.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('"text":"pong"')
    expect(text).toContain('event: message_stop')
    expect(await waitForRecord(records)).toMatchObject({
      protocol: 'anthropic',
      providerId: 'cc',
      promptTokens: 11,
      completionTokens: 5,
      outcome: 'ok'
    })
  })

  it('translates openai clients to anthropic requests and back', async () => {
    const port = await boot(() => ({ status: 200, body: JSON.stringify(anthropicJson) }))
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'ping' }],
        tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object', properties: {} } } }],
        tool_choice: 'auto'
      })
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }
    })
    const upstreamBody = JSON.parse(requests[0].body) as {
      system?: string
      tools?: Array<{ name: string }>
      messages: Array<{ role: string; content: unknown }>
    }
    expect(requests[0].path).toBe('/cc/v1/messages')
    expect(upstreamBody.system).toBe('be nice')
    expect(upstreamBody.tools?.[0]?.name).toBe('run')
    expect(upstreamBody.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'ping' }] })
    expect(await waitForRecord(records)).toMatchObject({
      protocol: 'openai',
      providerId: 'cc',
      promptTokens: 11,
      completionTokens: 3,
      outcome: 'ok'
    })
  })

  it('translates an anthropic SSE stream for openai clients', async () => {
    const port = await boot(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: anthropicSse }))
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'ping' }]
      })
    })

    const text = await res.text()
    expect(text).toContain('"content":"pong"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('"usage":{"prompt_tokens":11,"completion_tokens":5,"total_tokens":16}')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(await waitForRecord(records)).toMatchObject({
      protocol: 'openai',
      providerId: 'cc',
      promptTokens: 11,
      completionTokens: 5,
      outcome: 'ok'
    })
  })

  it('keeps non-claude commandcode models on the openai endpoint', async () => {
    const port = await boot(() => ({ status: 200, body: JSON.stringify(openAiJson) }))
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-v4-pro', messages: [{ role: 'user', content: 'ping' }] })
    })

    expect(res.status).toBe(200)
    expect(requests[0].path).toBe('/cc/v1/chat/completions')
  })

  it('propagates the client session header to OpenCode Go', async () => {
    const port = await boot((path) => ({
      status: 200,
      body: JSON.stringify(path.endsWith('/messages') ? anthropicJson : openAiJson)
    }))
    const first = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': 'sess-42' },
      body: anthropicBody('glm-5.3')
    })
    expect(first.status).toBe(200)
    expect(requests[0].path).toBe('/oc/v1/messages')
    expect(requests[0].headers['x-opencode-session']).toBe('sess-42')
    expect(requests[0].headers['user-agent']).toBe('TokenHUB/0.1.0')
    expect((JSON.parse(requests[0].body) as { model: string }).model).toBe('glm-5.3')

    const second = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: anthropicBody('glm-5.3')
    })
    expect(second.status).toBe(200)
    const generated = requests[1].headers['x-opencode-session']
    expect(typeof generated).toBe('string')
    expect(generated).not.toBe('sess-42')
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
