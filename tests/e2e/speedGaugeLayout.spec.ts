import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = '18791'

function launchEnv(dataDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') continue
    if (value !== undefined) env[key] = value
  }
  env.TOKENHUB_DATA_DIR = dataDir
  env.TOKENHUB_PORT = PORT
  return env
}

function localDayKey(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

test('quota bars and speed gauge layout', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-e2e-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    let win = await app.firstWindow()
    await win.getByRole('link', { name: '供应商', exact: true }).click()
    await win.getByRole('button', { name: '添加供应商' }).click()
    await win.getByLabel('预设').selectOption('opencode-go')
    await win.getByLabel('API Key').fill('sk-test')
    await win.getByRole('button', { name: '保存' }).click()
    await expect(win.getByRole('list', { name: '供应商列表' }).getByText('OpenCode Go')).toBeVisible()

    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { providers: Array<{ id: string }> }
    const providerId = config.providers[0].id
    await app.close()

    const now = Date.now()
    writeFileSync(
      join(dataDir, 'quota-cache.json'),
      JSON.stringify({
        [providerId]: {
          providerId,
          availability: 'ok',
          windows: {
            rolling: { percent: 42, status: 'ok', resetsAt: new Date(now + 3 * 3600_000).toISOString() },
            weekly: { percent: 68, status: 'ok', resetsAt: new Date(now + 2 * 86400_000).toISOString() },
            monthly: { percent: 83, status: 'ok', resetsAt: new Date(now + 20 * 86400_000).toISOString() }
          },
          source: 'probe',
          fetchedAt: new Date().toISOString()
        }
      }),
      'utf8'
    )
    const historyDir = join(dataDir, 'history')
    mkdirSync(historyDir, { recursive: true })
    const rows = [
      {
        ts: new Date(now - 60_000).toISOString(), requestId: 'r1', protocol: 'anthropic', model: 'claude-sonnet-4-5',
        providerId, upstreamModel: 'deepseek-v4.1-flash', stream: true, httpStatus: 200, outcome: 'ok',
        promptTokens: 10, completionTokens: 150, latencyMs: 1100, firstByteMs: 100, errorKind: null
      },
      {
        ts: new Date(now).toISOString(), requestId: 'r2', protocol: 'anthropic', model: 'claude-sonnet-4-5',
        providerId, upstreamModel: 'deepseek-v4.1-flash', stream: true, httpStatus: 200, outcome: 'ok',
        promptTokens: 10, completionTokens: 210, latencyMs: 1100, firstByteMs: 100, errorKind: null
      }
    ]
    writeFileSync(join(historyDir, `${localDayKey()}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    win = await app.firstWindow()
    await win.getByRole('link', { name: '概览', exact: true }).click()
    await expect(win.getByRole('img', { name: /最新 210 t\/s/ })).toBeVisible()
    await expect(win.getByRole('progressbar')).toHaveCount(3)
    await win.screenshot({ path: 'out/quota-with-gauge.png' })
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 900)
    })
    await win.waitForTimeout(300)
    await win.screenshot({ path: 'out/quota-with-gauge-wide.png' })
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
