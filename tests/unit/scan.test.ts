import { describe, expect, it } from 'vitest'
import { createProviderFromPreset } from '../../core/providers/presets'
import { scanProviderProtocols } from '../../core/providers/scan'

function provider() {
  const p = createProviderFromPreset('custom', 'p1')
  p.baseUrl = 'https://upstream.test/v1'
  return p
}

function response(status: number, body: string): Response {
  return new Response(body, { status })
}

describe('scanProviderProtocols', () => {
  it('classifies supported, unsupported and indeterminate endpoints', async () => {
    const calls: string[] = []
    const progress: Array<[number, number]> = []
    const fetchFn = async (url: string, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string
      calls.push(`${model}:${url.endsWith('/messages') ? 'messages' : 'chat'}`)
      if (model === 'a') {
        return url.endsWith('/messages') ? response(200, '{}') : response(400, '{"error":{"message":"use chat"}}')
      }
      if (model === 'b') {
        return url.endsWith('/messages') ? response(500, 'boom') : response(200, '{}')
      }
      return url.endsWith('/messages') ? response(200, '{}') : response(200, '{}')
    }

    const outcome = await scanProviderProtocols({
      provider: provider(),
      apiKey: 'k',
      models: ['a', 'b', 'c', 'a'],
      fetchFn,
      concurrency: 1,
      onProgress: (done, total) => progress.push([done, total])
    })

    expect(outcome.error).toBeUndefined()
    expect(outcome.rows).toEqual([
      { model: 'a', anthropic: true, openai: false, checkedAt: expect.any(String), note: 'chat: use chat' },
      { model: 'b', anthropic: null, openai: true, checkedAt: expect.any(String), note: 'messages: boom' },
      { model: 'c', anthropic: true, openai: true, checkedAt: expect.any(String), note: undefined }
    ])
    expect(calls).toHaveLength(6)
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]])
  })

  it('stops early only when both endpoints reject the key with 401', async () => {
    let calls = 0
    const fetchFn = async () => {
      calls += 1
      return response(401, '{"error":{"message":"bad key"}}')
    }

    const outcome = await scanProviderProtocols({
      provider: provider(),
      apiKey: 'k',
      models: ['a', 'b', 'c'],
      fetchFn,
      concurrency: 1
    })

    expect(outcome.error).toContain('认证失败')
    expect(outcome.error).toContain('a')
    expect(outcome.rows).toEqual([
      { model: 'a', anthropic: null, openai: null, checkedAt: expect.any(String), note: 'messages: bad key; chat: bad key' }
    ])
    expect(calls).toBe(2)
  })

  it('keeps scanning after 403 and 402 responses', async () => {
    const fetchFn = async (url: string, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string
      if (model === 'a') return response(403, '{"error":{"message":"region blocked"}}')
      if (model === 'b') {
        return url.endsWith('/messages')
          ? response(402, '{"error":{"message":"quota"}}')
          : response(200, '{}')
      }
      return response(200, '{}')
    }

    const outcome = await scanProviderProtocols({
      provider: provider(),
      apiKey: 'k',
      models: ['a', 'b', 'c'],
      fetchFn,
      concurrency: 1
    })

    expect(outcome.error).toBeUndefined()
    expect(outcome.rows).toEqual([
      { model: 'a', anthropic: null, openai: null, checkedAt: expect.any(String), note: 'messages: region blocked; chat: region blocked' },
      { model: 'b', anthropic: null, openai: true, checkedAt: expect.any(String), note: 'messages: quota' },
      { model: 'c', anthropic: true, openai: true, checkedAt: expect.any(String), note: undefined }
    ])
  })
})
