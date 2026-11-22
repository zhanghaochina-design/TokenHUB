import { readdir, stat } from 'node:fs/promises'
import { join, posix, relative, resolve } from 'node:path'
import { readGgufKvInfo } from './gguf'
import type { InstalledModel } from './types'

// 分片命名遵循 HuggingFace/llama.cpp 约定：<base>-00001-of-00003.gguf。
const SPLIT_PATTERN = /^(.+)-(\d{5})-of-(\d{5})\.gguf$/i
// 用量化标签识别 GGUF 文件名里的量化方式，结果只用于展示。
const QUANT_PATTERN = /(?:^|[-_.])(IQ\d+(?:_[A-Z0-9]+)+|Q\d+(?:_[A-Z0-9]+)+|Q\d+|F16|F32|BF16)(?=[-_.]|$)/i
// 模型 ID 允许的字符：保留 -、_、.、@、:、+（@ 用于同 ID 去重后缀）。
const ID_UNSAFE_PATTERN = /[^\w.@:+-]+/g
const MAX_DEPTH = 3

export function splitInfo(fileName: string): { base: string; part: number; total: number } | null {
  const match = SPLIT_PATTERN.exec(fileName)
  if (!match) return null
  return { base: match[1], part: Number(match[2]), total: Number(match[3]) }
}

export function quantFromFileName(fileName: string): string | null {
  const match = QUANT_PATTERN.exec(fileName)
  return match ? match[1].toUpperCase() : null
}

// 下载与删除都会把相对路径拼到 modelsDir 下，因此必须拒绝绝对路径与 `..`。
// 空段（含重复分隔符）同样拒绝，避免 Windows 上被解释成盘符或根目录。
export function isSafeRelativePath(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return false
  return normalized.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function modelIdFromName(name: string): string {
  const stem = name.replace(/\.gguf$/i, '')
  const id = stem.replace(ID_UNSAFE_PATTERN, '-').replace(/^-+|-+$/g, '')
  return !id || /^\.+$/.test(id) ? 'local-model' : id
}

function isSplitComplete(parts: Map<number, unknown>, total: number): boolean {
  if (!Number.isInteger(total) || total < 1) return false
  for (const part of parts.keys()) if (part < 1 || part > total) return false
  for (let part = 1; part <= total; part += 1) if (!parts.has(part)) return false
  return true
}

export function groupGgufFiles(inputs: Array<{ relative: string; size: number }>): InstalledModel[] {
  const splits = new Map<
    string,
    { base: string; dir: string; total: number; parts: Map<number, { relative: string; size: number }> }
  >()
  const singles: Array<{ relative: string; size: number }> = []
  for (const input of inputs) {
    const rel = input.relative.replace(/\\/g, '/')
    const name = posix.basename(rel)
    // 只认 .gguf（未完成下载以 .gguf.part 结尾，天然被排除）；mmproj-* 是视觉投影权重，不能单独驱动推理。
    if (!/\.gguf$/i.test(name) || name.toLowerCase().startsWith('mmproj') || !isSafeRelativePath(rel)) continue
    const split = splitInfo(name)
    const dir = posix.dirname(rel)
    if (!split) {
      singles.push({ relative: rel, size: input.size })
      continue
    }
    const key = `${dir}/${split.base}/${split.total}`
    const entry = splits.get(key) ?? { base: split.base, dir, total: split.total, parts: new Map() }
    entry.parts.set(split.part, { relative: rel, size: input.size })
    splits.set(key, entry)
  }

  // 顺序契约：先完整分片模型，再单文件模型，各自按相对路径字典序。
  const models: InstalledModel[] = []
  for (const key of [...splits.keys()].sort()) {
    const entry = splits.get(key)!
    if (!isSplitComplete(entry.parts, entry.total)) continue
    const parts = [...entry.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part)
    models.push(buildModel(entry.dir, entry.base, parts, entry.total))
  }
  for (const single of [...singles].sort((a, b) => a.relative.localeCompare(b.relative))) {
    const base = posix.basename(single.relative).replace(/\.gguf$/i, '')
    models.push(buildModel(posix.dirname(single.relative), base, [single], 1))
  }

  // 不同目录下同名模型各占一条：重名者追加 @目录 后缀，仍冲突时再串序号。
  const used = new Set<string>()
  return models.map((model) => {
    if (!used.has(model.id)) {
      used.add(model.id)
      return model
    }
    const suffix = repoDirOf(model.path) || 'root'
    let id = `${model.id}@${suffix}`.replace(ID_UNSAFE_PATTERN, '-')
    for (let index = 2; used.has(id); index += 1) id = `${model.id}@${suffix}-${index}`.replace(ID_UNSAFE_PATTERN, '-')
    used.add(id)
    return { ...model, id }
  })
}

function buildModel(
  dir: string,
  base: string,
  parts: Array<{ relative: string; size: number }>,
  partCount: number
): InstalledModel {
  // repo 只用于展示，取相对路径前两段（org/repo）；根目录文件没有 repo。
  const repo = !dir || dir === '.' ? undefined : dir.split('/').slice(0, 2).join('/')
  return {
    id: modelIdFromName(base),
    // path 相对 modelsDir，调用方用 join(modelsDir, path) 定位文件。
    // 分片模型这里是第一个分片（llama.cpp 会自行加载其余分片），全部路径见 shardPaths。
    path: parts[0].relative,
    sizeBytes: parts.reduce((sum, part) => sum + part.size, 0),
    parts: partCount,
    repo,
    quant: quantFromFileName(base) ?? undefined,
    loaded: false
  }
}

/**
 * 模型占用的全部文件（相对 modelsDir）。删除模型必须按这个列表逐个删，
 * 否则分片模型只会删掉第一个分片，留下永远拼不起来的残片。
 * 文件名不含分片标记（无法推导同批其它分片）时退回单文件，绝不凭空构造路径。
 */
export function shardPaths(model: InstalledModel): string[] {
  if (model.parts <= 1) return [model.path]
  const firstShard = posix.basename(model.path)
  const split = splitInfo(firstShard)
  if (!split) return [model.path]
  const dir = posix.dirname(model.path)
  // 扩展名沿用第一个分片的原始大小写（也存在 `.GGUF`）：大小写敏感的文件系统上硬编码 `.gguf` 会找不到文件。
  const ext = posix.extname(firstShard) || '.gguf'
  const paths: string[] = []
  for (let part = 1; part <= split.total; part += 1) {
    const fileName = `${split.base}-${String(part).padStart(5, '0')}-of-${String(split.total).padStart(5, '0')}${ext}`
    paths.push(dir === '.' ? fileName : `${dir}/${fileName}`)
  }
  return paths
}

function repoDirOf(path: string): string {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir.split('/').slice(0, 2).join('-')
}

async function walk(root: string, dir: string, depth: number, out: Array<{ relative: string; size: number }>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(root, full, depth + 1, out)
      continue
    }
    if (!entry.isFile() || !/\.gguf$/i.test(entry.name)) continue
    const info = await stat(full).catch(() => null)
    if (!info) continue
    out.push({ relative: relative(root, full), size: info.size })
  }
}

// modelsDir 不存在或不可读时返回空列表：本地模型页应显示「暂无模型」而不是报错。
export async function scanModels(modelsDir: string): Promise<InstalledModel[]> {
  const root = resolve(modelsDir)
  const files: Array<{ relative: string; size: number }> = []
  await walk(root, root, 0, files)
  const models = groupGgufFiles(files)
  // 训练上下文与 KV 成本只能从 GGUF 头读；解析失败不阻断扫描，界面按未知处理。
  return await Promise.all(
    models.map(async (model) => {
      const kvInfo = await readGgufKvInfo(join(root, model.path))
      return kvInfo ? { ...model, kvInfo } : model
    })
  )
}