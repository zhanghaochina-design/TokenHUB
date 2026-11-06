import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hub } from '../../core/hub'
import { defaultConfig } from '../../core/store/config'
import { resolveCandidates } from '../../core/router/router'
import type { CipherPort } from '../../core/store/secrets'

const cipher: CipherPort = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s).toString('base64')),
  decrypt: (b) => Buffer.from(Buffer.from(b).toString('utf8'), 'base64').toString('utf8')
}

type FakeFetch = (url: string | URL | Request) => Promise<Response>

const defaultFetch: FakeFetch = async (url) => {
  const href = String(url)
  if (href.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200 })
  if (href.includes('/usage')) return new Response(JSON.stringify({ usage: { rolling: { status: 'ok', percent: 0, resetsAt: null } } }), { status: 200 })
  return new Response('{}', { status: 200 })
}

async function boot(options: { dir?: string; fetchFn?: FakeFetch; now?: () => Date; portOverride?: number } = {}) {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'tokenhub-hub-')))
  const fetchFn = options.fetchFn ?? defaultFetch
  const hub = new Hub({ dataDir: dir, cipher, fetchFn: fetchFn as never, portOverride: options.portOverride ?? 0, now: options.now })
  await hub.init()
  return { hub, dir }
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await sleep(10)
  expect(predicate()).toBe(true)
}

function chatBody(model: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })
  }
}

describe('Hub', () => {
  it('adds a provider, discovers models and exposes state', async () => {
    const { hub } = await boot()
    await hub.addProvider({ preset: 'opencode-go', name: 'Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-1' })
    const state = hub.getState()
    expect(state.providers[0]).toMatchObject({ name: 'Go', hasKey: true })
    expect(state.catalog.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(state.server.running).toBe(true)
    await hub.shutdown()
  })

  it('reorders, disables and deletes providers', async () => {
    const { hub } = await boot()
    await hub.addProvider({ preset: 'custom', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'ka' })
    await hub.addProvider({ preset: 'custom', name: 'B', baseUrl: 'https://b.example/v1', apiKey: 'kb' })
    const ids = hub.getState().providers.map((p) => p.id)
    await hub.reorderProviders([ids[1], ids[0]])
    expect(hub.getState().providers[0].name).toBe('B')
    const resolution = resolveCandidates({
      requestedModel: 'm1',
      providers: hub.getState().providers,
      catalog: hub.getState().catalog,
      runtime: hub.runtime
    })
    expect(resolution.candidates.map((c) => c.provider.id)).toEqual([ids[1], ids[0]])
    await hub.setProviderEnabled(ids[0], false)
    expect(hub.getState().providers.find((p) => p.id === ids[0])?.enabled).toBe(false)
    await hub.deleteProvider(ids[0])
    expect(hub.getState().providers).toHaveLength(1)
    expect(hub.getState().providers[0].hasKey).toBe(true)
    await hub.shutdown()
  })

  it('sets and clears the local key', async () => {
    const { hub } = await boot()
    await hub.setLocalKey('local')
    expect(hub.getState().settings.localKeyEnabled).toBe(true)
    const port = hub.getState().server.port
    expect((await fetch(`http://127.0.0.1:${port}/v1/models`)).status).toBe(401)
    await hub.setLocalKey(null)
    expect(hub.getState().settings.localKeyEnabled).toBe(false)
    expect((await fetch(`http://127.0.0.1:${port}/v1/models`)).status).toBe(200)
    await hub.shutdown()
  })

  it('clears a stale localKeyEnabled flag when the secrets store has no key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-hub-'))
    const config = defaultConfig()
    config.settings.localKeyEnabled = true
    await writeFile(join(dir, 'config.json'), JSON.stringify(config), 'utf8')

    const { hub } = await boot({ dir })
    expect(hub.getState().settings.localKeyEnabled).toBe(false)
    const persisted = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as { settings: { localKeyEnabled: boolean } }
    expect(persisted.settings.localKeyEnabled).toBe(false)

    // updateSettings 不能绕过 setLocalKey 重新打开标志。
    await hub.updateSettings({ localKeyEnabled: true })
    expect(hub.getState().settings.localKeyEnabled).toBe(false)

    // 没有本地 Key 时 /v1 不应要求鉴权。
    const response = await fetch(`http://127.0.0.1:${hub.getState().server.port}/v1/models`)
    expect(response.status).toBe(200)
    await hub.shutdown()
  })

  it('creates, persists and deletes canonical model aliases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-hub-'))
    const fetchFn: FakeFetch = async (url) => {
      const href = String(url)
      if (href.includes('a.example') && href.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }), { status: 200 })
      }
      if (href.includes('b.example') && href.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4.1-flash' }] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }
    const { hub } = await boot({ dir, fetchFn })
    await hub.addProvider({ preset: 'custom', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'ka' })
    await hub.addProvider({ preset: 'custom', name: 'B', baseUrl: 'https://b.example/v1', apiKey: 'kb' })
    const [a, b] = hub.getState().providers.map((provider) => provider.id)
    const alias = {
      id: 'deepseek4.1flash',
      targets: [
        { providerId: a, upstreamModel: 'deepseek-v4.1-flash' },
        { providerId: b, upstreamModel: 'deepseek/deepseek-v4.1-flash' }
      ]
    }
    await hub.saveModelAlias(alias)
    expect(hub.getState().aliases).toEqual([alias])
    expect(hub.getState().catalog.map((model) => model.id)).toEqual(['deepseek4.1flash'])
    const resolution = resolveCandidates({
      requestedModel: 'deepseek4.1flash',
      providers: hub.getState().providers,
      catalog: hub.getState().catalog,
      runtime: hub.runtime
    })
    expect(resolution.candidates.map((candidate) => candidate.upstreamModel)).toEqual([
      'deepseek-v4.1-flash',
      'deepseek/deepseek-v4.1-flash'
    ])
    await hub.shutdown()

    const { hub: restarted } = await boot({ dir, fetchFn })
    expect(restarted.getState().aliases).toEqual([alias])
    expect(restarted.getState().catalog.map((model) => model.id)).toEqual(['deepseek4.1flash'])
    await restarted.deleteModelAlias('deepseek4.1flash')
    expect(restarted.getState().aliases).toEqual([])
    expect(restarted.getState().catalog.map((model) => model.id).sort()).toEqual([
      'deepseek-v4.1-flash',
      'deepseek/deepseek-v4.1-flash'
    ])
    await restarted.shutdown()
  })

  it('validates aliases and removes provider targets when a provider is deleted', async () => {
    const { hub } = await boot()
    await hub.addProvider({ preset: 'custom', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'ka' })
    await hub.addProvider({ preset: 'custom', name: 'B', baseUrl: 'https://b.example/v1', apiKey: 'kb' })
    const [a, b] = hub.getState().providers.map((provider) => provider.id)
    await expect(hub.saveModelAlias({ id: 'x', targets: [] })).rejects.toThrow('at least one')
    await expect(
      hub.saveModelAlias({ id: 'x', targets: [{ providerId: 'missing', upstreamModel: 'm1' }] })
    ).rejects.toThrow('unknown provider')
    await hub.saveModelAlias({
      id: 'x',
      targets: [
        { providerId: a, upstreamModel: 'm1' },
        { providerId: b, upstreamModel: 'm2' }
      ]
    })
    await expect(
      hub.saveModelAlias({ id: 'x', targets: [{ providerId: a, upstreamModel: 'm1' }] })
    ).rejects.toThrow('already exists')
    await hub.deleteProvider(b)
    expect(hub.getState().aliases[0].targets).toEqual([{ providerId: a, upstreamModel: 'm1' }])
    await hub.deleteProvider(a)
    expect(hub.getState().aliases[0].targets).toEqual([])
    expect(hub.getState().catalog.some((model) => model.id === 'x')).toBe(false)
    await hub.shutdown()
  })

  it('marks providers exhausted from quota errors', async () => {
    const { hub } = await boot()
    await hub.addProvider({ preset: 'commandcode', name: 'Goat', baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey: 'k' })
    const id = hub.getState().providers[0].id
    hub.runtime.markFailure(hub.getState().providers[0] as never, { kind: 'quota', status: 429, message: 'quota', retryAfterMs: null })
    expect(hub.getState().runtime.find((r) => r.providerId === id)?.availability).toBe('exhausted')
    await hub.resetProvider(id)
    expect(hub.getState().runtime.find((r) => r.providerId === id)?.availability).toBe('ok')
    await hub.shutdown()
  })

  it('rejects non-local http base urls', async () => {
    const { hub } = await boot()
    await expect(hub.addProvider({ preset: 'custom', name: 'X', baseUrl: 'http://example.com/v1', apiKey: 'k' })).rejects.toThrow('https')
    await hub.shutdown()
  })

  it('tests a provider without persisting it', async () => {
    const { hub } = await boot()
    const result = await hub.testProvider({ preset: 'opencode-go', name: 'Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-1' })
    expect(result.models).toEqual(['m1', 'm2'])
    expect(result.quota?.availability).toBe('ok')
    expect(result.error).toBeUndefined()
    expect(hub.getState().providers).toHaveLength(0)
    await hub.shutdown()
  })

  it('swallows quota probe failures instead of rejecting', async () => {
    const failingFetch: FakeFetch = async (url) => {
      const href = String(url)
      if (href.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
      if (href.includes('/usage')) throw new Error('probe down')
      return new Response('{}', { status: 200 })
    }
    const { hub } = await boot({ fetchFn: failingFetch })
    await hub.addProvider({ preset: 'opencode-go', name: 'Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-1' })
    const id = hub.getState().providers[0].id
    await expect(hub.refreshProviderQuota(id)).resolves.toBeUndefined()
    await hub.shutdown()
  })

  it('uses the injected fetch and skips providers in auth_error until reset', async () => {
    let usageCalls = 0
    const countingFetch: FakeFetch = async (url) => {
      const href = String(url)
      if (href.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
      if (href.includes('/usage')) {
        usageCalls += 1
        return new Response(JSON.stringify({ usage: { rolling: { status: 'ok', percent: 0, resetsAt: null } } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }
    const { hub } = await boot({ fetchFn: countingFetch })
    await hub.addProvider({ preset: 'opencode-go', name: 'Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-1' })
    const provider = hub.getState().providers[0]
    await hub.refreshProviderQuota(provider.id)
    const afterProbe = usageCalls
    expect(afterProbe).toBeGreaterThan(0)

    hub.runtime.markFailure(provider as never, { kind: 'auth', status: 401, message: 'unauthorized', retryAfterMs: null })
    await hub.refreshQuotas(true)
    expect(usageCalls).toBe(afterProbe)

    await hub.resetProvider(provider.id)
    await hub.refreshQuotas(true)
    expect(usageCalls).toBe(afterProbe + 1)
    await hub.shutdown()
  })

  it('restores quota snapshots from quota-cache on the next start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-hub-'))
    const first = await boot({ dir })
    await first.hub.addProvider({ preset: 'opencode-go', name: 'Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-1' })
    const id = first.hub.getState().providers[0].id
    await first.hub.refreshProviderQuota(id)
    await first.hub.shutdown()
    const cache = JSON.parse(await readFile(join(dir, 'quota-cache.json'), 'utf8')) as Record<string, { availability: string }>
    expect(cache[id]?.availability).toBe('ok')

    const second = await boot({ dir })
    expect(second.hub.getState().runtime[0]?.quota?.availability).toBe('ok')
    await second.hub.shutdown()
  })

  it('moves the listener to a new port only after the new server started', async () => {
    const { hub } = await boot()
    const oldPort = hub.getState().server.port
    const target = await freePort()
    await hub.updateSettings({ port: target })
    const moved = hub.getState()
    expect(moved.server.running).toBe(true)
    expect(moved.server.port).toBe(target)
    expect(moved.server.port).not.toBe(oldPort)

    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const blockedPort = (blocker.address() as { port: number }).port
    try {
      await expect(hub.updateSettings({ port: blockedPort })).rejects.toThrow()
      const kept = hub.getState()
      expect(kept.server.running).toBe(true)
      expect(kept.server.port).toBe(moved.server.port)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
    await hub.shutdown()
  })

  it('persists and broadcasts a port change before the old listener finishes closing', async () => {
    const { hub, dir } = await boot()
    const oldPort = hub.getState().server.port
    // 保持一条到旧端口的连接：旧实现会 await close()，这条连接足以把设置保存挂住。
    const socket = connect(oldPort, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    try {
      const target = await freePort()
      const started = Date.now()
      await hub.updateSettings({ port: target })
      expect(Date.now() - started).toBeLessThan(1_500)
      expect(hub.getState().settings.port).toBe(target)
      const persisted = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as { settings: { port: number } }
      expect(persisted.settings.port).toBe(target)
    } finally {
      socket.destroy()
    }
    await hub.shutdown()
  })

  it('keeps running when the startup port is occupied and recovers after a port change', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const occupied = (blocker.address() as { port: number }).port
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-hub-'))
    try {
      // init 不能抛：窗口要照常出现，用户才能在设置页换端口。
      const { hub } = await boot({ dir, portOverride: occupied })
      try {
        const failed = hub.getState()
        expect(failed.server.running).toBe(false)
        expect(failed.server.error).toContain(String(occupied))

        // 同一端口再存一次也允许重试；仍然失败时必须保持无服务并抛出，而不是静默成功。
        await expect(hub.updateSettings({ port: occupied })).rejects.toThrow()
        expect(hub.getState().server.running).toBe(false)
        expect(hub.getState().server.error).toContain(String(occupied))

        const target = await freePort()
        await hub.updateSettings({ port: target })
        const recovered = hub.getState()
        expect(recovered.server.running).toBe(true)
        expect(recovered.server.port).toBe(target)
        expect(recovered.server.error).toBeNull()
        expect(recovered.settings.port).toBe(target)
      } finally {
        await hub.shutdown()
      }
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('refreshes the catalog once for an unknown model and throttles it for 60s', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z')
    let modelCalls = 0
    const fetchFn: FakeFetch = async (url) => {
      if (String(url).endsWith('/models')) {
        modelCalls += 1
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }
    const { hub } = await boot({ fetchFn, now: () => new Date(clock) })
    await hub.addProvider({ preset: 'custom', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'ka' })
    expect(modelCalls).toBe(1)
    const url = `http://127.0.0.1:${hub.getState().server.port}/v1/chat/completions`
    const ask = () => fetch(url, chatBody('brand-new'))

    expect((await ask()).status).toBe(404)
    await waitFor(() => modelCalls === 2)
    await sleep(100)

    // 60s 内第二次未知模型请求不能再刷新。
    expect((await ask()).status).toBe(404)
    await sleep(100)
    expect(modelCalls).toBe(2)

    clock += 61_000
    expect((await ask()).status).toBe(404)
    await waitFor(() => modelCalls === 3)
    await hub.shutdown()
  })

  it('surfaces a quarantined secrets file as a recovery warning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-hub-'))
    await writeFile(join(dir, 'secrets.bin'), 'TOKENHUB-SECRETS-1\nnot-a-valid-payload', 'utf8')
    const { hub } = await boot({ dir })
    const warning = hub.getState().recoveryWarning
    expect(warning).toBeTruthy()
    // 提示只能说明隔离事实，不能泄露文件内容。
    expect(warning).not.toContain('not-a-valid-payload')
    await hub.shutdown()
  })

  it('does not replay auth_error snapshots from the quota cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-hub-'))
    const config = defaultConfig()
    config.providers.push({
      id: 'p1',
      name: 'P1',
      preset: 'custom',
      baseUrl: 'https://p1.example/v1',
      quotaAdapter: 'none',
      enabled: true,
      models: { cached: ['m1'], manual: [], lastSyncedAt: new Date().toISOString() },
      quota: { lowBalanceThreshold: 0.5, quotaCooldownMs: 18_000_000, injectStreamUsage: true }
    })
    await writeFile(join(dir, 'config.json'), JSON.stringify(config), 'utf8')
    await writeFile(
      join(dir, 'quota-cache.json'),
      JSON.stringify({
        p1: { providerId: 'p1', availability: 'auth_error', source: 'probe', fetchedAt: new Date().toISOString() }
      }),
      'utf8'
    )
    const { hub } = await boot({ dir })
    // 跳过回放后供应商保持默认状态（可路由），不会带着 auth_error 重新启动。
    const runtime = hub.getState().runtime[0]
    expect(runtime.availability).toBe('unknown')
    expect(runtime.quota).toBeNull()
    expect(hub.runtime.isRoutable('p1')).toBe(true)
    await hub.shutdown()
  })

  it('validates settings patches before applying them', async () => {
    const { hub } = await boot()
    const before = hub.getState().settings
    await expect(hub.updateSettings({ port: 0 })).rejects.toThrow('port')
    await expect(hub.updateSettings({ port: 70000 })).rejects.toThrow('port')
    await expect(hub.updateSettings({ quotaRefreshSec: 9 })).rejects.toThrow('quotaRefreshSec')
    expect(hub.getState().settings).toEqual(before)
    await hub.shutdown()
  })

  it('serializes overlapping config saves without corrupting config.json', async () => {
    const { hub, dir } = await boot()
    await Promise.all([
      hub.updateSettings({ retentionDays: 7 }),
      hub.updateSettings({ quotaRefreshSec: 30 }),
      hub.updateSettings({ closeToTray: false })
    ])
    const persisted = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as { settings: Record<string, unknown> }
    expect(persisted.settings).toMatchObject({ retentionDays: 7, quotaRefreshSec: 30, closeToTray: false })
    await hub.shutdown()
  })

  it('does not half-apply a provider update when validation fails', async () => {
    const { hub } = await boot()
    await hub.addProvider({ preset: 'custom', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'ka' })
    const id = hub.getState().providers[0].id
    await expect(hub.updateProvider(id, { name: 'Renamed', baseUrl: 'http://evil.example/v1' })).rejects.toThrow('https')
    expect(hub.getState().providers[0].name).toBe('A')
    await expect(hub.updateProvider(id, { name: '  ', baseUrl: 'https://b.example/v1' })).rejects.toThrow('name')
    expect(hub.getState().providers[0].baseUrl).toBe('https://a.example/v1')
    await hub.shutdown()
  })

  it('aggregates per-provider speed stats for a day', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-hub-'))
    await mkdir(join(dir, 'history'), { recursive: true })
    const rows = [
      {
        ts: '2026-11-06T00:00:00.000Z', requestId: 'r1', protocol: 'anthropic', model: 'm', providerId: 'p1',
        upstreamModel: 'm', stream: true, httpStatus: 200, outcome: 'ok', promptTokens: 1, completionTokens: 100,
        latencyMs: 1100, firstByteMs: 100, errorKind: null
      },
      {
        ts: '2026-11-06T01:00:00.000Z', requestId: 'r2', protocol: 'anthropic', model: 'm', providerId: 'p1',
        upstreamModel: 'm', stream: true, httpStatus: 200, outcome: 'ok', promptTokens: 1, completionTokens: 200,
        latencyMs: 1100, firstByteMs: 100, errorKind: null
      }
    ]
    await writeFile(join(dir, 'history', '2026-11-06.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    const { hub } = await boot({ dir })

    await expect(hub.getSpeedStats('2026-11-06')).resolves.toEqual([
      { providerId: 'p1', latestTps: 200, latestAt: '2026-11-06T01:00:00.000Z', averageTps: 150, samples: 2 }
    ])
    await expect(hub.getSpeedStats('bad')).rejects.toThrow('day')
    await hub.shutdown()
  })

  it('forwards upstream calls through the injected fetch', async () => {
    let chatCalls = 0
    const fetchFn: FakeFetch = async (url) => {
      const href = String(url)
      if (href.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
      if (href.endsWith('/chat/completions')) {
        chatCalls += 1
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response('{}', { status: 200 })
    }
    const { hub } = await boot({ fetchFn })
    await hub.addProvider({ preset: 'custom', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'ka' })
    const response = await fetch(`http://127.0.0.1:${hub.getState().server.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(response.status).toBe(200)
    expect(chatCalls).toBe(1)
    await hub.shutdown()
  })
})
