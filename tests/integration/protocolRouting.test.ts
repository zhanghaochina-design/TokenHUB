import { afterEach, describe, expect, it } from 'vitest'
import { createProviderFromPreset } from '../../core/providers/presets'
import { buildCatalog } from '../../core/providers/catalog'
import { RuntimeStore } from '../../core/router/runtime'
import { startServer } from '../../core/server/start'
import { startFakeUpstream, type FakeResponse } from '../helpers/fakeUpstream'
import type { AppConfig, HistoryRecord, ModelProtocolSupport, Preset, ProviderConfig } from '../../core/types'

type Handler = Parameters<typeof startFakeUpstream>[0]
type RecordedRequest = Awaited<ReturnType<typeof startFakeUpstream>>['requests'][number]

interface ProviderSpec {
  preset: Preset
  id: string
  models: string[]
  support?: Record<string, ModelProtocolSupport>
  // 相对假上游的 Anthropic 专用 base，用于验证 anthropicBaseUrl 覆盖。
  anthropicBasePath?: string
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

const openAIResponse = {
  id: 'chat-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2 }
}

const anthropicResponse = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'deepseek-v4.1-flash',
  content: [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: 'pong' }
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 7, output_tokens: 2 }
}

describe('protocol routing', () => {
  let closeUpstream: (() => Promise<void>) | undefined
  let closeServer: (() => Promise<void>) | undefined
  let records: HistoryRecord[] = []
  let requests: RecordedRequest[] = []

  afterEach(async () => {
    await closeServer?.()
    await closeUpstream?.()
    closeServer = undefined
    closeUpstream = undefined
    records = []
    requests = []
  })

  async function boot(handler: Handler, specs: ProviderSpec[]) {
    const upstream = await startFakeUpstream(handler)
    closeUpstream = upstream.close
    requests = upstream.requests
    const providers: ProviderConfig[] = specs.map((spec) => {
      const p = createProviderFromPreset(spec.preset, spec.id)
      p.name = spec.id
      p.baseUrl = `${upstream.url}/${spec.id}/v1`
      p.models.cached = spec.models
      if (spec.support) p.protocolSupport = spec.support
      if (spec.anthropicBasePath) p.anthropicBaseUrl = `${upstream.url}${spec.anthropicBasePath}`
      return p
    })
    const runtime = new RuntimeStore()
    const config: AppConfig = {
      version: 1,
      providers,
      modelAliases: [],
      settings: {
        port: 0,
        localKeyEnabled: false,
        autoStart: false,
        startMinimized: false,
        closeToTray: true,
        retentionDays: 30,
        quotaRefreshSec: 60
      }
    }
    const server = await startServer({
      getConfig: () => config,
      getProviderKey: (id) => `sk-${id}`,
      getLocalApiKey: () => null,
      getCatalog: () => buildCatalog(providers),
      runtime,
      history: { append: async (record) => { records.push(record) } },
      isPaused: () => false
    }, 0)
    closeServer = server.close
    return { port: server.port, runtime, upstream, providers }
  }

  const post = (port: number, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })

  const deepseekBody = {
    model: 'deepseek-v4.1-flash',
    max_tokens: 32,
    system: [{ type: 'text', text: 'Be terse.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping', cache_control: { type: 'ephemeral' } }] }]
  }

  it('uses a dedicated Anthropic base when the provider defines one', async () => {
    const { port } = await boot(() => ({ status: 200, body: JSON.stringify(anthropicResponse) }), [
      { preset: 'deepseek', id: 'ds', models: ['deepseek-flash'], anthropicBasePath: '/ds-anthropic/v1' }
    ])
    const res = await post(
      port,
      '/v1/messages',
      { model: 'deepseek-flash', max_tokens: 32, messages: [{ role: 'user', content: 'ping' }] },
      { 'anthropic-version': '2023-06-01' }
    )
    expect(res.status).toBe(200)
    expect(requests[0].path).toBe('/ds-anthropic/v1/messages')
  })

  it('passes anthropic traffic straight to /messages when both sides use the same shape', async () => {
    const { port } = await boot(
      (path): FakeResponse =>
        path.endsWith('/messages')
          ? { status: 200, body: JSON.stringify(anthropicResponse) }
          : { status: 500, body: 'wrong endpoint' },
      [{ preset: 'opencode-go', id: 'p1', models: ['deepseek-v4.1-flash'] }]
    )

    const res = await post(port, '/v1/messages', deepseekBody, { 'anthropic-version': '2023-06-01' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(anthropicResponse)
    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe('/p1/v1/messages')
    expect(requests[0].headers['x-api-key']).toBe('sk-p1')
    expect(requests[0].headers['x-opencode-session']).toBeTruthy()
    const sent = JSON.parse(requests[0].body) as Record<string, any>
    expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(sent.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' })

    const record = await waitForRecord(records)
    expect(record).toMatchObject({
      protocol: 'anthropic',
      upstreamModel: 'deepseek-v4.1-flash',
      promptTokens: 7,
      completionTokens: 2,
      outcome: 'ok',
      errorKind: null,
      failoverFrom: []
    })
  })

  it('keeps OpenAI clients on /chat/completions for OpenCode Go', async () => {
    const { port } = await boot(
      (path): FakeResponse =>
        path.endsWith('/chat/completions')
          ? { status: 200, body: JSON.stringify(openAIResponse) }
          : { status: 500, body: 'wrong endpoint' },
      [{ preset: 'opencode-go', id: 'p1', models: ['deepseek-v4.1-flash'] }]
    )

    const res = await post(port, '/v1/chat/completions', {
      model: 'deepseek-v4.1-flash',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'ping' }]
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ object: 'chat.completion', choices: [{ message: { content: 'pong' } }] })
    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe('/p1/v1/chat/completions')
    expect(requests[0].headers.authorization).toBe('Bearer sk-p1')
    expect(requests[0].headers['x-opencode-session']).toBeTruthy()

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ protocol: 'openai', upstreamModel: 'deepseek-v4.1-flash', outcome: 'ok' })
  })

  it('honours scanned support and translates when the preferred shape is unavailable', async () => {
    const { port } = await boot(
      (path): FakeResponse =>
        path.endsWith('/chat/completions')
          ? { status: 200, body: JSON.stringify(openAIResponse) }
          : { status: 500, body: 'wrong endpoint' },
      [{
        preset: 'opencode-go',
        id: 'p1',
        models: ['deepseek-v4.1-flash'],
        support: {
          'deepseek-v4.1-flash': { anthropic: false, openai: true, checkedAt: '2026-10-29T00:00:00.000Z' }
        }
      }]
    )

    const res = await post(port, '/v1/messages', deepseekBody)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      type: 'message',
      content: [{ type: 'text', text: 'pong' }],
      usage: { input_tokens: 5, output_tokens: 2 }
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe('/p1/v1/chat/completions')
  })

  it('falls back to the other shape before the first byte when the preferred endpoint rejects the request', async () => {
    const { port, runtime } = await boot(
      (path): FakeResponse =>
        path.endsWith('/messages')
          ? { status: 400, body: JSON.stringify({ error: { message: 'Model is not supported on this endpoint' } }) }
          : { status: 200, body: JSON.stringify(openAIResponse) },
      [{ preset: 'opencode-go', id: 'p1', models: ['deepseek-v4.1-flash'] }]
    )

    const res = await post(port, '/v1/messages', deepseekBody)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'pong' }] })
    expect(requests.map((request) => request.path)).toEqual(['/p1/v1/messages', '/p1/v1/chat/completions'])
    expect(runtime.isRoutable('p1')).toBe(true)
    expect(runtime.get('p1').cooldownUntil).toBeNull()

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ outcome: 'ok', errorKind: null, failoverFrom: [] })
  })

  it('translates OpenAI clients to /messages for CommandCode Claude models', async () => {
    const { port } = await boot(
      (path): FakeResponse =>
        path.endsWith('/messages')
          ? { status: 200, body: JSON.stringify(anthropicResponse) }
          : { status: 500, body: 'wrong endpoint' },
      [{ preset: 'commandcode', id: 'p1', models: ['claude-opus-5-5'] }]
    )

    const res = await post(port, '/v1/chat/completions', {
      model: 'claude-opus-5-5',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'ping' }]
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }]
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe('/p1/v1/messages')
    expect(requests[0].headers['x-api-key']).toBe('sk-p1')
    const sent = JSON.parse(requests[0].body) as Record<string, any>
    expect(sent.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'ping' }] })

    const record = await waitForRecord(records)
    expect(record).toMatchObject({ protocol: 'openai', upstreamModel: 'claude-opus-5-5', outcome: 'ok' })
  })

  it('streams anthropic events through unchanged and records the tapped usage', async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join('')
    const { port } = await boot(
      (path): FakeResponse =>
        path.endsWith('/messages')
          ? { status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse }
          : { status: 500, body: 'wrong endpoint' },
      [{ preset: 'opencode-go', id: 'p1', models: ['deepseek-v4.1-flash'] }]
    )

    const res = await post(port, '/v1/messages', {
      model: 'deepseek-v4.1-flash',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'ping' }]
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('"text":"hi"')
    expect(text).toContain('event: message_stop')
    expect(requests[0].path).toBe('/p1/v1/messages')

    const record = await waitForRecord(records)
    expect(record).toMatchObject({
      protocol: 'anthropic',
      stream: true,
      outcome: 'ok',
      promptTokens: 9,
      completionTokens: 2,
      errorKind: null
    })
  })
})
