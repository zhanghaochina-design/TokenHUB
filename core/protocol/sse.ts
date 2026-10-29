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

interface AnthropicStreamEvent {
  type?: string
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  usage?: { output_tokens?: number }
  error?: { message?: string }
}

/**
 * 透传 Anthropic SSE 时旁路读取 usage 与 error 帧，客户端数据流不受影响。
 * usage 口径与 translateOpenAIStreamToAnthropic 一致：message_start 给输入量，message_delta 给最终输出量。
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
          promptTokens = parsed.message?.usage?.input_tokens ?? promptTokens
          completionTokens = parsed.message?.usage?.output_tokens ?? completionTokens
          hooks.onUsage?.({ prompt: promptTokens, completion: completionTokens })
        } else if (parsed.type === 'message_delta') {
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
