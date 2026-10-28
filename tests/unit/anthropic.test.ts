import { describe, expect, it } from 'vitest'
import { anthropicToOpenAI, countTokens, estimateTokens, mapFinish, openAIToAnthropicResponse } from '../../core/protocol/anthropic'
import type { AnthropicRequest } from '../../core/protocol/anthropicTypes'

const base: AnthropicRequest = {
  model: 'm', max_tokens: 100,
  system: 'be brief',
  messages: [
    { role: 'user', content: [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }
    ] },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'a.txt' } }
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'file body' },
      { type: 'text', text: 'continue' }
    ] }
  ],
  tools: [{ name: 'read', description: 'read file', input_schema: { type: 'object' } }],
  tool_choice: { type: 'auto' }
}

describe('anthropicToOpenAI', () => {
  it('maps system, images, tools and tool results', () => {
    const out = anthropicToOpenAI(base, 'up') as any
    expect(out.model).toBe('up')
    expect(out.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(out.messages[1].content[1].image_url.url).toBe('data:image/png;base64,AAA')
    expect(out.messages[2].tool_calls[0]).toMatchObject({ id: 'tu1', function: { name: 'read', arguments: '{"path":"a.txt"}' } })
    expect(out.messages[3]).toEqual({ role: 'tool', tool_call_id: 'tu1', content: 'file body' })
    expect(out.messages[4]).toEqual({ role: 'user', content: 'continue' })
    expect(out.tools[0]).toMatchObject({ type: 'function', function: { name: 'read' } })
    expect(out.tool_choice).toBe('auto')
    expect(out.max_tokens).toBe(100)
  })

  it('drops thinking and unknown fields', () => {
    const out = anthropicToOpenAI({ ...base, thinking: { type: 'enabled' } as never }, 'up') as any
    expect(out.thinking).toBeUndefined()
    const withTopK = anthropicToOpenAI({ ...base, top_k: 5 } as unknown as AnthropicRequest, 'up') as any
    expect(withTopK.top_k).toBeUndefined()
    expect(withTopK.metadata).toBeUndefined()
  })

  it('maps sampling fields and tool_choice variants', () => {
    const out = anthropicToOpenAI({ ...base, top_p: 0.5, stop_sequences: ['STOP'], tool_choice: { type: 'any' } }, 'up') as any
    expect(out.top_p).toBe(0.5)
    expect(out.stop).toEqual(['STOP'])
    expect(out.tool_choice).toBe('required')
    const forced = anthropicToOpenAI({ ...base, tool_choice: { type: 'tool', name: 'read' } }, 'up') as any
    expect(forced.tool_choice).toEqual({ type: 'function', function: { name: 'read' } })
  })

  it('joins system blocks and keeps url images', () => {
    const out = anthropicToOpenAI({
      model: 'm', max_tokens: 10,
      system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }]
    }, 'up') as any
    expect(out.messages[0]).toEqual({ role: 'system', content: 'a\nb' })
    expect(out.messages[1].content[0].image_url.url).toBe('https://x/y.png')
  })

  it('replaces non-text tool_result blocks with an omission marker', () => {
    const out = anthropicToOpenAI({
      model: 'm', max_tokens: 10,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'a' } }] },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: [
              { type: 'text', text: 'caption' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }
            ]
          }]
        }
      ]
    }, 'up') as any
    expect(out.messages[1]).toEqual({ role: 'tool', tool_call_id: 'tu1', content: 'caption\n[image omitted]' })
    expect(JSON.stringify(out)).not.toContain('undefined')
  })
})

describe('openAIToAnthropicResponse', () => {
  it('maps text, tool calls, finish reason and usage', () => {
    const out = openAIToAnthropicResponse({
      id: 'chatcmpl-1',
      choices: [{ message: { content: 'hello', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"p":1}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 9, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } }
    }, 'm')
    expect(out.stop_reason).toBe('tool_use')
    expect(out.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'c1', name: 'read', input: { p: 1 } }
    ])
    expect(out.usage).toMatchObject({ input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2 })
  })

  it('omits cache usage when the upstream does not report it', () => {
    const out = openAIToAnthropicResponse({
      id: 'chatcmpl-2',
      choices: [{ message: { content: 'hi' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 }
    }, 'm')
    expect(out).toMatchObject({
      type: 'message', role: 'assistant', model: 'm', stop_reason: 'max_tokens', stop_sequence: null,
      content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 3, output_tokens: 1 }
    })
    expect(out.usage).not.toHaveProperty('cache_read_input_tokens')
  })

  it('infers tool_use when tool calls arrive with finish_reason stop', () => {
    const out = openAIToAnthropicResponse({
      choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"p":1}' } }] }, finish_reason: 'stop' }]
    }, 'm')
    expect(out.stop_reason).toBe('tool_use')
    expect(out.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'read', input: { p: 1 } }])
  })

  it('infers tool_use when tool calls arrive without a finish reason', () => {
    const out = openAIToAnthropicResponse({
      choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] } }]
    }, 'm')
    expect(out.stop_reason).toBe('tool_use')
  })

  it('keeps max_tokens when tool calls are cut off by the token limit', () => {
    const out = openAIToAnthropicResponse({
      choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"p":' } }] }, finish_reason: 'length' }]
    }, 'm')
    expect(out.stop_reason).toBe('max_tokens')
  })

  it('keeps end_turn for text-only responses', () => {
    const out = openAIToAnthropicResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }, 'm')
    expect(out.stop_reason).toBe('end_turn')
  })

  it('tolerates malformed tool arguments', () => {
    const out = openAIToAnthropicResponse({
      choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'read', arguments: 'not-json' } }] }, finish_reason: 'tool_calls' }]
    }, 'm')
    expect(out.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'read', input: {} }])
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('only accepts plain objects as tool arguments', () => {
    const out = openAIToAnthropicResponse({
      choices: [{
        message: {
          tool_calls: [
            { id: 'arr', function: { name: 'a', arguments: '[1,2]' } },
            { id: 'num', function: { name: 'b', arguments: '42' } },
            { id: 'nil', function: { name: 'c', arguments: 'null' } }
          ]
        },
        finish_reason: 'tool_calls'
      }]
    }, 'm')
    expect(out.content).toEqual([
      { type: 'tool_use', id: 'arr', name: 'a', input: {} },
      { type: 'tool_use', id: 'num', name: 'b', input: {} },
      { type: 'tool_use', id: 'nil', name: 'c', input: {} }
    ])
  })
})

describe('mapFinish', () => {
  it('maps upstream finish reasons to anthropic stop reasons', () => {
    expect(mapFinish('length')).toBe('max_tokens')
    expect(mapFinish('tool_calls')).toBe('tool_use')
    expect(mapFinish('stop')).toBe('end_turn')
    expect(mapFinish(null)).toBe('end_turn')
  })
})

describe('estimateTokens', () => {
  it('is positive and grows with length', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0)
    expect(estimateTokens('你好世界')).toBeGreaterThanOrEqual(4)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })
})

describe('countTokens', () => {
  it('counts system, messages and tool definitions', () => {
    const minimal = countTokens({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] })
    expect(minimal).toBeGreaterThan(0)
    expect(countTokens(base)).toBeGreaterThan(minimal)
  })
})
