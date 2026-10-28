import { describe, expect, it } from 'vitest'
import { classifyUpstreamResponse, parseRetryAfter } from '../../core/errors'

const classify = (status: number, body: string, headers: Record<string, string> = {}) =>
  classifyUpstreamResponse(status, body, new Headers(headers))

describe('classifyUpstreamResponse', () => {
  it('treats 402 as quota regardless of body', () => {
    expect(classify(402, 'no').kind).toBe('quota')
  })

  it('separates quota 429 from rate-limit 429', () => {
    expect(classify(429, '{"error":{"message":"weekly quota exceeded"}}').kind).toBe('quota')
    expect(classify(429, '{"error":{"message":"rate limit exceeded, slow down"}}').kind).toBe('rate_limit')
    expect(classify(429, '额度已用完').kind).toBe('quota')
  })

  it('parses Retry-After seconds', () => {
    expect(classify(429, 'slow down', { 'retry-after': '30' }).retryAfterMs).toBe(30_000)
  })

  it('parses HTTP-date Retry-After against a fixed clock', () => {
    const now = Date.parse('2026-10-28T00:00:00Z')
    expect(parseRetryAfter('Wed, 28 Oct 2026 00:00:30 GMT', now)).toBe(30_000)
  })

  it('maps auth, model-missing, request and transient statuses', () => {
    expect(classify(401, 'bad key').kind).toBe('auth')
    expect(classify(403, 'forbidden').kind).toBe('auth')
    expect(classify(403, 'monthly quota exhausted').kind).toBe('quota')
    expect(classify(404, 'model not found').kind).toBe('model_missing')
    expect(classify(400, 'bad body').kind).toBe('request')
    expect(classify(422, 'bad body').kind).toBe('request')
    expect(classify(500, 'boom').kind).toBe('transient')
    expect(classify(503, 'busy').kind).toBe('transient')
  })

  it('extracts JSON error messages', () => {
    expect(classify(400, '{"error":{"message":"bad param"}}').message).toBe('bad param')
  })
})
