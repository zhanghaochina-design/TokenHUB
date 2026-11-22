import type { HfModelFile } from '../../core/local/types'

// 分片命名：<base>-00001-of-00003.gguf。去掉后缀即同批分片的基名（保留目录前缀，与列表路径一致）。
const SPLIT_SUFFIX = /-\d{5}-of-\d{5}\.gguf$/i

export interface SplitGap {
  base: string
  total: number
  chosen: number
}

/**
 * 找出「只选了一部分」的分片组。分片缺片时上游仍会照单全收，但落盘的模型 llama.cpp 加载不了，
 * 白白浪费一次大文件下载，所以入队前必须整组校验。
 */
export function findIncompleteSplit(files: HfModelFile[], selected: string[]): SplitGap | null {
  const chosen = new Set(selected)
  const groups = new Map<string, { total: number; parts: Set<number> }>()
  for (const file of files) {
    if (!file.split) continue
    const base = file.path.replace(SPLIT_SUFFIX, '')
    // 名字不符合分片约定的文件推导不出同批其它分片，不能替用户判断完整性。
    if (base === file.path) continue
    const entry = groups.get(base) ?? { total: file.split.total, parts: new Set<number>() }
    entry.total = Math.max(entry.total, file.split.total)
    if (chosen.has(file.path)) entry.parts.add(file.split.part)
    groups.set(base, entry)
  }
  for (const [base, group] of groups) {
    if (group.parts.size > 0 && group.parts.size < group.total) {
      return { base, total: group.total, chosen: group.parts.size }
    }
  }
  return null
}