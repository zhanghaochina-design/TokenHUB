import { describe, expect, it } from 'vitest'
import { parseSSE, tapSSEUsage } from '../../core/protocol/sse'

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })
}

describe('parseSSE', () => {
  it('parses events across chunk boundaries', async () => {
    const events: Array<{ event?: string; data: string }> = []
    for await (const ev of parseSSE(streamOf('event: message\ndata: {"a":1}\n\ndata: [DONE]\n\n'))) events.push(ev)
    expect(events).toEqual([{ event: 'message', data: '{"a":1}' }, { event: undefined, data: '[DONE]' }])
  })

  it('joins multi-line data and tolerates CRLF', async () => {
    const events: Array<{ event?: string; data: string }> = []
    for await (const ev of parseSSE(streamOf('data: a\r\ndata: b\r\n\r\n'))) events.push(ev)
    expect(events).toEqual([{ event: undefined, data: 'a\nb' }])
  })
})

describe('tapSSEUsage', () => {
  it('passes bytes through and reports usage', async () => {
    const usages: Array<{ prompt: number; completion: number }> = []
    const input = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\ndata: [DONE]\n\n'
    const tapped = tapSSEUsage(streamOf(input), { onUsage: (u) => usages.push(u) })
    const text = await new Response(tapped).text()
    expect(text).toBe(input)
    expect(usages).toEqual([{ prompt: 7, completion: 2 }])
  })
})
