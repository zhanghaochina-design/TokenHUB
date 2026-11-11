export interface SSEEvent {
  event?: string
  data: string
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    // 整段归一化 CRLF：跨 chunk 的 \r/\n 也能拼成 \r\n 后再替换
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      let event: string | undefined
      const data: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      if (data.length) yield { event, data: data.join('\n') }
    }
  }
  buffer = buffer.replace(/\r\n/g, '\n')
  if (buffer.trim()) {
    const data = buffer.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart())
    if (data.length) yield { data: data.join('\n') }
  }
}

export interface TapHooks {
  onUsage?(usage: { prompt: number; completion: number }): void
  onDone?(): void
  onError?(error: unknown): void
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface AnthropicStreamEvent {
  type?: string
  message?: { usage?: AnthropicUsage }
  usage?: AnthropicUsage
  error?: { message?: string }
}

/**
 * Anthropic 的 input_tokens 只算未命中缓存的输入，总输入量要再加上两级缓存读写；
 * 上游可能把输入量放在 message_start，也可能只在最终 message_delta 里给（OpenCode Go 属于后者）。
 */
export function anthropicInputTokens(usage: AnthropicUsage | undefined): number | null {
  if (!usage) return null
  const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
  if (parts.every((value) => value == null)) return null
  return parts.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

/**
 * 透传 Anthropic SSE 时旁路读取 usage 与 error 帧，客户端数据流不受影响。
 * 输入量取 message_start 与 message_delta 中最新出现的一份（两处都给时以 message_delta 为准），输出量取 message_delta 的最终值。
 */
export function tapAnthropicSSEUsage(stream: ReadableStream<Uint8Array>, hooks: TapHooks): ReadableStream<Uint8Array> {
  const [forTap, forClient] = stream.tee()
  void (async () => {
    let promptTokens = 0
    let completionTokens = 0
    try {
      for await (const event of parseSSE(forTap)) {
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
          promptTokens = anthropicInputTokens(parsed.message?.usage) ?? promptTokens
          completionTokens = parsed.message?.usage?.output_tokens ?? completionTokens
          hooks.onUsage?.({ prompt: promptTokens, completion: completionTokens })
        } else if (parsed.type === 'message_delta') {
          promptTokens = anthropicInputTokens(parsed.usage) ?? promptTokens
          completionTokens = parsed.usage?.output_tokens ?? completionTokens
          hooks.onUsage?.({ prompt: promptTokens, completion: completionTokens })
        } else if (parsed.type === 'message_stop') {
          break
        }
      }
    } catch (error) {
      hooks.onError?.(error)
    } finally {
      hooks.onDone?.()
    }
  })()
  return forClient
}

export function tapSSEUsage(stream: ReadableStream<Uint8Array>, hooks: TapHooks): ReadableStream<Uint8Array> {
  const [forTap, forClient] = stream.tee()
  void (async () => {
    try {
      for await (const event of parseSSE(forTap)) {
        if (event.data === '[DONE]') break
        try {
          const parsed = JSON.parse(event.data) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
          if (parsed.usage) {
            hooks.onUsage?.({
              prompt: parsed.usage.prompt_tokens ?? 0,
              completion: parsed.usage.completion_tokens ?? 0
            })
          }
        } catch {
          // 非 JSON 注释帧直接跳过
        }
      }
    } catch (error) {
      hooks.onError?.(error)
    } finally {
      hooks.onDone?.()
    }
  })()
  return forClient
}
