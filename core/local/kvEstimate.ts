import type { KvCacheType, ModelKvInfo } from './types'

// 相对 f16 的每元素字节比：q8_0 = 34B/32 元素，q4_0 = 18B/32 元素。
const KV_QUANT_RATIO: Record<KvCacheType, number> = {
  f16: 1,
  q8_0: 34 / 64,
  q4_0: 18 / 64
}

/** KV 缓存字节数（不含权重与计算缓冲）。f16 直接取摘要，量化按每元素字节比换算。 */
export function estimateKvBytes(info: ModelKvInfo | undefined, tokens: number, type: KvCacheType): number | null {
  if (!info || info.kvBytesPerToken === null || !Number.isFinite(tokens) || tokens <= 0) return null
  const ratio = KV_QUANT_RATIO[type]
  return Math.ceil((info.kvBytesPerToken * tokens + (info.swaBytes ?? 0)) * ratio)
}