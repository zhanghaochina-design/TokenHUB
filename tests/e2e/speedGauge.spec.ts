import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = '18790'

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

test('shows latest and daily average token speed on the quota card', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-e2e-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    const win = await app.firstWindow()

    await win.getByRole('link', { name: '供应商', exact: true }).click()
    await win.getByRole('button', { name: '添加供应商' }).click()
    await win.getByLabel('预设').selectOption('opencode-go')
    await win.getByLabel('API Key').fill('sk-test')
    await win.getByRole('button', { name: '保存' }).click()
    await expect(win.getByRole('list', { name: '供应商列表' }).getByText('OpenCode Go')).toBeVisible()

    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { providers: Array<{ id: string }> }
    const providerId = config.providers[0].id
    const historyDir = join(dataDir, 'history')
    mkdirSync(historyDir, { recursive: true })
    const now = Date.now()
    const rows = [
      {
        ts: new Date(now - 60_000).toISOString(), requestId: 'r1', protocol: 'anthropic', model: 'claude-sonnet-4-5',
        providerId, upstreamModel: 'deepseek-v4.1-flash', stream: true, httpStatus: 200, outcome: 'ok',
        promptTokens: 10, completionTokens: 100, latencyMs: 1100, firstByteMs: 100, errorKind: null
      },
      {
        ts: new Date(now).toISOString(), requestId: 'r2', protocol: 'anthropic', model: 'claude-sonnet-4-5',
        providerId, upstreamModel: 'deepseek-v4.1-flash', stream: true, httpStatus: 200, outcome: 'ok',
        promptTokens: 10, completionTokens: 200, latencyMs: 1100, firstByteMs: 100, errorKind: null
      }
    ]
    writeFileSync(join(historyDir, `${localDayKey()}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    await win.reload()
    await win.getByRole('link', { name: '概览', exact: true }).click()
    await expect(win.getByRole('img', { name: /最新 200 t\/s，今日平均 150 t\/s，2 条样本/ })).toBeVisible()
    await win.screenshot({ path: 'out/overview-speed-gauge.png' })
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
