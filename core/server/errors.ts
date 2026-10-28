import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ErrorKind } from '../types'

export type ErrorProtocol = 'openai' | 'anthropic'

export function isAnthropicPath(path: string): boolean {
  return path.startsWith('/v1/messages')
}

/**
 * Anthropic 客户端还会请求 /v1/models 等非 messages 路径。
 * 除路径外，只要带 anthropic-version 头也按 Anthropic 错误格式响应（401/413/503 等共用）。
 */
export function isAnthropicRequest(c: Context): boolean {
  return isAnthropicPath(c.req.path) || Boolean(c.req.header('anthropic-version'))
}

export function openAIError(c: Context, status: ContentfulStatusCode, message: string, type = 'api_error', code: string | null = null) {
  return c.json({ error: { message, type, code } }, status)
}

export function anthropicError(c: Context, status: ContentfulStatusCode, message: string, type = 'api_error') {
  return c.json({ type: 'error', error: { type, message } }, status)
}

/** 把内部失败分类翻译成 Anthropic 错误 type；未知/网络类统一 api_error。 */
export function anthropicErrorType(kind: ErrorKind | null): string {
  switch (kind) {
    case 'auth': return 'authentication_error'
    case 'rate_limit':
    case 'quota': return 'rate_limit_error'
    case 'model_missing': return 'not_found_error'
    case 'request': return 'invalid_request_error'
    default: return 'api_error'
  }
}

export function errorForProtocol(
  c: Context,
  protocol: ErrorProtocol,
  status: ContentfulStatusCode,
  message: string,
  anthropicType = 'api_error'
) {
  return protocol === 'anthropic'
    ? anthropicError(c, status, message, anthropicType)
    : openAIError(c, status, message)
}

export function protocolError(c: Context, status: ContentfulStatusCode, message: string, anthropicType = 'api_error') {
  return errorForProtocol(c, isAnthropicRequest(c) ? 'anthropic' : 'openai', status, message, anthropicType)
}
