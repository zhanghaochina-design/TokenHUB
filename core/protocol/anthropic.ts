import type { AnthropicContentBlock, AnthropicImageBlock, AnthropicRequest, AnthropicResponse, AnthropicTextBlock } from './anthropicTypes'

function systemText(system: AnthropicRequest['system']): string {
  if (!system) return ''
  return typeof system === 'string' ? system : system.map((b) => b.text).join('\n')
}

function resultText(content: string | Array<AnthropicTextBlock | AnthropicImageBlock>): string {
  if (typeof content === 'string') return content
  // OpenAI 的 tool 消息只接受文本：tool_result 里的图片等非文本块用占位标记，避免把 undefined 发给上游。
  return content.map((block) => (block.type === 'text' ? block.text : '[image omitted]')).join('\n')
}

function mapToolChoice(choice: NonNullable<AnthropicRequest['tool_choice']>): unknown {
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  return { type: 'function', function: { name: choice.name } }
}

export function anthropicToOpenAI(req: AnthropicRequest, upstreamModel: string): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = []
  const system = systemText(req.system)
  if (system) messages.push({ role: 'system', content: system })

  for (const message of req.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content })
      continue
    }
    const texts: Array<Record<string, unknown>> = []
    const toolCalls: Array<Record<string, unknown>> = []
    const toolResults: Array<Record<string, unknown>> = []
    for (const block of message.content as AnthropicContentBlock[]) {
      if (block.type === 'text') texts.push({ type: 'text', text: block.text })
      else if (block.type === 'image') {
        const url = block.source.type === 'base64' ? `data:${block.source.media_type};base64,${block.source.data}` : block.source.url
        texts.push({ type: 'image_url', image_url: { url } })
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } })
      } else if (block.type === 'tool_result') {
        toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content: resultText(block.content) })
      }
    }
    if (message.role === 'assistant') {
      const out: Record<string, unknown> = { role: 'assistant' }
      if (texts.length) out.content = texts
      if (toolCalls.length) out.tool_calls = toolCalls
      if (!texts.length && !toolCalls.length) out.content = ''
      messages.push(out)
    } else {
      // OpenAI 要求 tool 消息紧跟 assistant 的 tool_calls，因此工具结果必须先于用户文本。
      messages.push(...toolResults)
      // 纯文本用户消息压成字符串：与 OpenAI 客户端的常见形态一致，也便于上游校验。
      if (texts.length === 1 && texts[0].type === 'text') messages.push({ role: 'user', content: texts[0].text })
      else if (texts.length) messages.push({ role: 'user', content: texts })
    }
  }

  const out: Record<string, unknown> = { model: upstreamModel, messages, max_tokens: req.max_tokens }
  if (req.temperature != null) out.temperature = req.temperature
  if (req.top_p != null) out.top_p = req.top_p
  if (req.stop_sequences?.length) out.stop = req.stop_sequences
  if (req.stream) out.stream = true
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }))
  }
  if (req.tool_choice) out.tool_choice = mapToolChoice(req.tool_choice)
  return out
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown
    // tool_use.input 必须是对象；数组/数字/null 等合法 JSON 也不能直接当作 input。
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return {}
  } catch {
    return {}
  }
}

/** 供 Task 9 的流式转译复用 finish_reason → stop_reason 映射。 */
export function mapFinish(reason: string | null | undefined): AnthropicResponse['stop_reason'] {
  if (reason === 'length') return 'max_tokens'
  if (reason === 'tool_calls') return 'tool_use'
  return 'end_turn'
}

export function openAIToAnthropicResponse(data: unknown, model: string): AnthropicResponse {
  const payload = data as {
    id?: string
    choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  }
  const choice = payload.choices?.[0]
  const content: AnthropicResponse['content'] = []
  if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content })
  for (const call of choice?.message?.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: safeJson(call.function.arguments) })
  }
  const mapped = mapFinish(choice?.finish_reason)
  // 部分 OpenAI 兼容上游在有 tool_calls 时仍回 finish_reason:'stop' 或缺省（流式分支已按同样规则纠正）。
  // Anthropic 客户端只有看到 tool_use 才会执行工具，因此输出了工具块时把 end_turn 纠正为 tool_use；
  // max_tokens 等其它原因保持不变，避免掩盖被截断的工具调用。
  const stopReason = mapped === 'end_turn' && content.some((block) => block.type === 'tool_use') ? 'tool_use' : mapped
  return {
    id: `msg_${payload.id ?? crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: payload.usage?.prompt_tokens ?? 0,
      output_tokens: payload.usage?.completion_tokens ?? 0,
      ...(payload.usage?.prompt_tokens_details?.cached_tokens != null
        ? { cache_read_input_tokens: payload.usage.prompt_tokens_details.cached_tokens }
        : {})
    }
  }
}

export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

export function countTokens(req: AnthropicRequest): number {
  const parts: string[] = [systemText(req.system)]
  for (const message of req.messages) {
    if (typeof message.content === 'string') parts.push(message.content)
    else for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
      if (block.type === 'tool_use') parts.push(JSON.stringify(block.input))
      if (block.type === 'tool_result') parts.push(resultText(block.content))
    }
  }
  if (req.tools) parts.push(JSON.stringify(req.tools))
  return estimateTokens(parts.join('\n'))
}
