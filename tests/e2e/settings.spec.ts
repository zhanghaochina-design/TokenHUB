import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = '18791'
const MODELS_URL = `http://127.0.0.1:${PORT}/v1/models`
const LOCAL_KEY = 'sk-local-e2e-key'

// 与 smoke/providers 一致：剔除 ELECTRON_RUN_AS_NODE，否则 Electron 会退化为纯 Node 进程。
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

async function modelsStatus(headers?: Record<string, string>): Promise<number> {
  try {
    return (await fetch(MODELS_URL, { headers })).status
  } catch {
    return 0
  }
}

test('local access key set and cleared from settings page', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-e2e-settings-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    const win = await app.firstWindow()

    // 未启用本地 Key 时 /v1/models 直接可用。
    await expect.poll(() => modelsStatus(), { timeout: 15_000 }).toBe(200)

    await win.getByRole('link', { name: '设置' }).click()
    await expect(win.getByRole('heading', { name: '设置' })).toBeVisible()
    await expect(win.getByText(`http://127.0.0.1:${PORT}/v1`, { exact: true })).toBeVisible()

    const keyInput = win.getByLabel('访问 Key', { exact: true })
    const keyToggle = win.getByRole('switch', { name: '启用本地访问 Key' })
    await expect(keyToggle).toHaveAttribute('aria-checked', 'false')

    await keyInput.fill(LOCAL_KEY)
    await win.getByRole('button', { name: '保存 Key' }).click()

    await expect(keyToggle).toHaveAttribute('aria-checked', 'true')
    // 无 Key 被拒绝，Bearer 形式放行（x-api-key 在同一条中间件上）。
    await expect.poll(() => modelsStatus(), { timeout: 10_000 }).toBe(401)
    await expect
      .poll(() => modelsStatus({ 'x-api-key': LOCAL_KEY }), { timeout: 10_000 })
      .toBe(200)
    await expect
      .poll(() => modelsStatus({ authorization: `Bearer ${LOCAL_KEY}` }), { timeout: 10_000 })
      .toBe(200)

    // 渲染层不得回显 Key，输入框保存后清空。
    await expect(keyInput).toHaveValue('')
    await expect(win.getByText(LOCAL_KEY)).toHaveCount(0)
    await win.waitForTimeout(200)
    await win.screenshot({ path: 'out/settings.png' })

    await win.getByRole('button', { name: '清除 Key' }).click()
    await expect(keyToggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => modelsStatus(), { timeout: 10_000 }).toBe(200)

    // 边界校验：非法端口与刷新间隔只提示错误，不触发重启。
    await win.getByLabel('端口', { exact: true }).fill('0')
    await win.getByRole('button', { name: '保存端口' }).click()
    await expect(win.getByText('端口必须是 1-65535 之间的整数。')).toBeVisible()
    await win.getByLabel('额度刷新间隔（秒）').fill('5')
    await win.getByRole('button', { name: '保存间隔' }).click()
    await expect(win.getByText('额度刷新间隔必须是 10-3600 秒之间的整数。')).toBeVisible()
    expect(await modelsStatus()).toBe(200)
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
