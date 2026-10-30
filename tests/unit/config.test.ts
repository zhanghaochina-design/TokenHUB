import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, loadConfig, normalizeConfig, saveConfig } from '../../core/store/config'
import { readText } from '../../core/store/fsUtil'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tokenhub-config-'))
}

describe('config store', () => {
  it('returns defaults when file missing', async () => {
    const dir = await tempDir()
    const cfg = await loadConfig(dir)
    expect(cfg.settings.port).toBe(8787)
    expect(cfg.settings.quotaRefreshSec).toBe(300)
    expect(cfg.settings.closeToTray).toBe(true)
    expect(cfg.providers).toEqual([])
    expect(cfg.modelAliases).toEqual([])
  })

  it('normalizes aliases, trims targets and keeps zero-target aliases', () => {
    const cfg = normalizeConfig({
      modelAliases: [
        {
          id: ' deepseek4.1flash ',
          targets: [
            { providerId: ' p1 ', upstreamModel: ' deepseek-v4.1-flash ' },
            { providerId: 'p1', upstreamModel: 'duplicate-provider' },
            { providerId: 'p2', upstreamModel: '   ' }
          ]
        },
        { id: 'deepseek4.1flash', targets: [{ providerId: 'p2', upstreamModel: 'x' }] },
        { id: 'empty', targets: [] }
      ]
    })
    expect(cfg.modelAliases).toEqual([
      { id: 'deepseek4.1flash', targets: [{ providerId: 'p1', upstreamModel: 'deepseek-v4.1-flash' }] },
      { id: 'empty', targets: [] }
    ])
  })

  it('normalizes scanned protocol support entries', () => {
    const cfg = normalizeConfig({
      providers: [
        {
          id: 'p1',
          name: 'P1',
          preset: 'opencode-go',
          baseUrl: 'https://p1.example/v1',
          models: { cached: ['m'], manual: [], lastSyncedAt: null },
          protocolSupport: {
            m: { anthropic: true, openai: false, checkedAt: '2026-10-29T00:00:00.000Z' },
            bad: { anthropic: 'yes', openai: 1 },
            nope: null
          }
        }
      ]
    })
    expect(cfg.providers[0].protocolSupport).toEqual({
      m: { anthropic: true, openai: false, checkedAt: '2026-10-29T00:00:00.000Z' },
      bad: { anthropic: null, openai: null, checkedAt: '' }
    })
  })

  it('normalizes the optional Anthropic base url', () => {
    const cfg = normalizeConfig({
      providers: [
        { id: 'p1', name: 'P1', preset: 'custom', baseUrl: 'https://p1.example/v1', anthropicBaseUrl: ' https://p1.example/claude/v1/ ' },
        { id: 'p2', name: 'P2', preset: 'custom', baseUrl: 'https://p2.example/v1', anthropicBaseUrl: '   ' }
      ]
    })
    expect(cfg.providers[0].anthropicBaseUrl).toBe('https://p1.example/claude/v1')
    expect(cfg.providers[1].anthropicBaseUrl).toBeUndefined()
  })

  it('round-trips provider order', async () => {
    const dir = await tempDir()
    const cfg = defaultConfig()
    cfg.providers.push(
      { id: 'b', name: 'B', preset: 'custom', baseUrl: 'https://b.example/v1', quotaAdapter: 'none', enabled: true, models: { cached: [], manual: [], lastSyncedAt: null }, quota: { lowBalanceThreshold: 0.5, quotaCooldownMs: 18_000_000, injectStreamUsage: true } },
      { id: 'a', name: 'A', preset: 'custom', baseUrl: 'https://a.example/v1', quotaAdapter: 'none', enabled: true, models: { cached: [], manual: [], lastSyncedAt: null }, quota: { lowBalanceThreshold: 0.5, quotaCooldownMs: 18_000_000, injectStreamUsage: true } }
    )
    await saveConfig(dir, cfg)
    const loaded = await loadConfig(dir)
    expect(loaded.providers.map((p) => p.id)).toEqual(['b', 'a'])
  })

  it('quarantines corrupted json and returns defaults', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'config.json'), '{ broken', 'utf8')
    const cfg = await loadConfig(dir)
    expect(cfg.settings.port).toBe(8787)
    const files = await import('node:fs/promises').then((fs) => fs.readdir(dir))
    expect(files.some((f) => f.startsWith('config.corrupt-'))).toBe(true)
    expect(await readFile(join(dir, 'config.json'), 'utf8').catch(() => null)).toBe(null)
  })

  it('normalizes non-finite or negative settings and quota values', async () => {
    const dir = await tempDir()
    // 手改配置可能留下 "NaN"/"abc"/负数；它们进入 Date 运算会抛 RangeError，必须回退默认值。
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        settings: { port: 'abc', quotaRefreshSec: -5, retentionDays: 'NaN' },
        providers: [
          {
            id: 'p1',
            name: 'P1',
            preset: 'custom',
            baseUrl: 'https://p1.example/v1',
            quota: { lowBalanceThreshold: 'abc', quotaCooldownMs: 'NaN' }
          },
          {
            id: 'p2',
            name: 'P2',
            preset: 'custom',
            baseUrl: 'https://p2.example/v1',
            quota: { lowBalanceThreshold: -1, quotaCooldownMs: -1000, injectStreamUsage: false }
          }
        ]
      }),
      'utf8'
    )
    const cfg = await loadConfig(dir)
    expect(cfg.settings.port).toBe(8787)
    expect(cfg.settings.quotaRefreshSec).toBe(300)
    expect(cfg.settings.retentionDays).toBe(30)
    expect(cfg.providers[0].quota).toMatchObject({ lowBalanceThreshold: 0.5, quotaCooldownMs: 18_000_000 })
    expect(cfg.providers[1].quota).toMatchObject({ lowBalanceThreshold: 0.5, quotaCooldownMs: 18_000_000 })
    // 显式关闭的 usage 注入必须保留，归一化不能顺手打开。
    expect(cfg.providers[1].quota.injectStreamUsage).toBe(false)
    expect(() => new Date(Date.now() + cfg.providers[0].quota.quotaCooldownMs).toISOString()).not.toThrow()
  })

  it('propagates non-ENOENT read errors instead of treating them as missing', async () => {
    const dir = await tempDir()
    // A directory at the config path makes readFile fail with EISDIR (verified on
    // Windows and POSIX), which is a non-ENOENT error we must not swallow.
    await mkdir(join(dir, 'config.json'))
    await expect(readText(join(dir, 'config.json'))).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(loadConfig(dir)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('keeps config.json valid under concurrent saves', async () => {
    const dir = await tempDir()
    const saves = Array.from({ length: 8 }, (_, index) => {
      const cfg = defaultConfig()
      cfg.settings.port = 9100 + index
      return saveConfig(dir, cfg)
    })
    await expect(Promise.all(saves)).resolves.toHaveLength(8)
    const loaded = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as { version: number; settings: { port: number } }
    expect(loaded.version).toBe(1)
    expect(loaded.settings.port).toBeGreaterThanOrEqual(9100)
    expect(loaded.settings.port).toBeLessThanOrEqual(9107)
    // 唯一 tmp 名必须在成功 rename 后清理干净，不能在数据目录留下垃圾。
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
