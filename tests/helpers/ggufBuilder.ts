// 生成最小合法 GGUF 头（无张量、无张量数据），用于单测解析训练上下文与 KV 结构。
export type GgufTestValue = string | number | boolean | string[] | number[] | boolean[]

const TYPE_UINT32 = 4
const TYPE_BOOL = 7
const TYPE_STRING = 8
const TYPE_ARRAY = 9

function ggufString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(bytes.length))
  return Buffer.concat([length, bytes])
}

function arrayElementType(value: string[] | number[] | boolean[]): number {
  if (typeof value[0] === 'string') return TYPE_STRING
  if (typeof value[0] === 'boolean') return TYPE_BOOL
  return TYPE_UINT32
}

function typedValue(item: GgufTestValue): Buffer {
  if (typeof item === 'string') {
    const type = Buffer.alloc(4)
    type.writeUInt32LE(TYPE_STRING)
    return Buffer.concat([type, ggufString(item)])
  }
  if (typeof item === 'boolean') {
    const type = Buffer.alloc(4)
    type.writeUInt32LE(TYPE_BOOL)
    return Buffer.concat([type, Buffer.from([item ? 1 : 0])])
  }
  if (typeof item === 'number') {
    const type = Buffer.alloc(4)
    type.writeUInt32LE(TYPE_UINT32)
    const number = Buffer.alloc(4)
    number.writeUInt32LE(item)
    return Buffer.concat([type, number])
  }
  const elementType = arrayElementType(item)
  const header = Buffer.alloc(16)
  header.writeUInt32LE(TYPE_ARRAY, 0)
  header.writeUInt32LE(elementType, 4)
  header.writeBigUInt64LE(BigInt(item.length), 8)
  const body = item.map((entry) => {
    if (typeof entry === 'string') return ggufString(entry)
    if (typeof entry === 'boolean') return Buffer.from([entry ? 1 : 0])
    const number = Buffer.alloc(4)
    number.writeUInt32LE(entry)
    return number
  })
  return Buffer.concat([header, ...body])
}

export function buildGguf(meta: Record<string, GgufTestValue>): Buffer {
  const magic = Buffer.from('GGUF', 'utf8')
  const version = Buffer.alloc(4)
  version.writeUInt32LE(3)
  const counts = Buffer.alloc(16)
  counts.writeBigUInt64LE(0n, 0) // tensor_count
  counts.writeBigUInt64LE(BigInt(Object.keys(meta).length), 8)
  const entries = Object.entries(meta).flatMap(([key, item]) => [ggufString(key), typedValue(item)])
  return Buffer.concat([magic, version, counts, ...entries])
}

// Gemma 4 形态：训练 256K、6 层（5 层 SWA + 1 层全注意力）；用于解析与 YaRN 用例。
export const GEMMA_TEST_META: Record<string, GgufTestValue> = {
  'general.architecture': 'gemma4',
  'gemma4.context_length': 262144,
  'gemma4.block_count': 6,
  'gemma4.attention.head_count': 16,
  'gemma4.attention.head_count_kv': [8, 8, 8, 8, 8, 1],
  'gemma4.attention.key_length': 512,
  'gemma4.attention.value_length': 512,
  'gemma4.attention.sliding_window': 1024,
  'gemma4.attention.sliding_window_pattern': [true, true, true, true, true, false],
  'gemma4.attention.key_length_swa': 256,
  'gemma4.attention.value_length_swa': 256
}