import { describe, expect, it } from 'vitest'
import { translateOpenAIStreamToAnthropic } from '../../core/protocol/anthropicStream'

function streamOf(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line))
      controller.close()
    }
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Array<{ event: string; data: any }>> {
  const text = await new Response(stream).text()
  return text.split('\n\n').filter(Boolean).map((block) => {
    const [eventLine, dataLine] = block.split('\n')
    return { event: eventLine.replace('event: ', ''), data: JSON.parse(dataLine.replace('data: ', '')) }
  })
}

const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

describe('translateOpenAIStreamToAnthropic', () => {
  it('emits message_start, text deltas, message_delta and message_stop', async () => {
    const usages: Array<{ promptTokens: number; completionTokens: number }> = []
    const out = await collect(translateOpenAIStreamToAnthropic(streamOf([
      chunk({ choices: [{ delta: { content: 'Hel' } }] }),
      chunk({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }),
      chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      'data: [DONE]\n\n'
    ]), { model: 'm', inputTokens: 5, onUsage: (usage) => usages.push(usage) }))
    expect(out.map((e) => e.event)).toEqual([
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop'
    ])
    expect(out[0].data).toMatchObject({
      type: 'message_start',
      message: { type: 'message', role: 'assistant', model: 'm', usage: { input_tokens: 5, output_tokens: 0 } }
    })
    expect(out[1].data).toMatchObject({ content_block: { type: 'text', text: '' } })
    expect(out[5].data).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
    // message_start 用估算值；onUsage 报告上游最终的真实 usage
    expect(usages).toEqual([{ promptTokens: 5, completionTokens: 2 }])
  })

  it('emits tool_use blocks from tool_call deltas', async () => {
    const out = await collect(translateOpenAIStreamToAnthropic(streamOf([
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '' } }] } }] }),
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"p":1}' } }] }, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n'
    ]), { model: 'm', inputTokens: 3 }))
    const start = out.find((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
    expect(start?.data.content_block).toMatchObject({ type: 'tool_use', id: 'c1', name: 'read' })
    const delta = out.find((e) => e.event === 'content_block_delta')
    expect(delta?.data.delta).toEqual({ type: 'input_json_delta', partial_json: '{"p":1}' })
    expect(out.at(-2)?.data.delta.stop_reason).toBe('tool_use')
  })

  it('infers tool_use when tool blocks are emitted but upstream finishes with stop', async () => {
    const out = await collect(translateOpenAIStreamToAnthropic(streamOf([
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"p":1}' } }] } }] }),
      chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n'
    ]), { model: 'm', inputTokens: 3 }))
    const delta = out.at(-2)
    expect(delta?.event).toBe('message_delta')
    expect(delta?.data.delta.stop_reason).toBe('tool_use')
    expect(out.at(-1)?.event).toBe('message_stop')
  })

  it('keeps max_tokens when tool blocks are cut off by the token limit', async () => {
    const out = await collect(translateOpenAIStreamToAnthropic(streamOf([
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"p"' } }] } }] }),
      chunk({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      'data: [DONE]\n\n'
    ]), { model: 'm', inputTokens: 3 }))
    expect(out.at(-2)?.data.delta.stop_reason).toBe('max_tokens')
  })

  it('treats an upstream error frame as a stream failure', async () => {
    const errors: unknown[] = []
    const usages: unknown[] = []
    const out = await collect(translateOpenAIStreamToAnthropic(streamOf([
      chunk({ choices: [{ delta: { content: 'part' } }] }),
      chunk({ error: { message: 'upstream overloaded' } }),
      'data: [DONE]\n\n'
    ]), {
      model: 'm',
      inputTokens: 1,
      onUsage: (usage) => usages.push(usage),
      onError: (error) => errors.push(error)
    }))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe('upstream overloaded')
    // 错误帧不是正常结束：不得上报 usage，也不得补发 message_delta/message_stop
    expect(usages).toHaveLength(0)
    expect(out.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'error'])
    expect(out.at(-1)?.data).toMatchObject({ type: 'error', error: { type: 'api_error', message: 'upstream overloaded' } })
  })

  it('emits an anthropic error event without usage when the upstream stream breaks', async () => {
    let sent = false
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(new TextEncoder().encode(chunk({ choices: [{ delta: { content: 'part' } }] })))
          return
        }
        controller.error(new Error('upstream broke'))
      }
    })
    const errors: unknown[] = []
    const usages: unknown[] = []
    const out = await collect(translateOpenAIStreamToAnthropic(source, {
      model: 'm',
      inputTokens: 1,
      onUsage: (usage) => usages.push(usage),
      onError: (error) => errors.push(error)
    }))
    expect(errors).toHaveLength(1)
    expect(usages).toHaveLength(0)
    expect(out.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'error'])
    expect(out.at(-1)?.data).toMatchObject({ type: 'error', error: { type: 'api_error', message: 'upstream broke' } })
  })
})
