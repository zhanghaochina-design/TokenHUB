import { describe, expect, it } from 'vitest'
import {
  anthropicToOpenAIResponse,
  DEFAULT_MAX_TOKENS,
  openAIToAnthropicRequest,
  translateAnthropicStreamToOpenAI
} from '../../core/protocol/openai'

describe('openAIToAnthropicRequest', () => {
  it('maps system, tools, tool calls and keeps tool results before user text', () => {
    const req = openAIToAnthropicRequest({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run', arguments: '{"x":1}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' },
        { role: 'user', content: 'next' }
      ],
      tools: [{ type: 'function', function: { name: 'run', description: 'run it', parameters: { type: 'object', properties: { x: { type: 'number' } } } } }],
      tool_choice: 'auto',
      stream: true
    }, 'claude-opus-5-5')

    expect(req.system).toBe('sys')
    expect(req.stream).toBe(true)
    expect(req.max_tokens).toBe(DEFAULT_MAX_TOKENS)
    expect(req.tools).toEqual([{ name: 'run', description: 'run it', input_schema: { type: 'object', properties: { x: { type: 'number' } } } }])
    expect(req.tool_choice).toEqual({ type: 'auto' })
    expect(req.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'run', input: { x: 1 } }]
    })
    expect(req.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'done' },
        { type: 'text', text: 'next' }
      ]
    })
  })

  it('maps image data urls and drops tools when tool_choice is none', () => {
    const req = openAIToAnthropicRequest({
      model: 'm',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
        ]
      }],
      tools: [{ type: 'function', function: { name: 'run' } }],
      tool_choice: 'none',
      max_tokens: 128
    }, 'm')

    expect(req.messages[0].content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }
    ])
    expect(req.max_tokens).toBe(128)
    expect(req.tools).toBeUndefined()
    expect(req.tool_choice).toBeUndefined()
  })
})

describe('anthropicToOpenAIResponse', () => {
  it('maps text and tool_use blocks into a chat completion', () => {
    const out = anthropicToOpenAIResponse({
      id: 'msg_1',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'toolu_1', name: 'run', input: { x: 1 } }
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 7, output_tokens: 2 }
    }, 'claude-opus-5-5')

    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'claude-opus-5-5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hi',
          tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'run', arguments: '{"x":1}' } }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }
    })
  })
})

describe('translateAnthropicStreamToOpenAI', () => {
  it('converts anthropic events into openai chunks and emits usage when requested', async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"po"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ng"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join('')
    const encoder = new TextEncoder()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse))
        controller.close()
      }
    })

    const text = await new Response(translateAnthropicStreamToOpenAI(source, { model: 'm', includeUsage: true })).text()
    expect(text).toContain('"role":"assistant"')
    expect(text).toContain('"content":"po"')
    expect(text).toContain('"content":"ng"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })
})
