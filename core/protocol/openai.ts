import type { AnthropicContentBlock, AnthropicImageBlock, AnthropicMessage, AnthropicRequest } from './anthropicTypes'
import { parseSSE } from './sse'

interface OpenAIContentPart {
  type?: string
  text?: string
  image_url?: { url?: string }
}

interface OpenAIToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAIMessage {
  role?: string
  content?: string | OpenAIContentPart[]
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

interface OpenAITool {
  type?: string
  function?: { name?: string; description?: string; parameters?: unknown }
}

interface OpenAIRequest {
  messages?: OpenAIMessage[]
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: string | { type?: string; function?: { name?: string } }
}

function textOf(content: string | OpenAIContentPart[] | undefined): string {
  if (typeof content === 'string') return content
  return (content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
}

function imageBlock(url: string): AnthropicImageBlock {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/.exec(url)
  if (dataUrl) return { type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } }
  return { type: 'image', source: { type: 'url', url } }
}

function userBlocks(content: string | OpenAIContentPart[] | undefined): AnthropicContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  const blocks: AnthropicContentBlock[] = []
  for (const part of content ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text })
    else if (part.type === 'image_url' && part.image_url?.url) blocks.push(imageBlock(part.image_url.url))
  }
  return blocks
}

function toolInput(argumentsText: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText ?? '{}') as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // 参数不是合法 JSON 时退回空对象，交由上游按 schema 校验并报错。
  }
  return {}
}

/** Anthropic 的 max_tokens 必填；OpenAI 客户端未提供时用该默认值。 */
export const DEFAULT_MAX_TOKENS = 4096

/**
 * OpenAI chat/completions → Anthropic Messages。
 * tool 消息必须以 tool_result 块排在紧随其后的用户文本之前，否则 Claude 上游会拒绝工具结果。
 */
export function openAIToAnthropicRequest(body: Record<string, unknown>, upstreamModel: string): AnthropicRequest {
  const req = body as OpenAIRequest
  const messages: AnthropicMessage[] = []
  let pendingToolResults: AnthropicContentBlock[] = []

  for (const message of req.messages ?? []) {
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'tool') {
      pendingToolResults.push({ type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: textOf(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      if (pendingToolResults.length) {
        messages.push({ role: 'user', content: pendingToolResults })
        pendingToolResults = []
      }
      const blocks: AnthropicContentBlock[] = []
      const text = textOf(message.content)
      if (text) blocks.push({ type: 'text', text })
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id ?? `toolu_${crypto.randomUUID()}`,
          name: call.function?.name ?? '',
          input: toolInput(call.function?.arguments)
        })
      }
      if (blocks.length) messages.push({ role: 'assistant', content: blocks })
      continue
    }
    const blocks = userBlocks(message.content)
    if (pendingToolResults.length) {
      blocks.unshift(...pendingToolResults)
      pendingToolResults = []
    }
    if (blocks.length) messages.push({ role: 'user', content: blocks })
  }
  if (pendingToolResults.length) messages.push({ role: 'user', content: pendingToolResults })

  const system = (req.messages ?? [])
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => textOf(message.content))
    .filter((text) => text.length > 0)
    .join('\n\n')

  const out: AnthropicRequest = {
    model: upstreamModel,
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages
  }
  if (system) out.system = system
  if (typeof req.temperature === 'number') out.temperature = req.temperature
  if (typeof req.top_p === 'number') out.top_p = req.top_p
  if (req.stop) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop]
  if (req.stream === true) out.stream = true
  // tool_choice 为 none 时连工具定义一起省略，Anthropic 没有对应的 none 语义。
  if (req.tool_choice === 'none') return out

  const tools = (req.tools ?? []).filter((tool): tool is OpenAITool & { function: { name: string; description?: string; parameters?: unknown } } =>
    tool.type === 'function' && typeof tool.function?.name === 'string'
  )
  if (tools.length) {
    out.tools = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters !== null && typeof tool.function.parameters === 'object' && !Array.isArray(tool.function.parameters)
        ? tool.function.parameters as Record<string, unknown>
        : { type: 'object', properties: {} }
    }))
  }
  if (req.tool_choice === 'auto') out.tool_choice = { type: 'auto' }
  else if (req.tool_choice === 'required') out.tool_choice = { type: 'any' }
  else if (typeof req.tool_choice === 'object' && req.tool_choice.type === 'function' && req.tool_choice.function?.name) {
    out.tool_choice = { type: 'tool', name: req.tool_choice.function.name }
  }
  return out
}

interface AnthropicResponseLike {
  id?: string
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
  stop_reason?: string | null
  usage?: { input_tokens?: number; output_tokens?: number }
}

function openAIFinishReason(reason: string | null | undefined): string {
  if (reason === 'max_tokens') return 'length'
  if (reason === 'tool_use') return 'tool_calls'
  return 'stop'
}

export function anthropicToOpenAIResponse(data: unknown, model: string): Record<string, unknown> {
  const payload = data as AnthropicResponseLike
  const blocks = payload.content ?? []
  const text = blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  const toolCalls = blocks.filter((block) => block.type === 'tool_use').map((block) => ({
    id: block.id ?? `call_${crypto.randomUUID()}`,
    type: 'function',
    function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) }
  }))
  const message: Record<string, unknown> = { role: 'assistant', content: text || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  const promptTokens = payload.usage?.input_tokens ?? 0
  const completionTokens = payload.usage?.output_tokens ?? 0
  return {
    id: `chatcmpl-${payload.id ?? crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: openAIFinishReason(payload.stop_reason) }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
  }
}

export interface AnthropicToOpenAIStreamOptions {
  model: string
  /** 客户端要求 stream_options.include_usage 时才补 usage 块，与 OpenAI 官方行为一致。 */
  includeUsage?: boolean
  onUsage?(usage: { promptTokens: number; completionTokens: number }): void
  onError?(error: unknown): void
  onDone?(): void
}

interface AnthropicStreamEvent {
  type?: string
  index?: number
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null }
  usage?: { output_tokens?: number }
  error?: { message?: string }
}

export function translateAnthropicStreamToOpenAI(
  source: ReadableStream<Uint8Array>,
  options: AnthropicToOpenAIStreamOptions
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let cancelled = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (data: string): boolean => {
        if (cancelled) return false
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          return true
        } catch {
          cancelled = true
          return false
        }
      }
      const send = (payload: unknown): boolean => write(JSON.stringify(payload))
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model: options.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      })

      let promptTokens = 0
      let completionTokens = 0
      const toolIndexes = new Map<number, number>()
      let nextToolIndex = 0
      write(JSON.stringify(chunk({ role: 'assistant', content: '' })))

      try {
        for await (const event of parseSSE(source)) {
          if (cancelled) break
          if (!event.data) continue
          let parsed: AnthropicStreamEvent
          try {
            parsed = JSON.parse(event.data) as AnthropicStreamEvent
          } catch {
            continue
          }
          if (event.event === 'error' || parsed.type === 'error') {
            throw new Error(parsed.error?.message ?? 'upstream stream error')
          }
          if (parsed.type === 'message_start') {
            promptTokens = parsed.message?.usage?.input_tokens ?? promptTokens
            completionTokens = parsed.message?.usage?.output_tokens ?? completionTokens
          } else if (parsed.type === 'content_block_start') {
            if (parsed.content_block?.type === 'tool_use') {
              const index = nextToolIndex++
              toolIndexes.set(parsed.index ?? 0, index)
              send(chunk({
                tool_calls: [{
                  index,
                  id: parsed.content_block.id ?? `call_${crypto.randomUUID()}`,
                  type: 'function',
                  function: { name: parsed.content_block.name ?? '', arguments: '' }
                }]
              }))
            }
          } else if (parsed.type === 'content_block_delta') {
            if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
              send(chunk({ content: parsed.delta.text }))
            } else if (parsed.delta?.type === 'input_json_delta' && parsed.delta.partial_json) {
              send(chunk({ tool_calls: [{ index: toolIndexes.get(parsed.index ?? 0) ?? 0, function: { arguments: parsed.delta.partial_json } }] }))
            }
          } else if (parsed.type === 'message_delta') {
            completionTokens = parsed.usage?.output_tokens ?? completionTokens
            send(chunk({}, openAIFinishReason(parsed.delta?.stop_reason)))
          } else if (parsed.type === 'message_stop') {
            break
          }
        }
        if (!cancelled) {
          if (options.includeUsage) {
            send({
              id,
              object: 'chat.completion.chunk',
              created,
              model: options.model,
              choices: [],
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
            })
          }
          options.onUsage?.({ promptTokens, completionTokens })
          write('[DONE]')
        }
      } catch (error) {
        options.onError?.(error)
        if (!cancelled) {
          send({ error: { message: error instanceof Error ? error.message : 'stream failed', type: 'api_error' } })
          write('[DONE]')
        }
      } finally {
        options.onDone?.()
        try {
          controller.close()
        } catch {
          // 客户端已断开时关闭会抛错，忽略。
        }
      }
    },
    cancel() {
      cancelled = true
    }
  })
}
