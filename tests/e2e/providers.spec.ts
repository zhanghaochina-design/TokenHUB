import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = '18789'

// 与 smoke 测试一致：剔除 ELECTRON_RUN_AS_NODE，否则 Electron 会退化为纯 Node 进程。
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

test('adds a provider from preset', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-e2e-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    const win = await app.firstWindow()

    // 概览空状态也链接到供应商页，按精确名称定位侧栏导航。
    await win.getByRole('link', { name: '供应商', exact: true }).click()
    await win.getByRole('button', { name: '添加供应商' }).click()
    await win.getByLabel('预设').selectOption('opencode-go')
    await win.getByLabel('API Key').fill('sk-test')
    const concurrency = win.getByLabel('最大并发')
    await expect(concurrency).toHaveValue('3')
    await concurrency.fill('2')
    // 等焦点过渡结束再留档（密码框只显示掩码），供人工核对布局与对比度。
    await win.waitForTimeout(200)
    await win.screenshot({ path: 'out/provider-dialog.png' })
    await win.getByRole('button', { name: '保存' }).click()

    await expect(win.getByRole('list', { name: '供应商列表' }).getByText('OpenCode Go')).toBeVisible()
    await expect.poll(() => {
      const raw = readFileSync(join(dataDir, 'config.json'), 'utf8')
      return (JSON.parse(raw) as { providers: Array<{ maxConcurrency?: number }> }).providers[0]?.maxConcurrency
    }).toBe(2)
    // 渲染层永远不应回显明文 Key。
    await expect(win.getByText('sk-test')).toHaveCount(0)

    // 留档截图，供人工核对对齐与对比度（out/ 已被 .gitignore 忽略）。
    await win.screenshot({ path: 'out/providers.png' })
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
