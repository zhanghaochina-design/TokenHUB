import { describe, expect, it } from 'vitest'
import { appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore } from '../../core/history/store'
import type { HistoryRecord } from '../../core/types'

const record = (ts: string): HistoryRecord => ({
  ts, requestId: 'r', protocol: 'openai', model: 'm', providerId: 'p', upstreamModel: 'm',
  stream: false, httpStatus: 200, outcome: 'ok', promptTokens: 1, completionTokens: 2,
  latencyMs: 10, firstByteMs: 5, errorKind: null
})

describe('HistoryStore', () => {
  it('appends, lists newest-first and computes stats', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-history-'))
    const store = new HistoryStore(dir, () => new Date('2026-10-28T12:00:00Z'))
    await store.append(record('2026-10-28T12:00:00.000Z'))
    await store.append({ ...record('2026-10-28T13:00:00.000Z'), outcome: 'error' })
    const list = await store.list('2026-10-28')
    expect(list.map((r) => r.ts)).toEqual(['2026-10-28T13:00:00.000Z', '2026-10-28T12:00:00.000Z'])
    expect(await store.statsFor('2026-10-28')).toEqual({ requests: 2, promptTokens: 2, completionTokens: 4, failures: 1 })
  })

  it('skips only corrupt lines and keeps the valid records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-history-'))
    const store = new HistoryStore(dir, () => new Date('2026-10-28T12:00:00Z'))
    await store.append(record('2026-10-28T12:00:00.000Z'))
    await store.append({ ...record('2026-10-28T13:00:00.000Z'), outcome: 'error' })
    // 模拟进程中断留下的截断行
    await appendFile(join(dir, '2026-10-28.jsonl'), '{"ts":"2026-10-28T14:00:00.000Z","requestId":"truncated\n', 'utf8')

    const list = await store.list('2026-10-28')
    expect(list.map((r) => r.ts)).toEqual(['2026-10-28T13:00:00.000Z', '2026-10-28T12:00:00.000Z'])
    expect((await store.list('2026-10-28', 1)).map((r) => r.ts)).toEqual(['2026-10-28T13:00:00.000Z'])
    expect(await store.statsFor('2026-10-28')).toEqual({ requests: 2, promptTokens: 2, completionTokens: 4, failures: 1 })
  })

  it('prunes files older than retention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenhub-history-'))
    const store = new HistoryStore(dir, () => new Date('2026-10-28T12:00:00Z'))
    await store.append({ ...record('2026-09-01T00:00:00.000Z') })
    await store.prune(30)
    expect(await store.list('2026-09-01')).toEqual([])
  })
})
