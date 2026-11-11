import { describe, expect, it } from 'vitest'
import { anthropicInputTokens, parseSSE, tapAnthropicSSEUsage, tapSSEUsage } from '../../core/protocol/sse'

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

describe('anthropicInputTokens', () => {
  it('sums plain input with both cache buckets', () => {
    expect(anthropicInputTokens(undefined)).toBeNull()
    expect(anthropicInputTokens({ output_tokens: 5 })).toBeNull()
    expect(anthropicInputTokens({ input_tokens: 3 })).toBe(3)
    expect(anthropicInputTokens({ input_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 })).toBe(107)
  })
})

describe('tapAnthropicSSEUsage', () => {
  it('reads usage from the final message_delta when message_start is all zero', async () => {
    const usages: Array<{ prompt: number; completion: number }> = []
    const input =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":8,"output_tokens":2,"cache_read_input_tokens":100,"cache_creation_input_tokens":7}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    const tapped = tapAnthropicSSEUsage(streamOf(input), { onUsage: (u) => usages.push(u) })
    const text = await new Response(tapped).text()
    expect(text).toBe(input)
    expect(usages.at(-1)).toEqual({ prompt: 115, completion: 2 })
  })

  it('keeps message_start input tokens when message_delta only reports output', async () => {
    const usages: Array<{ prompt: number; completion: number }> = []
    const input =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    const tapped = tapAnthropicSSEUsage(streamOf(input), { onUsage: (u) => usages.push(u) })
    await new Response(tapped).text()
    expect(usages.at(-1)).toEqual({ prompt: 11, completion: 3 })
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
