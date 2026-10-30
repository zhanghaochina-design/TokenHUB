import { anthropicBaseUrlFor, upstreamExtraHeaders } from './presets'
import type { ProtocolScanRow, ProviderConfig } from '../types'

export interface ScanOptions {
  provider: ProviderConfig
  apiKey: string
  models: string[]
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>
  onProgress?(done: number, total: number): void
  concurrency?: number
  now?: () => Date
}

export interface ScanOutcome {
  rows: ProtocolScanRow[]
  error?: string
}

type EndpointState = { value: boolean | null; status: number | null; note?: string }

const PROBE_TIMEOUT_MS = 30_000
const PROBE_MAX_TOKENS = 16
const DEFAULT_CONCURRENCY = 2
const UNSUPPORTED_STATUSES = new Set([400, 404, 405, 422])

function clip(text: string, max = 180): string {
  return text.replace(/\s+/g, ' ').slice(0, max)
}

function errorMessageOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    if (typeof parsed.error === 'string') return parsed.error
    return parsed.error?.message ?? parsed.message ?? text
  } catch {
    return text
  }
}

async function probe(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>
): Promise<EndpointState> {
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    const text = await res.text().catch(() => '')
    if (res.ok) return { value: true, status: res.status }
    const note = clip(errorMessageOf(text))
    // 400/404/405/422 是明确的端点/模型不匹配；其余状态可能是瞬时故障，不能写成 false。
    if (UNSUPPORTED_STATUSES.has(res.status)) return { value: false, status: res.status, note }
    return { value: null, status: res.status, note }
  } catch (error) {
    return { value: null, status: null, note: clip(error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * 对每个模型分别探测 Anthropic `/messages` 与 OpenAI `/chat/completions`。
 * 扫描是诊断请求：不写历史、不计供应商故障；只有同一模型两端都 401（Key 无效）才提前停止，
 * 403/402 只记录当前模型，避免地区限制或单模型额度问题中断整轮扫描。
 */
export async function scanProviderProtocols(options: ScanOptions): Promise<ScanOutcome> {
  const models = [...new Set(options.models.map((model) => model.trim()).filter(Boolean))]
  if (models.length === 0) return { rows: [] }

  const fetchFn = options.fetchFn ?? fetch
  const now = options.now ?? (() => new Date())
  const openaiBase = options.provider.baseUrl.replace(/\/+$/, '')
  const anthropicBase = anthropicBaseUrlFor(options.provider)
  const extra = upstreamExtraHeaders(options.provider, crypto.randomUUID())
  const anthropicHeaders = {
    'x-api-key': options.apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    accept: 'application/json',
    ...extra
  }
  const openaiHeaders = {
    Authorization: `Bearer ${options.apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
    ...extra
  }

  const rows: ProtocolScanRow[] = []
  const queue = [...models]
  const total = models.length
  let done = 0
  let stopReason: string | null = null

  const worker = async (): Promise<void> => {
    while (queue.length > 0 && stopReason === null) {
      const model = queue.shift()!
      const body = { model, max_tokens: PROBE_MAX_TOKENS, messages: [{ role: 'user', content: 'Reply with OK.' }] }
      const anthropic = await probe(`${anthropicBase}/messages`, anthropicHeaders, body, fetchFn)
      const openai = await probe(`${openaiBase}/chat/completions`, openaiHeaders, body, fetchFn)

      const keyRejected = (state: EndpointState): boolean => state.status === 401
      if (keyRejected(anthropic) && keyRejected(openai)) {
        stopReason = `认证失败（${model}），扫描已停止`
      }

      const notes = [anthropic.note ? `messages: ${anthropic.note}` : '', openai.note ? `chat: ${openai.note}` : '']
        .filter(Boolean)
        .join('; ')
      rows.push({
        model,
        anthropic: anthropic.value,
        openai: openai.value,
        checkedAt: now().toISOString(),
        note: notes || undefined
      })
      done += 1
      options.onProgress?.(done, total)
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY), models.length) },
    () => worker()
  )
  await Promise.all(workers)
  rows.sort((a, b) => a.model.localeCompare(b.model))
  return { rows, error: stopReason ?? undefined }
}
