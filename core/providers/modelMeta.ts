import type { EffectiveModelMeta, ModelMeta, ModelThinkingMeta, ProviderConfig } from '../types'

// 内置建议值的采集时间；供应商随时可能调整，界面上必须标明“建议值、可覆盖”。
export const MODEL_META_AS_OF = '2026-11'

const NO_THINKING: ModelThinkingMeta = { param: 'none', values: [] }

interface BuiltinEntry {
  match: RegExp
  meta: ModelMeta
}

// 只覆盖常见系列，且按“最长前缀”排在前面；未命中的模型保持未标注，由用户补录。
const BUILTIN_MODEL_META: BuiltinEntry[] = [
  {
    // Claude 5 系列与 4.7/4.8、Sonnet 4.6 改为 1M 上下文 + effort 档位（adaptive thinking）。
    match: /^claude-(opus-5|sonnet-5|haiku-5|fable)/,
    meta: {
      contextLength: 1_000_000,
      vision: true,
      thinking: { param: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }
    }
  },
  {
    match: /^claude-(opus-4-(7|8)|sonnet-4-6)/,
    meta: {
      contextLength: 1_000_000,
      vision: true,
      thinking: { param: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }
    }
  },
  {
    match: /^claude-haiku-4-5/,
    meta: {
      contextLength: 200_000,
      vision: true,
      thinking: { param: 'thinking.budget_tokens', values: ['1024', '2048', '4096', '8192', '16000', '32000'] }
    }
  },
  {
    match: /^claude-/,
    meta: {
      contextLength: 200_000,
      vision: true,
      thinking: { param: 'thinking.budget_tokens', values: ['1024', '2048', '4096', '8192', '16000', '32000'] }
    }
  },
  {
    // 上游目录标注为视觉可用；思考档位沿用其 effort 数组。
    match: /^deepseek-v4\.1-flash/,
    meta: {
      contextLength: 1_000_000,
      vision: true,
      thinking: { param: 'effort', values: ['low', 'high', 'max'] }
    }
  },
  {
    match: /^deepseek-v4-pro/,
    meta: {
      contextLength: 1_000_000,
      vision: false,
      thinking: { param: 'effort', values: ['high', 'max'] }
    }
  },
  {
    match: /^deepseek-reasoner/,
    meta: { contextLength: 128_000, vision: false, thinking: { param: 'builtin', values: [] } }
  },
  {
    match: /^deepseek-/,
    meta: { contextLength: 128_000, vision: false, thinking: NO_THINKING }
  },
  {
    match: /^o[134](?:-|$)/,
    meta: {
      contextLength: 200_000,
      vision: true,
      thinking: { param: 'reasoning_effort', values: ['low', 'medium', 'high'] }
    }
  },
  {
    match: /^gpt-5/,
    meta: {
      contextLength: 400_000,
      vision: true,
      thinking: { param: 'reasoning_effort', values: ['minimal', 'low', 'medium', 'high'] }
    }
  },
  {
    match: /^gpt-4\.1/,
    meta: { contextLength: 1_047_576, vision: true, thinking: NO_THINKING }
  },
  {
    match: /^gpt-4o/,
    meta: { contextLength: 128_000, vision: true, thinking: NO_THINKING }
  },
  {
    match: /^gemini-2\.5/,
    meta: {
      contextLength: 1_048_576,
      vision: true,
      thinking: { param: 'thinking_budget', values: ['0', '1024', '8192', '24576', '-1'] }
    }
  },
  {
    match: /^gemini-/,
    meta: { contextLength: 1_048_576, vision: true }
  },
  {
    match: /^qwen3-vl/,
    meta: { contextLength: 131_072, vision: true, thinking: { param: 'enable_thinking', values: ['true', 'false'] } }
  },
  {
    match: /^qwen3(?:-|$)/,
    meta: {
      contextLength: 131_072,
      vision: false,
      thinking: { param: 'enable_thinking', values: ['true', 'false'] }
    }
  },
  {
    match: /^kimi-k2/,
    meta: { contextLength: 262_144, vision: false }
  },
  {
    match: /^glm-4\.[56]v/,
    meta: { contextLength: 200_000, vision: true, thinking: { param: 'thinking.type', values: ['enabled', 'disabled'] } }
  },
  {
    match: /^glm-4\.[56]/,
    meta: { contextLength: 200_000, vision: false, thinking: { param: 'thinking.type', values: ['enabled', 'disabled'] } }
  },
  {
    match: /^grok-4/,
    meta: { contextLength: 256_000, vision: true, thinking: NO_THINKING }
  }
]

// 部分供应商返回 "anthropic/claude-…" 或 "models/gemini-…"：按最后一段匹配，避免前缀干扰。
function modelBasename(model: string): string {
  const name = model.trim().toLowerCase()
  return name.slice(name.lastIndexOf('/') + 1)
}

export function builtinModelMeta(model: string): ModelMeta | null {
  const name = modelBasename(model)
  const entry = BUILTIN_MODEL_META.find((candidate) => candidate.match.test(name))
  return entry ? { ...entry.meta } : null
}

function pickField<T>(manual: T | undefined, discovered: T | undefined, builtin: T | undefined, fallback: T): T {
  if (manual !== undefined) return manual
  if (discovered !== undefined) return discovered
  return builtin !== undefined ? builtin : fallback
}

/** 生效值：手动覆盖 > 上游发现 > 内置建议；都没有时视为未知。 */
export function effectiveModelMeta(
  provider: Pick<ProviderConfig, 'modelMeta' | 'modelDiscovery'>,
  model: string
): EffectiveModelMeta {
  const manual = provider.modelMeta?.[model]
  const discovered = provider.modelDiscovery?.[model]
  const builtin = builtinModelMeta(model)
  return {
    contextLength: pickField(manual?.contextLength, discovered?.contextLength, builtin?.contextLength, null),
    vision: pickField(manual?.vision, discovered?.vision, builtin?.vision, null),
    thinking: pickField(manual?.thinking, discovered?.thinking, builtin?.thinking, null)
  }
}

/**
 * 统一模型的能力聚合：上下文取最小值（最保守），视觉任一支持即支持，
 * 思考只在参数名一致时取交集；参数名不同则不聚合，避免把两套语汇混成一个。
 */
export function aggregateModelMeta(entries: EffectiveModelMeta[]): EffectiveModelMeta {
  let contextLength: number | null = null
  for (const entry of entries) {
    if (entry.contextLength === null) continue
    contextLength = contextLength === null ? entry.contextLength : Math.min(contextLength, entry.contextLength)
  }

  let vision: boolean | null = null
  if (entries.some((entry) => entry.vision === true)) vision = true
  else if (entries.length > 0 && entries.every((entry) => entry.vision === false)) vision = false

  const specs = entries.map((entry) => entry.thinking).filter((spec): spec is ModelThinkingMeta => spec !== null)
  let thinking: ModelThinkingMeta | null = null
  if (specs.length > 0) {
    const param = specs[0].param
    if (specs.every((spec) => spec.param === param)) {
      thinking = param === 'none'
        ? { param, values: [] }
        : { param, values: specs[0].values.filter((value) => specs.every((spec) => spec.values.includes(value))) }
    }
  }

  return { contextLength, vision, thinking }
}

function normalizeThinking(raw: unknown): ModelThinkingMeta | null | undefined {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const param = typeof value.param === 'string' ? value.param.trim() : ''
  if (!param) return undefined
  if (param === 'none') return NO_THINKING
  const values = Array.isArray(value.values)
    ? [...new Set(value.values.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))]
    : []
  return { param, values }
}

/** 配置与 IPC 共用的归一化；没有任何有效字段时返回 null，避免把空对象写进 config.json。 */
export function normalizeModelMeta(raw: unknown): ModelMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const meta: ModelMeta = {}
  if (value.contextLength === null) meta.contextLength = null
  else if (typeof value.contextLength === 'number' && Number.isFinite(value.contextLength) && value.contextLength > 0) {
    meta.contextLength = Math.floor(value.contextLength)
  }
  if (typeof value.vision === 'boolean' || value.vision === null) meta.vision = value.vision
  const thinking = normalizeThinking(value.thinking)
  if (thinking !== undefined) meta.thinking = thinking
  return Object.keys(meta).length > 0 ? meta : null
}