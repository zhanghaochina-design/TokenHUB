import { describe, expect, it } from 'vitest'
import type { HfModelFile } from '../../core/local/types'
import { findIncompleteSplit } from '../../src/lib/hfSelection'

// 分片文件按 HF 约定命名：<base>-0000N-of-0000M.gguf，基名 = 去掉分片后缀的路径。
function part(path: string, index: number, total: number): HfModelFile {
  return { path, sizeBytes: 1024, quant: 'Q4_K_M', split: { part: index, total }, isAdapter: false }
}

function single(path: string): HfModelFile {
  return { path, sizeBytes: 1024, quant: 'Q4_K_M', split: null, isAdapter: false }
}

describe('findIncompleteSplit', () => {
  it('完整选中 2 分片组时返回 null', () => {
    const files = [
      part('qwen/model-Q4_K_M-00001-of-00002.gguf', 1, 2),
      part('qwen/model-Q4_K_M-00002-of-00002.gguf', 2, 2),
      single('qwen/mmproj.gguf')
    ]
    expect(
      findIncompleteSplit(files, [
        'qwen/model-Q4_K_M-00001-of-00002.gguf',
        'qwen/model-Q4_K_M-00002-of-00002.gguf'
      ])
    ).toBeNull()
  })

  it('单个非分片文件返回 null', () => {
    expect(findIncompleteSplit([single('qwen/model-Q4_K_M.gguf')], ['qwen/model-Q4_K_M.gguf'])).toBeNull()
  })

  it('3 分片只选 2 个时报告该组基名与缺口', () => {
    const files = [
      part('qwen/model-Q4_K_M-00001-of-00003.gguf', 1, 3),
      part('qwen/model-Q4_K_M-00002-of-00003.gguf', 2, 3),
      part('qwen/model-Q4_K_M-00003-of-00003.gguf', 3, 3)
    ]
    expect(
      findIncompleteSplit(files, ['qwen/model-Q4_K_M-00001-of-00003.gguf', 'qwen/model-Q4_K_M-00002-of-00003.gguf'])
    ).toEqual({ base: 'qwen/model-Q4_K_M', total: 3, chosen: 2 })
  })

  it('一组选全、另一组缺片时只报缺片的那组', () => {
    const files = [
      part('qwen/a-00001-of-00002.gguf', 1, 2),
      part('qwen/a-00002-of-00002.gguf', 2, 2),
      part('qwen/b-00001-of-00003.gguf', 1, 3),
      part('qwen/b-00002-of-00003.gguf', 2, 3),
      part('qwen/b-00003-of-00003.gguf', 3, 3)
    ]
    expect(
      findIncompleteSplit(files, [
        'qwen/a-00001-of-00002.gguf',
        'qwen/a-00002-of-00002.gguf',
        'qwen/b-00001-of-00003.gguf'
      ])
    ).toEqual({ base: 'qwen/b', total: 3, chosen: 1 })
  })

  it('完全未选中的分片组不算缺口', () => {
    const files = [part('qwen/a-00001-of-00002.gguf', 1, 2), part('qwen/a-00002-of-00002.gguf', 2, 2)]
    expect(findIncompleteSplit(files, [])).toBeNull()
  })

  it('文件名不符合分片约定时无法判断整组，按无缺口处理', () => {
    const odd: HfModelFile = { path: 'qwen/weird.gguf', sizeBytes: 1, quant: null, split: { part: 1, total: 2 }, isAdapter: false }
    expect(findIncompleteSplit([odd], ['qwen/weird.gguf'])).toBeNull()
  })
})