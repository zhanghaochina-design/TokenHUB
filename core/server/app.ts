import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppConfig, ErrorKind, HistorySink, MergedModel, Protocol, UpstreamFailure } from '../types'
import type { RuntimeStore } from '../router/runtime'
import { resolveCandidates, executeWithFailover, type AttemptResult, type Candidate } from '../router/router'
import { anthropicError, anthropicErrorType, errorForProtocol, openAIError, protocolError, type ErrorProtocol } from './errors'
import { providedKey, safeEqual } from './auth'
import { forwardAnthropic, forwardOpenAI, type ForwardOutcome } from './forward'
import { protocolSupported, upstreamExtraHeaders, upstreamProtocol } from '../providers/presets'
import { APP_NAME, MAX_BODY_BYTES } from '../appInfo'
import { anthropicToOpenAI, countTokens, openAIToAnthropicResponse } from '../protocol/anthropic'
import { translateOpenAIStreamToAnthropic } from '../protocol/anthropicStream'
import type { AnthropicRequest } from '../protocol/anthropicTypes'
import { anthropicToOpenAIResponse, openAIToAnthropicRequest, translateAnthropicStreamToOpenAI } from '../protocol/openai'
import { tapAnthropicSSEUsage, tapSSEUsage } from '../protocol/sse'

export interface AppDeps {
  getConfig(): AppConfig
  getProviderKey(id: string): string | null
  getLocalApiKey(): string | null
  getCatalog(): MergedModel[]
  runtime: RuntimeStore
  history: HistorySink
  isPaused(): boolean
  getPort?(): number
  onModelMissing?(providerId: string): void
  // 本地目录里根本没有的模型名：触发一次限流的模型发现，让新上架模型无需重启即可路由。
  onUnknownModel?(): void
  onQuotaFailure?(providerId: string): void
  onDisableStreamUsage?(providerId: string): void
  now?: () => Date
  fetchFn?: Parameters<typeof forwardOpenAI>[0]['fetchFn']
}

interface FailureContext {
  started: number
  requestId: string
  protocol: ErrorProtocol
  model: string
  stream: boolean
}

interface HistoryDraft {
  httpStatus: number
  outcome: 'ok' | 'error'
  providerId: string | null
  upstreamModel: string | null
  promptTokens: number | null
  completionTokens: number | null
  firstByteMs: number | null
  errorKind: ErrorKind | null
  failoverFrom: string[]
}

type ForwardedResponse = Extract<ForwardOutcome, { ok: true }> & { protocol: Protocol }

// 首字节前只在这些状态（及全部 5xx）上换入口重试一次；鉴权/额度问题两端共用同一 Key，重试没有意义。
const PROTOCOL_FALLBACK_STATUSES = new Set([400, 404, 405, 422])

/** 客户端主动断开：不算供应商故障，不触发冷却/故障转移，也不计入瞬时退避（runtime.markFailure 对 request 只计入 consecutiveFailures）。 */
function clientAborted(): UpstreamFailure {
  return { kind: 'request', status: null, message: 'client aborted the request', retryAfterMs: null }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  // 上游（如 OpenCode Go）按会话 ID 路由并复用提示缓存：优先透传客户端原生会话头，缺失时每请求生成 UUID。
  const sessionIdOf = (c: Context): string =>
    c.req.header('x-claude-code-session-id') ??
    c.req.header('x-session-id') ??
    c.req.header('session-id') ??
    c.req.header('x-session-affinity') ??
    crypto.randomUUID()

  const appendHistory = (context: FailureContext, draft: HistoryDraft): void => {
    void deps.history.append({
      ts: now().toISOString(),
      requestId: context.requestId,
      protocol: context.protocol,
      model: context.model,
      stream: context.stream,
      latencyMs: Date.now() - context.started,
      ...draft
    }).catch(() => {})
  }

  const recordFailure = (
    context: FailureContext,
    httpStatus: number,
    errorKind: ErrorKind,
    providerId: string | null,
    upstreamModel: string | null,
    failoverFrom: string[]
  ): void => {
    appendHistory(context, {
      httpStatus,
      outcome: 'error',
      providerId,
      upstreamModel,
      promptTokens: null,
      completionTokens: null,
      firstByteMs: null,
      errorKind,
      failoverFrom
    })
  }

  const recordSuccess = (
    context: FailureContext,
    promptTokens: number | null,
    completionTokens: number | null,
    providerId: string,
    upstreamModel: string,
    firstByteMs: number,
    failoverFrom: string[]
  ): void => {
    appendHistory(context, {
      httpStatus: 200,
      outcome: 'ok',
      providerId,
      upstreamModel,
      promptTokens,
      completionTokens,
      firstByteMs,
      errorKind: null,
      failoverFrom
    })
  }

  const errorResponse = (
    c: Context,
    protocol: ErrorProtocol,
    status: ContentfulStatusCode,
    message: string,
    failure: UpstreamFailure | null,
    tried: string[],
    anthropicType?: string
  ): Response => {
    const response = errorForProtocol(c, protocol, status, message, anthropicType ?? anthropicErrorType(failure?.kind ?? null))
    const providerId = tried.at(-1)
    if (providerId) response.headers.set('x-tokenhub-provider', providerId)
    if (failure?.retryAfterMs != null) {
      response.headers.set('retry-after', String(Math.max(0, Math.ceil(failure.retryAfterMs / 1000))))
    }
    return response
  }

  // 客户端中断不是供应商故障：OpenAI 与 Anthropic 路由共用同一套转发/中断判定。
  const runAttempt = async (
    c: Context,
    candidate: Candidate,
    bodies: { anthropic: AnthropicRequest; openai: Record<string, unknown> },
    sessionId: string,
    clientProtocol: Protocol
  ): Promise<AttemptResult<ForwardedResponse>> => {
    if (c.req.raw.signal.aborted) return { ok: false, failure: clientAborted() }
    const apiKey = deps.getProviderKey(candidate.provider.id)
    if (!apiKey) return { ok: false, failure: { kind: 'auth' as const, status: 401, message: 'missing api key', retryAfterMs: null } }
    const extraHeaders = upstreamExtraHeaders(candidate.provider, sessionId)
    const support = candidate.provider.protocolSupport?.[candidate.upstreamModel]

    const forward = (protocol: Protocol) => protocol === 'anthropic'
      ? forwardAnthropic({
          provider: candidate.provider,
          upstreamModel: candidate.upstreamModel,
          apiKey,
          body: bodies.anthropic as unknown as Record<string, unknown>,
          anthropicVersion: c.req.header('anthropic-version') ?? '2023-06-01',
          anthropicBeta: c.req.header('anthropic-beta'),
          extraHeaders,
          signal: c.req.raw.signal,
          fetchFn: deps.fetchFn
        })
      : forwardOpenAI({
          provider: candidate.provider,
          upstreamModel: candidate.upstreamModel,
          apiKey,
          body: bodies.openai,
          signal: c.req.raw.signal,
          fetchFn: deps.fetchFn,
          extraHeaders,
          onDisableStreamUsage: deps.onDisableStreamUsage
        })

    let protocol = upstreamProtocol(candidate.provider.preset, candidate.upstreamModel, clientProtocol, support)
    let forwarded = await forward(protocol)
    // 仅当首选形状与客户端一致、且另一形状没有被明确判死时，才在首字节前换入口重试。
    if (
      !forwarded.ok &&
      !c.req.raw.signal.aborted &&
      protocol === clientProtocol &&
      forwarded.failure.status !== null &&
      (forwarded.failure.status >= 500 || PROTOCOL_FALLBACK_STATUSES.has(forwarded.failure.status))
    ) {
      const alternate: Protocol = protocol === 'anthropic' ? 'openai' : 'anthropic'
      if (protocolSupported(candidate.provider.preset, candidate.upstreamModel, alternate, support) !== false) {
        const retried = await forward(alternate)
        if (retried.ok) return { ok: true as const, value: { ...retried, protocol: alternate } }
        if (!c.req.raw.signal.aborted) {
          protocol = alternate
          forwarded = retried
        }
      }
    }
    if (!forwarded.ok && c.req.raw.signal.aborted) return { ok: false, failure: clientAborted() }
    return forwarded.ok
      ? { ok: true as const, value: { ...forwarded, protocol } }
      : { ok: false as const, failure: forwarded.failure }
  }

  app.use('*', bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => protocolError(c, 413, 'request body too large')
  }))

  app.use('/v1/*', async (c, next) => {
    const localKey = deps.getLocalApiKey()
    if (localKey) {
      const key = providedKey(c.req.raw.headers)
      if (!key || !safeEqual(key, localKey)) {
        return protocolError(c, 401, 'invalid local api key', 'authentication_error')
      }
    }
    if (deps.isPaused()) return protocolError(c, 503, 'routing is paused')
    await next()
  })

  app.get('/health', (c) => c.json({ status: 'ok', name: APP_NAME, port: deps.getPort?.() ?? null, paused: deps.isPaused() }))

  app.get('/v1/models', (c) => {
    const catalog = deps.getCatalog()
    if (c.req.header('anthropic-version')) {
      return c.json({
        data: catalog.map((m) => ({ id: m.id, type: 'model', display_name: m.id, created_at: '2026-01-01T00:00:00Z' })),
        has_more: false,
        first_id: catalog[0]?.id ?? null,
        last_id: catalog.at(-1)?.id ?? null
      })
    }
    return c.json({ object: 'list', data: catalog.map((m) => ({ id: m.id, object: 'model', owned_by: APP_NAME, created: 0 })) })
  })

  app.post('/v1/chat/completions', async (c) => {
    const started = Date.now()
    const requestId = crypto.randomUUID()
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || typeof body.model !== 'string') return openAIError(c, 400, 'model is required')

    const wantsStream = body.stream === true
    const resolution = resolveCandidates({ requestedModel: body.model, providers: deps.getConfig().providers, catalog: deps.getCatalog(), runtime: deps.runtime })
    const failureContext: FailureContext = { started, requestId, protocol: 'openai', model: resolution.model, stream: wantsStream }

    if (!resolution.modelKnown) {
      // 目录里没有这个名字：可能是供应商刚上架新模型，触发一次限流刷新（Hub 内 60s 合并）。
      deps.onUnknownModel?.()
      recordFailure(failureContext, 404, 'model_missing', null, null, [])
      return errorResponse(c, 'openai', 404, `unknown model: ${resolution.model}`, null, [])
    }
    if (resolution.candidates.length === 0) {
      recordFailure(failureContext, 503, 'unknown', null, null, [])
      // 候选全在冷却：带上剩余秒数，客户端按 Retry-After 等待，而不是 1s 内反复撞同一个冷却窗口。
      const cooldown = resolution.retryAfterMs
      return errorResponse(c, 'openai', 503, 'no available provider for this model',
        cooldown ? { kind: 'unknown', status: 503, message: 'provider cooling down', retryAfterMs: cooldown } : null, [])
    }

    const sessionId = sessionIdOf(c)
    const result = await executeWithFailover(resolution.candidates, (candidate) => runAttempt(c, candidate, {
      anthropic: openAIToAnthropicRequest(body, candidate.upstreamModel),
      openai: body
    }, sessionId, 'openai'), deps.runtime, {
      onModelMissing: deps.onModelMissing,
      onQuotaFailure: deps.onQuotaFailure
    })

    if (!result.ok) {
      const status = (result.failure.status ?? 502) as ContentfulStatusCode
      const last = resolution.candidates.find((candidate) => candidate.provider.id === result.tried.at(-1))
      recordFailure(failureContext, status, result.failure.kind, last?.provider.id ?? null, last?.upstreamModel ?? null, result.tried.slice(0, -1))
      return errorResponse(c, 'openai', status, result.failure.message, result.failure, result.tried)
    }

    if (wantsStream) {
      const upstreamBody = result.value.response.body
      if (!upstreamBody) {
        // executeWithFailover 已在拿到响应头时 markSuccess；200 但无 body 仍要让供应商冷却，
        // 否则它会一直被判为健康并继续接流式请求。
        deps.runtime.markFailure(result.candidate.provider, { kind: 'transient', status: null, message: 'upstream returned no body', retryAfterMs: null })
        recordFailure(failureContext, 502, 'transient', result.candidate.provider.id, result.candidate.upstreamModel, result.tried.slice(0, -1))
        return errorResponse(c, 'openai', 502, 'upstream returned no body', null, result.tried)
      }
      const headersAt = Date.now()
      let usage: { promptTokens: number | null; completionTokens: number | null } = { promptTokens: null, completionTokens: null }
      let streamError: unknown = null
      const onStreamError = (error: unknown): void => {
        streamError = error
        // executeWithFailover 已在拿到响应头时 markSuccess；流中途才断则需补一次失败，
        // 否则供应商会永远保持健康。客户端主动断开不算供应商故障。
        if (!c.req.raw.signal.aborted) {
          deps.runtime.markFailure(result.candidate.provider, {
            kind: 'transient',
            status: null,
            message: error instanceof Error ? error.message : String(error),
            retryAfterMs: null
          })
        }
      }
      const onStreamDone = (): void => {
        void deps.history.append({
          ts: now().toISOString(),
          requestId,
          protocol: 'openai',
          model: resolution.model,
          providerId: result.candidate.provider.id,
          upstreamModel: result.candidate.upstreamModel,
          stream: true,
          httpStatus: 200,
          outcome: streamError ? 'error' : 'ok',
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          latencyMs: Date.now() - started,
          firstByteMs: headersAt - started,
          errorKind: streamError ? (c.req.raw.signal.aborted ? 'request' : 'transient') : null,
          failoverFrom: result.tried.slice(0, -1)
        }).catch(() => {})
      }
      const streamHeaders = {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-tokenhub-provider': result.candidate.provider.id
      }

      if (result.value.protocol === 'anthropic') {
        const includeUsage = (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true
        const translated = translateAnthropicStreamToOpenAI(upstreamBody, {
          model: resolution.model,
          includeUsage,
          onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens } },
          onError: onStreamError,
          onDone: onStreamDone
        })
        return c.body(translated, 200, streamHeaders)
      }

      const tapped = tapSSEUsage(upstreamBody, {
        onUsage: (u) => { usage = { promptTokens: u.prompt, completionTokens: u.completion } },
        onError: onStreamError,
        onDone: onStreamDone
      })

      return c.body(tapped, 200, streamHeaders)
    }

    const response = result.value.response
    const headersAt = Date.now()
    const data = await response.json().catch(() => null)
    if (!data) {
      const aborted = c.req.raw.signal.aborted
      // executeWithFailover 已在拿到响应头时 markSuccess；200 但 body 不可解析时需补记失败，
      // 否则该供应商会一直被判为健康。客户端中断导致的解析失败不算供应商故障。
      if (!aborted) {
        deps.runtime.markFailure(result.candidate.provider, { kind: 'transient', status: null, message: 'upstream returned invalid json', retryAfterMs: null })
      }
      recordFailure(failureContext, 502, aborted ? 'request' : 'transient', result.candidate.provider.id, result.candidate.upstreamModel, result.tried.slice(0, -1))
      return errorResponse(c, 'openai', 502, 'upstream returned invalid json', null, result.tried)
    }

    if (result.value.protocol === 'anthropic') {
      const anthropicUsage = (data as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
      recordSuccess(
        failureContext,
        anthropicUsage?.input_tokens ?? null,
        anthropicUsage?.output_tokens ?? null,
        result.candidate.provider.id,
        result.candidate.upstreamModel,
        headersAt - started,
        result.tried.slice(0, -1)
      )
      return c.json(anthropicToOpenAIResponse(data, resolution.model), 200, { 'x-tokenhub-provider': result.candidate.provider.id })
    }

    const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    recordSuccess(
      failureContext,
      usage?.prompt_tokens ?? null,
      usage?.completion_tokens ?? null,
      result.candidate.provider.id,
      result.candidate.upstreamModel,
      headersAt - started,
      result.tried.slice(0, -1)
    )

    return c.json(data, 200, { 'x-tokenhub-provider': result.candidate.provider.id })
  })

  app.post('/v1/messages/count_tokens', async (c) => {
    const body = await c.req.json<AnthropicRequest>().catch(() => null)
    if (!body || !Array.isArray(body.messages)) return anthropicError(c, 400, 'messages is required', 'invalid_request_error')
    return c.json({ input_tokens: countTokens(body) })
  })

  app.post('/v1/messages', async (c) => {
    const started = Date.now()
    const requestId = crypto.randomUUID()
    const body = await c.req.json<AnthropicRequest>().catch(() => null)
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      return anthropicError(c, 400, 'model and messages are required', 'invalid_request_error')
    }
    const wantsStream = body.stream === true

    const resolution = resolveCandidates({ requestedModel: body.model, providers: deps.getConfig().providers, catalog: deps.getCatalog(), runtime: deps.runtime })
    const failureContext: FailureContext = { started, requestId, protocol: 'anthropic', model: resolution.model, stream: wantsStream }

    if (!resolution.modelKnown) {
      deps.onUnknownModel?.()
      recordFailure(failureContext, 404, 'model_missing', null, null, [])
      return errorResponse(c, 'anthropic', 404, `unknown model: ${resolution.model}`, null, [], 'not_found_error')
    }
    if (resolution.candidates.length === 0) {
      recordFailure(failureContext, 503, 'unknown', null, null, [])
      // 与 OpenAI 分支一致：冷却期把剩余秒数透给客户端。
      const cooldown = resolution.retryAfterMs
      return errorResponse(c, 'anthropic', 503, 'no available provider for this model',
        cooldown ? { kind: 'unknown', status: 503, message: 'provider cooling down', retryAfterMs: cooldown } : null, [])
    }

    const sessionId = sessionIdOf(c)
    const result = await executeWithFailover(
      resolution.candidates,
      (candidate) => runAttempt(c, candidate, {
        anthropic: body,
        openai: anthropicToOpenAI(body, candidate.upstreamModel)
      }, sessionId, 'anthropic'),
      deps.runtime,
      { onModelMissing: deps.onModelMissing, onQuotaFailure: deps.onQuotaFailure }
    )

    if (!result.ok) {
      const status = (result.failure.status ?? 502) as ContentfulStatusCode
      const last = resolution.candidates.find((candidate) => candidate.provider.id === result.tried.at(-1))
      recordFailure(failureContext, status, result.failure.kind, last?.provider.id ?? null, last?.upstreamModel ?? null, result.tried.slice(0, -1))
      return errorResponse(c, 'anthropic', status, result.failure.message, result.failure, result.tried)
    }

    if (wantsStream) {
      const upstreamBody = result.value.response.body
      if (!upstreamBody) {
        // 与 OpenAI 分支同理：拿到响应头已 markSuccess，此处补记失败让供应商冷却。
        deps.runtime.markFailure(result.candidate.provider, { kind: 'transient', status: null, message: 'upstream returned no body', retryAfterMs: null })
        recordFailure(failureContext, 502, 'transient', result.candidate.provider.id, result.candidate.upstreamModel, result.tried.slice(0, -1))
        return errorResponse(c, 'anthropic', 502, 'upstream returned no body', null, result.tried)
      }
      const headersAt = Date.now()
      // message_start 只能给估算值；上游最终 usage 通过 onUsage 进入历史。
      const estimatedPrompt = countTokens(body)
      let usage = { promptTokens: estimatedPrompt, completionTokens: 0 }
      let streamError: unknown = null
      const onStreamError = (error: unknown): void => {
        streamError = error
        // 首字节后绝不切换供应商；上游截断且客户端未中断时补记一次失败（60s transient 冷却）。
        if (!c.req.raw.signal.aborted) {
          deps.runtime.markFailure(result.candidate.provider, {
            kind: 'transient',
            status: null,
            message: error instanceof Error ? error.message : String(error),
            retryAfterMs: null
          })
        }
      }
      const onStreamDone = (): void => {
        const aborted = c.req.raw.signal.aborted
        const failed = streamError !== null || aborted
        appendHistory(failureContext, {
          httpStatus: 200,
          outcome: failed ? 'error' : 'ok',
          providerId: result.candidate.provider.id,
          upstreamModel: result.candidate.upstreamModel,
          promptTokens: failed ? null : usage.promptTokens,
          completionTokens: failed ? null : usage.completionTokens,
          firstByteMs: headersAt - started,
          errorKind: failed ? (aborted ? 'request' : 'transient') : null,
          failoverFrom: result.tried.slice(0, -1)
        })
      }
      const streamHeaders = {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-tokenhub-provider': result.candidate.provider.id
      }

      if (result.value.protocol === 'anthropic') {
        const tapped = tapAnthropicSSEUsage(upstreamBody, {
          onUsage: (u) => { usage = { promptTokens: u.prompt, completionTokens: u.completion } },
          onError: onStreamError,
          onDone: onStreamDone
        })
        return c.body(tapped, 200, streamHeaders)
      }

      const translated = translateOpenAIStreamToAnthropic(upstreamBody, {
        model: resolution.model,
        inputTokens: estimatedPrompt,
        onUsage: (u) => { usage = u },
        onError: onStreamError,
        onDone: onStreamDone
      })

      return c.body(translated, 200, streamHeaders)
    }

    const headersAt = Date.now()
    const data = await result.value.response.json().catch(() => null)
    if (!data) {
      const aborted = c.req.raw.signal.aborted
      // 与 OpenAI 分支同理：拿到响应头已 markSuccess，200 但 body 不可解析时补记失败让供应商冷却；
      // 客户端中断导致的解析失败不算供应商故障。
      if (!aborted) {
        deps.runtime.markFailure(result.candidate.provider, { kind: 'transient', status: null, message: 'upstream returned invalid json', retryAfterMs: null })
      }
      recordFailure(failureContext, 502, aborted ? 'request' : 'transient', result.candidate.provider.id, result.candidate.upstreamModel, result.tried.slice(0, -1))
      return errorResponse(c, 'anthropic', 502, 'upstream returned invalid json', null, result.tried)
    }

    if (result.value.protocol === 'anthropic') {
      const anthropicUsage = (data as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
      recordSuccess(
        failureContext,
        anthropicUsage?.input_tokens ?? null,
        anthropicUsage?.output_tokens ?? null,
        result.candidate.provider.id,
        result.candidate.upstreamModel,
        headersAt - started,
        result.tried.slice(0, -1)
      )
      return c.json(data, 200, { 'x-tokenhub-provider': result.candidate.provider.id })
    }

    const response = openAIToAnthropicResponse(data, resolution.model)
    const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    recordSuccess(
      failureContext,
      usage?.prompt_tokens ?? null,
      usage?.completion_tokens ?? null,
      result.candidate.provider.id,
      result.candidate.upstreamModel,
      headersAt - started,
      result.tried.slice(0, -1)
    )

    return c.json(response, 200, { 'x-tokenhub-provider': result.candidate.provider.id })
  })

  app.onError((_error, c) => protocolError(c, 500, 'internal server error'))
  app.notFound((c) => protocolError(c, 404, `not found: ${c.req.path}`))

  return app
}
