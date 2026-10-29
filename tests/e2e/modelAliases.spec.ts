import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = '18792'
const CANONICAL = 'deepseek4.1flash'
const MODELS_URL = `http://127.0.0.1:${PORT}/v1/models`

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

function seedConfig(dataDir: string): void {
  const syncedAt = new Date().toISOString()
  const provider = (id: string, name: string, model: string) => ({
    id,
    name,
    preset: 'custom',
    baseUrl: `https://${id}.example/v1`,
    quotaAdapter: 'none',
    enabled: true,
    models: { cached: [model], manual: [], lastSyncedAt: syncedAt },
    quota: { lowBalanceThreshold: 0.5, quotaCooldownMs: 18_000_000, injectStreamUsage: true }
  })
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      version: 1,
      providers: [
        provider('p1', 'Provider A', 'deepseek-v4.1-flash'),
        provider('p2', 'Provider B', 'deepseek/deepseek-v4.1-flash')
      ],
      modelAliases: [],
      settings: {
        port: 8787,
        localKeyEnabled: false,
        autoStart: false,
        startMinimized: false,
        closeToTray: true,
        retentionDays: 30,
        quotaRefreshSec: 60
      }
    }),
    'utf8'
  )
}

async function modelIds(): Promise<string[]> {
  try {
    const response = await fetch(MODELS_URL)
    const body = (await response.json()) as { data?: Array<{ id: string }> }
    return (body.data ?? []).map((model) => model.id)
  } catch {
    return []
  }
}

test('creates a canonical model from the suggestion and hides raw ids', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-e2e-aliases-'))
  seedConfig(dataDir)
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    const win = await app.firstWindow()
    await expect.poll(() => modelIds(), { timeout: 15_000 }).toEqual([
      'deepseek-v4.1-flash',
      'deepseek/deepseek-v4.1-flash'
    ])

    await win.getByRole('link', { name: '模型' }).click()
    await expect(win.getByRole('heading', { name: '模型', exact: true })).toBeVisible()
    const modelList = win.getByRole('list', { name: '模型列表', exact: true })
    await expect(modelList.getByText('deepseek-v4.1-flash', { exact: true })).toBeVisible()
    await expect(modelList.getByText('deepseek/deepseek-v4.1-flash', { exact: true })).toBeVisible()

    await win.getByRole('button', { name: `创建统一模型 ${'deepseek-v4.1-flash'}` }).click()
    await expect(win.getByRole('dialog')).toBeVisible()
    await expect(win.getByLabel('统一模型 ID')).toHaveValue('deepseek-v4.1-flash')
    await win.getByLabel('统一模型 ID').fill(CANONICAL)
    await win.getByRole('button', { name: '保存统一模型' }).click()

    const aliasList = win.getByRole('list', { name: '统一模型列表', exact: true })
    await expect(aliasList.getByText(CANONICAL, { exact: true })).toBeVisible()
    await expect(modelList.getByText(CANONICAL, { exact: true })).toBeVisible()
    await expect(modelList.getByText('deepseek-v4.1-flash', { exact: true })).toHaveCount(0)
    await expect(modelList.getByText('deepseek/deepseek-v4.1-flash', { exact: true })).toHaveCount(0)
    await expect.poll(() => modelIds(), { timeout: 10_000 }).toEqual([CANONICAL])

    await win.waitForTimeout(200)
    await win.screenshot({ path: 'out/model-aliases.png' })
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
