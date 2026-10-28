import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = '18787'
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`

// 透传宿主机环境时剔除 ELECTRON_RUN_AS_NODE：带着它启动的 Electron 会退化成纯 Node，
// 主进程根本不会加载，Playwright 也连不上（本机工具链会设置该变量）。
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

test('boots, serves health and hides to tray on close', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-e2e-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    const win = await app.firstWindow()
    await expect(win).toHaveTitle(/TokenHUB/)
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(HEALTH_URL)).status
          } catch {
            return 0
          }
        },
        { timeout: 15_000 }
      )
      .toBe(200)

    const pidBefore = await app.evaluate(() => process.pid)

    // 关闭窗口应命中 close-to-tray：窗口隐藏但保留，主进程与其 HTTP 服务继续存活。
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close()
    })
    await expect
      .poll(
        () =>
          app!.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows()
            return { count: windows.length, visible: windows[0]?.isVisible() ?? false }
          }),
        { timeout: 5_000 }
      )
      .toEqual({ count: 1, visible: false })

    expect(await app.evaluate(() => process.pid)).toBe(pidBefore)
    expect((await fetch(HEALTH_URL)).status).toBe(200)
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
