import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { groupGgufFiles, isSafeRelativePath, modelIdFromName, quantFromFileName, scanModels, splitInfo } from '../../core/local/library'

describe('gguf library', () => {
  it('parses split names and quant labels', () => {
    expect(splitInfo('Model-Q4_K_M-00002-of-00003.gguf')).toEqual({ base: 'Model-Q4_K_M', part: 2, total: 3 })
    expect(splitInfo('Model-Q4_K_M.gguf')).toBeNull()
    expect(quantFromFileName('Qwen3-32B-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(quantFromFileName('deepseek-v3-IQ2_XXS.gguf')).toBe('IQ2_XXS')
    expect(quantFromFileName('plain.gguf')).toBeNull()
  })

  it('groups complete split sets and ignores incomplete or adapter files', () => {
    const models = groupGgufFiles([
      { relative: 'Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M-00001-of-00002.gguf', size: 100 },
      { relative: 'Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M-00002-of-00002.gguf', size: 120 },
      { relative: 'Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q8_0-00001-of-00002.gguf', size: 100 },
      { relative: 'Qwen/Qwen3-8B-GGUF/mmproj-F16.gguf', size: 50 },
      { relative: 'Plain/F16.gguf', size: 10 }
    ])
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      id: 'Qwen3-8B-Q4_K_M',
      sizeBytes: 220,
      parts: 2,
      repo: 'Qwen/Qwen3-8B-GGUF',
      quant: 'Q4_K_M'
    })
    expect(models[1]).toMatchObject({ id: 'F16', repo: 'Plain', parts: 1 })
  })

  it('rejects unsafe relative paths', () => {
    expect(isSafeRelativePath('org/repo/model.gguf')).toBe(true)
    expect(isSafeRelativePath('../evil.gguf')).toBe(false)
    expect(isSafeRelativePath('C:/evil.gguf')).toBe(false)
    expect(isSafeRelativePath('org/../model.gguf')).toBe(false)
  })

  it('scans a real directory and de-duplicates ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-models-'))
    await mkdir(join(dir, 'a'), { recursive: true })
    await mkdir(join(dir, 'b'), { recursive: true })
    await writeFile(join(dir, 'a', 'Same-Q4_K_M.gguf'), 'x')
    await writeFile(join(dir, 'b', 'Same-Q4_K_M.gguf'), 'y')
    const models = await scanModels(dir)
    expect(models.map((model) => model.id)).toEqual(['Same-Q4_K_M', 'Same-Q4_K_M@b'])
    expect(models[0].path.endsWith('Same-Q4_K_M.gguf')).toBe(true)
  })

  it('ignores unfinished downloads and split parts outside the declared range', () => {
    const models = groupGgufFiles([
      { relative: 'org/repo/Half-Q4_K_M.gguf.part', size: 5 },
      { relative: 'org/repo/notes.txt', size: 5 },
      { relative: 'org/repo/Weird-Q4_K_M-00004-of-00003.gguf', size: 5 },
      { relative: 'org/repo/Weird-Q4_K_M-00001-of-00003.gguf', size: 5 },
      { relative: 'org/repo/Weird-Q4_K_M-00002-of-00003.gguf', size: 5 },
      { relative: 'org/repo/Weird-Q4_K_M-00003-of-00003.gguf', size: 5 }
    ])
    expect(models).toEqual([])
  })

  it('anchors a split model on part one and keeps further id collisions distinct', () => {
    const parts = [
      { relative: 'org/repo/Big-Q4_K_M-00002-of-00003.gguf', size: 20 },
      { relative: 'org/repo/Big-Q4_K_M-00001-of-00003.gguf', size: 10 },
      { relative: 'org/repo/Big-Q4_K_M-00003-of-00003.gguf', size: 30 },
      { relative: 'org/repo/a/Same-Q8_0.gguf', size: 1 },
      { relative: 'org/repo/b/Same-Q8_0.gguf', size: 1 }
    ]
    const models = groupGgufFiles(parts)
    expect(models[0]).toMatchObject({ id: 'Big-Q4_K_M', parts: 3, sizeBytes: 60, path: 'org/repo/Big-Q4_K_M-00001-of-00003.gguf' })
    // 两个同名、同 repo 前缀的模型两条都要能同时被选中，ID 不能重复。
    const ids = models.map((model) => model.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('Same-Q8_0')
    expect(ids).toContain('Same-Q8_0@org-repo')
  })

  it('derives ids from unsafe file names', () => {
    expect(modelIdFromName('Qwen 3 (8B) Q4_K_M.gguf')).toBe('Qwen-3-8B-Q4_K_M')
    expect(modelIdFromName('...gguf')).toBe('local-model')
  })

  it('scans three directory levels and tolerates a missing directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-depth-'))
    await mkdir(join(dir, 'a', 'b', 'c'), { recursive: true })
    await mkdir(join(dir, 'a', 'b', 'c', 'd'), { recursive: true })
    await writeFile(join(dir, 'a', 'b', 'c', 'Deep-Q4_K_M.gguf'), 'x')
    await writeFile(join(dir, 'a', 'b', 'c', 'd', 'TooDeep-Q4_K_M.gguf'), 'x')
    const models = await scanModels(dir)
    expect(models.map((model) => model.id)).toEqual(['Deep-Q4_K_M'])
    expect(await scanModels(join(dir, 'missing'))).toEqual([])
  })
})