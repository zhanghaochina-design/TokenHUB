import type { UpstreamFailure } from './types'

const QUOTA_RE = /quota|insufficient|balance|billing|payment|额度|余额|欠费|上限/i

export function parseRetryAfter(raw: string | null, now: number = Date.now()): number | null {
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(raw)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

function messageOf(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string }
    if (typeof parsed.error === 'string') return parsed.error
    return parsed.error?.message ?? parsed.message ?? bodyText.slice(0, 500)
  } catch {
    return bodyText.slice(0, 500)
  }
}

export function classifyUpstreamResponse(status: number, bodyText: string, headers: Headers): UpstreamFailure {
  const message = messageOf(bodyText)
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'))
  if (status === 402) return { kind: 'quota', status, message, retryAfterMs }
  if (status === 429) return { kind: QUOTA_RE.test(bodyText) ? 'quota' : 'rate_limit', status, message, retryAfterMs }
  if (status === 401) return { kind: 'auth', status, message, retryAfterMs }
  if (status === 403) return { kind: QUOTA_RE.test(bodyText) ? 'quota' : 'auth', status, message, retryAfterMs }
  if (status === 404) return { kind: 'model_missing', status, message, retryAfterMs }
  if (status === 400 || status === 422) return { kind: 'request', status, message, retryAfterMs }
  if (status >= 500) return { kind: 'transient', status, message, retryAfterMs }
  return { kind: 'unknown', status, message, retryAfterMs }
}
