import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseGgufKvInfo, readGgufKvInfo } from '../../core/local/gguf'
import { estimateKvBytes } from '../../core/local/kvEstimate'
import { buildGguf, GEMMA_TEST_META as GEMMA_META } from '../helpers/ggufBuilder'

describe('gguf kv info', () => {
  it('reads trained context and splits per-token KV from the fixed SWA cache', () => {
    const info = parseGgufKvInfo(buildGguf(GEMMA_META))

    expect(info).not.toBeNull()
    expect(info!.trainedContext).toBe(262144)
    // 全注意力层：2(K/V) × 1 头 × (512+512) × 2B = 2048 B/token。
    expect(info!.kvBytesPerToken).toBe(2048)
    // SWA 层：5 × 8 头 × (256+256 维) × 2B × 1024 窗口（K/V 维已合并计算）。
    expect(info!.swaBytes).toBe(5 * 8 * 512 * 2 * 1024)
  })

  it('converts the f16 estimate for quantized KV caches', () => {
    const info = parseGgufKvInfo(buildGguf(GEMMA_META))!
    const f16 = estimateKvBytes(info, 1_048_576, 'f16')!
    const q8 = estimateKvBytes(info, 1_048_576, 'q8_0')!
    const q4 = estimateKvBytes(info, 1_048_576, 'q4_0')!

    expect(f16).toBe(2048 * 1_048_576 + info.swaBytes!)
    expect(q8).toBe(Math.ceil(f16 * (34 / 64)))
    expect(q4).toBe(Math.ceil(f16 * (18 / 64)))
    expect(q8).toBeLessThan(f16)
    expect(q4).toBeLessThan(q8)
  })

  it('handles models without sliding-window metadata', () => {
    const info = parseGgufKvInfo(
      buildGguf({
        'general.architecture': 'qwen3',
        'qwen3.context_length': 32768,
        'qwen3.block_count': 4,
        'qwen3.attention.head_count_kv': 8,
        'qwen3.attention.key_length': 128,
        'qwen3.attention.value_length': 128
      })
    )!

    expect(info.trainedContext).toBe(32768)
    expect(info.kvBytesPerToken).toBe(4 * 8 * 256 * 2)
    expect(info.swaBytes).toBe(0)
  })

  it('skips tokenizer arrays without losing later metadata', () => {
    const tokens = Array.from({ length: 5000 }, (_, index) => `t${index}`)
    const info = parseGgufKvInfo(buildGguf({ 'tokenizer.ggml.tokens': tokens, ...GEMMA_META }))

    expect(info?.trainedContext).toBe(262144)
  })

  it('returns null for non-gguf and truncated headers', () => {
    expect(parseGgufKvInfo(Buffer.from('not a gguf file'))).toBeNull()
    expect(parseGgufKvInfo(buildGguf(GEMMA_META).subarray(0, 24))).toBeNull()
  })

  it('reads from disk and degrades to null when the file is unreadable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-gguf-'))
    const valid = join(dir, 'valid.gguf')
    await writeFile(valid, buildGguf(GEMMA_META))

    expect((await readGgufKvInfo(valid))?.trainedContext).toBe(262144)
    expect(await readGgufKvInfo(join(dir, 'missing.gguf'))).toBeNull()
  })
})