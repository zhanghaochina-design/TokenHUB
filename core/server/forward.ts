import { Agent, fetch as undiciFetch } from 'undici'
import type { ProviderConfig, UpstreamFailure } from '../types'
import { classifyUpstreamResponse } from '../errors'
import { CONNECT_TIMEOUT_MS, FIRST_BYTE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from '../appInfo'
import { anthropicBaseUrlFor } from '../providers/presets'

export type FetchFn = typeof undiciFetch

const agent = new Agent({
  connect: { timeout: CONNECT_TIMEOUT_MS },
  headersTimeout: FIRST_BYTE_TIMEOUT_MS,
  bodyTimeout: STREAM_IDLE_TIMEOUT_MS
})

export interface ForwardOptions {
  provider: ProviderConfig
  upstreamModel: string
  apiKey: string
  body: Record<string, unknown>
  signal: AbortSignal
  fetchFn?: FetchFn
  onDisableStreamUsage?: (providerId: string) => void
  extraHeaders?: Record<string, string>
}

export type ForwardOutcome =
  | { ok: true; response: Response; injectedStreamUsage: boolean }
  | { ok: false; failure: UpstreamFailure }

export async function forwardOpenAI(options: ForwardOptions): Promise<ForwardOutcome> {
  const { provider, upstreamModel, apiKey, body, signal, onDisableStreamUsage } = options
  const fetchFn = options.fetchFn ?? undiciFetch
  const wantsStream = body.stream === true
  const inject = wantsStream && provider.quota.injectStreamUsage
  const payload: Record<string, unknown> = { ...body, model: upstreamModel }
  if (inject) payload.stream_options = { ...(body.stream_options as object | undefined), include_usage: true }

  const send = async (withInject: boolean): Promise<Response> =>
    fetchFn(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: withInject || wantsStream ? 'text/event-stream' : 'application/json',
        ...(options.extraHeaders ?? {})
      },
      body: JSON.stringify(payload),
      signal,
      dispatcher: agent
    } as never)

  let response: Response
  try {
    response = await send(inject)
  } catch (error) {
    return {
      ok: false,
      failure: { kind: 'transient', status: null, message: error instanceof Error ? error.message : 'network error', retryAfterMs: null }
    }
  }

  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 8_000)
    if (inject && response.status === 400 && /stream_options/i.test(text)) {
      onDisableStreamUsage?.(provider.id)
      payload.stream_options = body.stream_options
      try {
        response = await send(false)
      } catch (error) {
        return {
          ok: false,
          failure: { kind: 'transient', status: null, message: error instanceof Error ? error.message : 'network error', retryAfterMs: null }
        }
      }
      if (!response.ok) {
        const retryText = (await response.text().catch(() => '')).slice(0, 8_000)
        return { ok: false, failure: classifyUpstreamResponse(response.status, retryText, response.headers) }
      }
      return { ok: true, response, injectedStreamUsage: false }
    }
    return { ok: false, failure: classifyUpstreamResponse(response.status, text, response.headers) }
  }

  return { ok: true, response, injectedStreamUsage: inject }
}

export interface ForwardAnthropicOptions {
  provider: ProviderConfig
  upstreamModel: string
  apiKey: string
  body: Record<string, unknown>
  signal: AbortSignal
  anthropicVersion: string
  anthropicBeta?: string
  extraHeaders?: Record<string, string>
  fetchFn?: FetchFn
}

/**
 * Anthropic 形状上游：请求体原样透传（只替换 model），响应/SSE 由调用方按客户端协议处理。
 * 鉴权按 Anthropic 约定走 x-api-key；CommandCode 等网关只在 /messages 上提供 Claude 模型。
 */
export async function forwardAnthropic(options: ForwardAnthropicOptions): Promise<ForwardOutcome> {
  const { provider, upstreamModel, apiKey, body, signal } = options
  const fetchFn = options.fetchFn ?? undiciFetch
  const wantsStream = body.stream === true
  const payload: Record<string, unknown> = { ...body, model: upstreamModel }
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': options.anthropicVersion,
    'content-type': 'application/json',
    accept: wantsStream ? 'text/event-stream' : 'application/json',
    ...(options.anthropicBeta ? { 'anthropic-beta': options.anthropicBeta } : {}),
    ...(options.extraHeaders ?? {})
  }

  let response: Response
  try {
    response = await fetchFn(`${anthropicBaseUrlFor(provider)}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
      dispatcher: agent
    } as never)
  } catch (error) {
    return {
      ok: false,
      failure: { kind: 'transient', status: null, message: error instanceof Error ? error.message : 'network error', retryAfterMs: null }
    }
  }

  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 8_000)
    return { ok: false, failure: classifyUpstreamResponse(response.status, text, response.headers) }
  }

  return { ok: true, response, injectedStreamUsage: false }
}
