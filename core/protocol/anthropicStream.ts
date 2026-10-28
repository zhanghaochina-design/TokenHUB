import { mapFinish } from './anthropic'
import type { AnthropicResponse } from './anthropicTypes'
import { parseSSE } from './sse'

export interface AnthropicStreamOptions {
  model: string
  /** Anthropic 协议要求 message_start 立即给出 input_tokens；用本地估算值，真实值只能事后写历史。 */
  inputTokens: number
  /** 正常结束时报告上游最终 usage（未上报 usage 时为本地估算的输入量和 0 输出）。 */
  onUsage?(usage: { promptTokens: number; completionTokens: number }): void
  /** 上游读取失败（含客户端中断导致的中止）时调用一次。 */
  onError?(error: unknown): void
  /** 无论成功、失败还是客户端取消，整条流结束后调用一次，用于写历史。 */
  onDone?(): void
}

interface OpenAIStreamToolCall {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAIStreamDelta {
  content?: string
  tool_calls?: OpenAIStreamToolCall[]
}

interface OpenAIStreamChunk {
  choices?: Array<{ delta?: OpenAIStreamDelta; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  /** 部分兼容网关用 200 + error 帧报告失败；必须按失败处理，不能当成空成功消息。 */
  error?: { message?: string; type?: string } | null
}

/**
 * 把 OpenAI `chat/completions` 的 SSE 流实时翻译成 Anthropic Messages 事件流：
 * message_start → content_block_start/delta（text 或 tool_use）→ content_block_stop
 * → message_delta（stop_reason + output_tokens）→ message_stop。
 * 上游中途断开时以 Anthropic `error` 事件收尾，不再发送 message_delta/message_stop。
 */
export function translateOpenAIStreamToAnthropic(
  source: ReadableStream<Uint8Array>,
  options: AnthropicStreamOptions
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  // 客户端取消后 enqueue 会抛错；用该标志让所有收尾写入安静退出。
  let cancelled = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): boolean => {
        if (cancelled) return false
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          return true
        } catch {
          cancelled = true
          return false
        }
      }

      let nextBlock = 0
      let textBlock: number | null = null
      const toolBlocks = new Map<number, number>()
      let stopReason: AnthropicResponse['stop_reason'] = null
      let outputTokens = 0
      let promptTokens = options.inputTokens

      send('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${crypto.randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model: options.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: options.inputTokens, output_tokens: 0 }
        }
      })

      try {
        for await (const event of parseSSE(source)) {
          if (cancelled) break
          if (event.data === '[DONE]') break
          let chunk: OpenAIStreamChunk | null
          try {
            chunk = JSON.parse(event.data) as OpenAIStreamChunk | null
          } catch {
            continue
          }
          if (!chunk || typeof chunk !== 'object') continue
          if (chunk.error) {
            // 错误帧走下方 catch 的失败路径：客户端收到 error 事件、供应商按 transient 冷却；
            // 若当普通帧跳过则会产出「成功但为空」的消息，客户端与历史都会被误导。
            throw new Error(typeof chunk.error.message === 'string' && chunk.error.message ? chunk.error.message : 'upstream stream error')
          }

          if (chunk.usage?.prompt_tokens != null) promptTokens = chunk.usage.prompt_tokens
          if (chunk.usage?.completion_tokens != null) outputTokens = chunk.usage.completion_tokens

          const choice = chunk.choices?.[0]
          if (!choice) continue
          const delta = choice.delta ?? {}

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            if (textBlock === null) {
              textBlock = nextBlock++
              send('content_block_start', { type: 'content_block_start', index: textBlock, content_block: { type: 'text', text: '' } })
            }
            send('content_block_delta', { type: 'content_block_delta', index: textBlock, delta: { type: 'text_delta', text: delta.content } })
          }

          for (const call of delta.tool_calls ?? []) {
            // Anthropic 的 text 与 tool_use 必须是不同 content block：遇到工具调用先收口文本块。
            if (textBlock !== null) {
              send('content_block_stop', { type: 'content_block_stop', index: textBlock })
              textBlock = null
            }
            let index = toolBlocks.get(call.index)
            if (index === undefined) {
              index = nextBlock++
              toolBlocks.set(call.index, index)
              send('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: {
                  type: 'tool_use',
                  id: call.id ?? `toolu_${crypto.randomUUID()}`,
                  name: call.function?.name ?? '',
                  input: {}
                }
              })
            }
            if (call.function?.arguments) {
              send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.function.arguments } })
            }
          }

          if (choice.finish_reason) stopReason = mapFinish(choice.finish_reason)
        }

        if (!cancelled) {
          const openBlocks: number[] = [...(textBlock !== null ? [textBlock] : []), ...toolBlocks.values()].sort((a, b) => a - b)
          for (const index of openBlocks) send('content_block_stop', { type: 'content_block_stop', index })
          // Anthropic 客户端只在 stop_reason 为 tool_use 时执行工具；上游把带工具调用的流标成 stop
          // 时必须纠正为 tool_use，否则客户端把工具调用当作普通回合结束。max_tokens 保持原样。
          const mapped = stopReason ?? 'end_turn'
          const finalStop = mapped === 'end_turn' && toolBlocks.size > 0 ? 'tool_use' : mapped
          send('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: finalStop, stop_sequence: null },
            usage: { output_tokens: outputTokens }
          })
          send('message_stop', { type: 'message_stop' })
          if (!cancelled) {
            options.onUsage?.({ promptTokens, completionTokens: outputTokens })
            controller.close()
          }
        }
      } catch (error) {
        options.onError?.(error)
        if (!cancelled) {
          send('error', {
            type: 'error',
            error: { type: 'api_error', message: error instanceof Error ? error.message : 'stream failed' }
          })
          try {
            controller.close()
          } catch {
            // 客户端已断开时无需再关闭
          }
        }
      } finally {
        options.onDone?.()
      }
    },
    cancel() {
      cancelled = true
    }
  })
}
