import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 端口与其它 e2e 文件（smoke 用 18787）错开：本文件两个用例各占一个，避免串行复用同一监听。
const PORTS = { page: '18788', providers: '18789' }

// 透传宿主机环境时剔除 ELECTRON_RUN_AS_NODE：带着它启动的 Electron 会退化成纯 Node，
// 主进程根本不会加载，Playwright 也连不上。
function launchEnv(dataDir: string, port: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') continue
    if (value !== undefined) env[key] = value
  }
  env.TOKENHUB_DATA_DIR = dataDir
  env.TOKENHUB_PORT = port
  return env
}

async function withApp(port: string, run: (win: Awaited<ReturnType<ElectronApplication['firstWindow']>>) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-local-e2e-'))
  const app = await electron.launch({ args: ['.'], env: launchEnv(dataDir, port) })
  try {
    const win = await app.firstWindow()
    await run(win)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

test('opens the local models page and shows P1 sections', async () => {
  await withApp(PORTS.page, async (win) => {
    await win.getByRole('link', { name: '本地模型' }).click()
    await expect(win.getByRole('heading', { name: '本地模型', level: 1 })).toBeVisible()
    await expect(win.getByText('显卡与后端')).toBeVisible()
    await expect(win.getByText('已安装模型')).toBeVisible()
  })
})

test('keeps the local page between models and settings and manages the local provider row', async () => {
  await withApp(PORTS.providers, async (win) => {
    const nav = win.getByRole('navigation', { name: '主导航' })
    await expect(nav.getByRole('link')).toHaveText(['概览', '用量', '供应商', '模型', '本地模型', '设置'])

    // 本地供应商由 LocalService 托管：无 Key 文案 + 「托管」占位，不提供编辑/删除。
    await nav.getByRole('link', { name: '供应商' }).click()
    await expect(win.getByRole('heading', { name: '供应商', level: 1 })).toBeVisible()
    const row = win
      .getByRole('list', { name: '供应商列表' })
      .getByRole('listitem')
      .filter({ hasText: '本机推理 · 无需 Key' })
    await expect(row).toBeVisible()
    await expect(row.getByText('托管')).toBeVisible()
    await expect(row.getByRole('button', { name: /编辑|删除/ })).toHaveCount(0)
  })
})
