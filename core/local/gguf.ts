import { open } from 'node:fs/promises'
import type { ModelKvInfo } from './types'

// GGUF 元数据在张量数据之前，16 MiB 足够覆盖常见 tokenizer 词表；超出部分不读。
const HEADER_READ_BYTES = 16 * 1024 * 1024
const MAX_STRING_BYTES = 4 * 1024 * 1024
// 只保留小数组（逐层头数、SWA 模式）；超大数组（词表）直接跳过。
const MAX_STORED_ARRAY = 4096
const F16_BYTES = 2

const GGUF_UINT8 = 0
const GGUF_INT8 = 1
const GGUF_UINT16 = 2
const GGUF_INT16 = 3
const GGUF_UINT32 = 4
const GGUF_INT32 = 5
const GGUF_FLOAT32 = 6
const GGUF_BOOL = 7
const GGUF_STRING = 8
const GGUF_ARRAY = 9
const GGUF_UINT64 = 10
const GGUF_INT64 = 11
const GGUF_FLOAT64 = 12

class TruncatedError extends Error {}

class Reader {
  private offset = 0

  constructor(private readonly buf: Buffer) {}

  private need(bytes: number): void {
    if (bytes < 0 || this.offset + bytes > this.buf.length) throw new TruncatedError('gguf metadata truncated')
  }

  u32(): number {
    this.need(4)
    const value = this.buf.readUInt32LE(this.offset)
    this.offset += 4
    return value
  }

  u64(): number {
    this.need(8)
    const value = Number(this.buf.readBigUInt64LE(this.offset))
    this.offset += 8
    // 文件长度不可能超过安全整数；超出说明头部损坏，按解析失败处理。
    if (!Number.isSafeInteger(value)) throw new TruncatedError('gguf offset overflow')
    return value
  }

  string(): string {
    const length = this.u64()
    if (length > MAX_STRING_BYTES) throw new TruncatedError('gguf string too large')
    this.need(length)
    const value = this.buf.toString('utf8', this.offset, this.offset + length)
    this.offset += length
    return value
  }

  skip(type: number): void {
    switch (type) {
      case GGUF_UINT8:
      case GGUF_INT8:
      case GGUF_BOOL:
        this.need(1)
        this.offset += 1
        return
      case GGUF_UINT16:
      case GGUF_INT16:
        this.need(2)
        this.offset += 2
        return
      case GGUF_UINT32:
      case GGUF_INT32:
      case GGUF_FLOAT32:
        this.need(4)
        this.offset += 4
        return
      case GGUF_UINT64:
      case GGUF_INT64:
      case GGUF_FLOAT64:
        this.need(8)
        this.offset += 8
        return
      case GGUF_STRING:
        this.string()
        return
      case GGUF_ARRAY: {
        const elementType = this.u32()
        const count = this.u64()
        // 每个元素至少 1 字节，计数超过剩余长度必然损坏，提前拒绝避免长时间空转。
        this.need(count)
        for (let index = 0; index < count; index += 1) this.skip(elementType)
        return
      }
      default:
        throw new TruncatedError(`unknown gguf value type ${type}`)
    }
  }

  value(type: number): unknown {
    switch (type) {
      case GGUF_UINT8:
        this.need(1)
        return this.buf.readUInt8(this.offset++)
      case GGUF_INT8: {
        this.need(1)
        const value = this.buf.readInt8(this.offset)
        this.offset += 1
        return value
      }
      case GGUF_UINT16:
        this.need(2)
        const u16 = this.buf.readUInt16LE(this.offset)
        this.offset += 2
        return u16
      case GGUF_INT16:
        this.need(2)
        const i16 = this.buf.readInt16LE(this.offset)
        this.offset += 2
        return i16
      case GGUF_UINT32:
        return this.u32()
      case GGUF_INT32:
        this.need(4)
        const i32 = this.buf.readInt32LE(this.offset)
        this.offset += 4
        return i32
      case GGUF_FLOAT32:
        this.need(4)
        const f32 = this.buf.readFloatLE(this.offset)
        this.offset += 4
        return f32
      case GGUF_BOOL:
        this.need(1)
        return this.buf.readUInt8(this.offset++) !== 0
      case GGUF_STRING:
        return this.string()
      case GGUF_UINT64:
        return this.u64()
      case GGUF_INT64:
        this.need(8)
        const i64 = Number(this.buf.readBigInt64LE(this.offset))
        this.offset += 8
        return i64
      case GGUF_FLOAT64:
        this.need(8)
        const f64 = this.buf.readDoubleLE(this.offset)
        this.offset += 8
        return f64
      case GGUF_ARRAY: {
        const elementType = this.u32()
        const count = this.u64()
        this.need(count)
        if (count > MAX_STORED_ARRAY) {
          for (let index = 0; index < count; index += 1) this.skip(elementType)
          return null
        }
        const values: unknown[] = []
        for (let index = 0; index < count; index += 1) values.push(this.value(elementType))
        return values
      }
      default:
        throw new TruncatedError(`unknown gguf value type ${type}`)
    }
  }
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const numbers = value.map(positiveInt)
  return numbers.every((item): item is number => item !== null) ? numbers : null
}

/**
 * 从 GGUF 头计算 KV 成本摘要。只读元数据，不加载权重；任何越界/未知类型都按失败处理。
 * 返回的训练上下文用于判断是否需要 YaRN；KV 估算只覆盖 f16，量化按比例换算。
 */
export function parseGgufKvInfo(buf: Buffer): ModelKvInfo | null {
  try {
    if (buf.length < 4 || buf.toString('utf8', 0, 4) !== 'GGUF') return null
    const reader = new Reader(buf)
    reader.u32() // magic 已校验
    const version = reader.u32()
    // v1 的字段宽度与 v2+ 不同，不参与本地 GGUF 解析。
    if (version < 2) return null
    reader.u64() // tensor_count
    const kvCount = reader.u64()
    if (kvCount > 1_000_000) return null
    const meta = new Map<string, unknown>()
    for (let index = 0; index < kvCount; index += 1) {
      const key = reader.string()
      const type = reader.u32()
      // 词表/合并表既大又无用：跳过值，只保留架构与注意力相关的标量/小数组。
      if (key.includes('tokenizer')) {
        reader.skip(type)
        continue
      }
      meta.set(key, reader.value(type))
    }
    return kvInfoFromMeta(meta)
  } catch {
    return null
  }
}

function kvInfoFromMeta(meta: Map<string, unknown>): ModelKvInfo | null {
  const architecture = meta.get('general.architecture')
  if (typeof architecture !== 'string' || !architecture) return null
  const key = (name: string): unknown => meta.get(`${architecture}.${name}`)
  const trainedContext = positiveInt(key('context_length'))
  const layers = positiveInt(key('block_count'))
  const headCount = positiveInt(key('attention.head_count'))
  const embeddingLength = positiveInt(key('embedding_length'))

  const headCountKvRaw = key('attention.head_count_kv')
  const scalarKvHeads = positiveInt(headCountKvRaw)
  // 没有 head_count_kv 时退化为 query 头数（老式 MHA），只影响估算上限，不影响 YaRN。
  const headCounts = numberArray(headCountKvRaw) ?? (scalarKvHeads !== null ? [scalarKvHeads] : headCount !== null ? [headCount] : null)
  const keyLength = positiveInt(key('attention.key_length')) ?? (embeddingLength && headCount ? Math.floor(embeddingLength / headCount) : null)
  const valueLength = positiveInt(key('attention.value_length')) ?? keyLength
  const swaKeyLength = positiveInt(key('attention.key_length_swa')) ?? keyLength
  const swaValueLength = positiveInt(key('attention.value_length_swa')) ?? valueLength
  const swaWindow = positiveInt(key('attention.sliding_window'))
  const swaPatternRaw = key('attention.sliding_window_pattern')
  const swaPattern = Array.isArray(swaPatternRaw) ? swaPatternRaw.map((item) => item === true) : []

  // 训练长度与 KV 估算互不依赖：拿不到结构时仍要返回训练长度，YaRN 判断才能生效。
  if (!layers || !headCounts || headCounts.length === 0) {
    return { trainedContext, kvBytesPerToken: null, swaBytes: null }
  }

  let bytesPerToken = 0
  let swaBytes = 0
  for (let layer = 0; layer < layers; layer += 1) {
    // 逐层数组优先；只有一个值时对所有层生效。
    const kvHeads = headCounts.length === 1 ? headCounts[0] : headCounts[layer]
    if (!kvHeads) return { trainedContext, kvBytesPerToken: null, swaBytes: null }
    const isSwa = swaWindow !== null && swaPattern[layer] === true
    const kLength = isSwa ? swaKeyLength : keyLength
    const vLength = isSwa ? swaValueLength : valueLength
    if (!kLength || !vLength) return { trainedContext, kvBytesPerToken: null, swaBytes: null }
    const layerBytes = F16_BYTES * kvHeads * (kLength + vLength)
    if (isSwa) swaBytes += layerBytes * Math.min(swaWindow!, trainedContext ?? swaWindow!)
    else bytesPerToken += layerBytes
  }

  return { trainedContext, kvBytesPerToken: bytesPerToken, swaBytes }
}

/** 读取模型文件头部；读取失败或不是合法 GGUF 时返回 null，扫描流程照常继续。 */
export async function readGgufKvInfo(path: string): Promise<ModelKvInfo | null> {
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(HEADER_READ_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return parseGgufKvInfo(buffer.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}