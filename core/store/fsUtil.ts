import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const RENAME_RETRIES = 5
const RENAME_RETRY_BASE_MS = 10

// 只有“文件不存在”才是可恢复的空状态；其余读取错误必须上抛，
// 否则调用方会拿默认值继续运行，并在下次保存时覆盖真实数据。
export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  // 每次写入独占一个临时文件：固定的 `${file}.tmp` 会让并发保存互相覆盖或误删对方的 tmp。
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, content, 'utf8')
  try {
    await renameWithRetry(tmp, file)
  } finally {
    // 成功后 tmp 已不存在；失败时清理残留，避免在数据目录里留下半个文件。
    await rm(tmp, { force: true }).catch(() => {})
  }
}

// Windows 上杀毒/索引器短暂占用目标文件会让 rename 返回 EPERM/EBUSY。
// 此时删除目标再重试会毁掉另一个并发写入刚提交的内容，所以只做退避重试，最终失败则上抛。
async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      if (attempt >= RENAME_RETRIES || !isTransientRenameError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_BASE_MS * (attempt + 1)))
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}
