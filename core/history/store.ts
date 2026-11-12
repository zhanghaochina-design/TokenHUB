import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { HistoryRecord, HistorySink, TodayStats } from '../types'

function dayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export class HistoryStore implements HistorySink {
  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  async append(record: HistoryRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const day = dayKey(new Date(record.ts))
    await appendFile(join(this.dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
  }

  async list(day: string, limit = 200): Promise<HistoryRecord[]> {
    let text: string
    try {
      text = await readFile(join(this.dir, `${day}.jsonl`), 'utf8')
    } catch {
      return []
    }
    const rows: HistoryRecord[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line) as HistoryRecord)
      } catch {
        // 单行截断/损坏（如进程中断）只跳过该行，不能让整天记录归零
      }
    }
    return rows.reverse().slice(0, limit)
  }

  async statsFor(day: string): Promise<TodayStats> {
    const rows = await this.list(day, Number.MAX_SAFE_INTEGER)
    return {
      requests: rows.length,
      promptTokens: rows.reduce((sum, r) => sum + (r.promptTokens ?? 0), 0),
      completionTokens: rows.reduce((sum, r) => sum + (r.completionTokens ?? 0), 0),
      failures: rows.filter((r) => r.outcome === 'error').length
    }
  }

  // 读取 [fromDay, toDay] 闭区间内所有本地日文件；周期统计需要跨多天聚合。
  async listRange(fromDay: string, toDay: string): Promise<HistoryRecord[]> {
    const files = await readdir(this.dir).catch(() => [] as string[])
    const rows: HistoryRecord[] = []
    for (const file of files.sort()) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue
      const day = file.slice(0, 10)
      if (day < fromDay || day > toDay) continue
      rows.push(...(await this.list(day, Number.MAX_SAFE_INTEGER)))
    }
    return rows
  }

  async prune(retentionDays: number): Promise<void> {
    if (retentionDays <= 0) return
    const files = await readdir(this.dir).catch(() => [] as string[])
    const cutoff = dayKey(new Date(this.now().getTime() - retentionDays * 86_400_000))
    for (const file of files) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < cutoff) {
        await unlink(join(this.dir, file)).catch(() => {})
      }
    }
  }

  today(): string {
    return dayKey(this.now())
  }
}
