import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeUpstream } from '../helpers/fakeUpstream'

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

test('shows in-flight concurrency on the quota card', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-e2e-'))
  let release: () => void = () => {}
  const hold = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  let arrived!: () => void
  const seen = new Promise<void>((resolve) => { arrived = resolve })
  const upstream = await startFakeUpstream(async (path) => {
    if (path.endsWith('/models')) return { status: 200, body: JSON.stringify({ data: [{ id: 'm' }] }) }
    if (path.includes('/chat/completions')) {
      arrived()
      await hold
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      }
    }
    return { status: 200, body: '{}' }
  })

  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    const win = await app.firstWindow()

    await win.getByRole('link', { name: '供应商', exact: true }).click()
    await win.getByRole('button', { name: '添加供应商' }).click()
    await win.getByLabel('预设').selectOption('opencode-go')
    await win.getByLabel('Base URL', { exact: true }).fill(upstream.url)
    await win.getByLabel('API Key').fill('sk-test')
    await win.getByRole('button', { name: '保存' }).click()
    await expect(win.getByRole('list', { name: '供应商列表' }).getByText('OpenCode Go')).toBeVisible()

    // 模型发现完成后 /v1 才能解析 m。
    await expect.poll(() => {
      const raw = readFileSync(join(dataDir, 'config.json'), 'utf8')
      return (JSON.parse(raw) as { providers: Array<{ models: { cached: string[] } }> }).providers[0]?.models.cached
    }).toContain('m')

    await win.getByRole('link', { name: '概览', exact: true }).click()
    await expect(win.getByText('并发 0 / 3')).toBeVisible()

    const request = fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'ping' }] })
    }).catch(() => null)

    await seen
    await expect(win.getByText('并发 1 / 3')).toBeVisible()
    await win.screenshot({ path: 'out/overview-concurrency.png' })

    release()
    expect((await request)?.status).toBe(200)
    await expect(win.getByText('并发 0 / 3')).toBeVisible()
  } finally {
    release()
    await app?.close()
    await upstream.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
