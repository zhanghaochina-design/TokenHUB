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
