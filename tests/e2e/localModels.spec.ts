import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 端口与其它 e2e 文件（smoke 用 18787）错开：本文件每个用例各占一个，避免串行复用同一监听。
const PORTS = { page: '18788', providers: '18789', panels: '18790', gpu: '18791', layout: '18792' }

type Window = Awaited<ReturnType<ElectronApplication['firstWindow']>>

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

async function withApp(
  port: string,
  run: (win: Window, app: ElectronApplication) => Promise<void>,
  seed?: (dataDir: string) => void
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-local-e2e-'))
  seed?.(dataDir)
  const app = await electron.launch({ args: ['.'], env: launchEnv(dataDir, port) })
  try {
    const win = await app.firstWindow()
    await run(win, app)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

// 预置两块 Vulkan 卡与一条安装记录：设备下拉的数据源是运行时 `--list-devices`，不是 WMI。
function seedTwoGpuRuntime(dataDir: string): void {
  mkdirSync(join(dataDir, 'local'), { recursive: true })
  writeFileSync(join(dataDir, 'local.json'), JSON.stringify({ backend: 'vulkan', gpuDevice: 'Vulkan1' }), 'utf8')
  writeFileSync(
    join(dataDir, 'local', 'runtime.json'),
    JSON.stringify([
      {
        backend: 'vulkan',
        tag: 'b1',
        installedAt: '2026-01-01T00:00:00.000Z',
        devices: [
          'Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB)',
          'Vulkan1: AMD Radeon(TM) Graphics (1024 MiB)'
        ],
        sourceUrl: 'https://example.com/llama.zip',
        exePath: 'C:/fake/llama-server.exe'
      }
    ]),
    'utf8'
  )
}

async function resize(win: Window, app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height)
  }, { width, height })
}

function card(win: Window, name: string) {
  return win.locator('section').filter({ has: win.getByRole('heading', { name, exact: true }) })
}

test('opens the local models page and shows P1 sections', async () => {
  await withApp(PORTS.page, async (win) => {
    await win.getByRole('link', { name: '本地模型' }).click()
    await expect(win.getByRole('heading', { name: '本地模型', level: 1 })).toBeVisible()
    await expect(win.getByText('显卡与后端')).toBeVisible()
    await expect(win.getByText('已安装模型')).toBeVisible()
    // 没有运行时安装记录（无设备列表）时不出现显卡下拉。
    await expect(win.getByLabel('使用显卡（下次加载模型生效）')).toHaveCount(0)
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

test('shows HF search, download queue and local settings', async () => {
  await withApp(PORTS.panels, async (win) => {
    await win.getByRole('link', { name: '本地模型' }).click()
    await expect(win.getByRole('heading', { name: '本地模型', level: 1 })).toBeVisible()
    await expect(win.getByText('HuggingFace 模型')).toBeVisible()
    await expect(win.getByText('下载队列')).toBeVisible()
    await expect(win.getByText('本地设置')).toBeVisible()
    // 模型目录必须能通过系统文件夹选择器回填，而不是只能手输。
    await expect(win.getByRole('button', { name: '选择目录' })).toBeVisible()
    // Token 输入永不明文回显：类型固定为 password 且初始为空。
    await expect(win.getByLabel('HF Token（未设置；Gated 模型需要）')).toHaveAttribute('type', 'password')
    await expect(win.getByLabel('HF Token（未设置；Gated 模型需要）')).toHaveValue('')
    // 空输入时不能保存 Token，避免误点清空已有凭据；清除必须走独立按钮（未设置时禁用）。
    await expect(win.getByRole('button', { name: '保存 Token' })).toBeDisabled()
    await expect(win.getByRole('button', { name: '清除 Token' })).toBeDisabled()
    await expect(win.getByText('暂无下载任务。')).toBeVisible()
  })
})

test('offers a GPU selector when the runtime reports multiple devices', async () => {
  await withApp(
    PORTS.gpu,
    async (win) => {
      await win.getByRole('link', { name: '本地模型' }).click()
      const select = win.getByLabel('使用显卡（下次加载模型生效）')
      await expect(select).toBeVisible()
      // 预置的选择必须回显，选项来自 `--list-devices` 的设备行。
      await expect(select).toHaveValue('Vulkan1')
      expect(await select.locator('option').allTextContents()).toEqual([
        '自动（llama.cpp 默认）',
        'AMD Radeon RX 7900 XTX (24560 MiB)',
        'AMD Radeon(TM) Graphics (1024 MiB)'
      ])

      // 选中即保存，主进程推送的新快照必须立刻回显。
      await select.selectOption('Vulkan0')
      await expect(select).toHaveValue('Vulkan0')
    },
    seedTwoGpuRuntime
  )
})

test('keeps local card widths consistent on wide and narrow windows', async () => {
  await withApp(PORTS.layout, async (win, app) => {
    await win.getByRole('link', { name: '本地模型' }).click()
    const box = async (name: string) => {
      const measured = await card(win, name).boundingBox()
      expect(measured).not.toBeNull()
      return measured!
    }

    await resize(win, app, 1440, 950)
    await win.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth > 1300)

    const hardware = await box('显卡与后端')
    const runtime = await box('运行状态')
    const models = await box('已安装模型')
    const settings = await box('本地设置')
    const hf = await box('HuggingFace 模型')
    const queue = await box('下载队列')

    // 宽屏两列：并排卡片等宽同顶；跨两列的卡片宽度等于两列加栅格间距（gap-4 = 16px）。
    expect(Math.abs(hardware.width - runtime.width)).toBeLessThan(1)
    expect(Math.abs(hardware.y - runtime.y)).toBeLessThan(1)
    expect(Math.abs(models.width - (hardware.width + runtime.width + 16))).toBeLessThan(2)
    expect(Math.abs(settings.width - models.width)).toBeLessThan(1)
    expect(Math.abs(hf.width - queue.width)).toBeLessThan(1)
    expect(Math.abs(hf.y - queue.y)).toBeLessThan(1)

    await resize(win, app, 960, 950)
    await win.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth < 1024)

    // 窄屏单列：所有卡片同宽，依次向下堆叠。
    const narrow = await Promise.all(['显卡与后端', '运行状态', '已安装模型', '本地设置', 'HuggingFace 模型', '下载队列'].map(box))
    for (const item of narrow) expect(Math.abs(item.width - narrow[0].width)).toBeLessThan(1)
    expect(narrow[1].y).toBeGreaterThanOrEqual(narrow[0].y + narrow[0].height)
    expect(narrow[5].y).toBeGreaterThanOrEqual(narrow[4].y + narrow[4].height)
  })
})
