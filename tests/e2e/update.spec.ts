import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = '18792'

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

test('settings shows the manual update card in development mode', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-e2e-update-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    const win = await app.firstWindow()
    await win.getByRole('link', { name: '设置' }).click()

    await expect(win.getByRole('heading', { name: '软件更新' })).toBeVisible()
    await expect(win.getByText('当前版本')).toBeVisible()
    await expect(win.getByText('仅安装版支持更新检查；开发与测试环境不会请求 GitHub。')).toBeVisible()
    await expect(win.getByRole('button', { name: '检查更新' })).toBeDisabled()
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
