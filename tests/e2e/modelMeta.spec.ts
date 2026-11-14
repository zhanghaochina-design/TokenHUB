import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = '18793'
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
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: 'p1',
          name: 'Provider A',
          preset: 'custom',
          baseUrl: 'https://p1.example/v1',
          quotaAdapter: 'none',
          enabled: true,
          models: { cached: ['claude-sonnet-4-5', 'plain-model'], manual: [], lastSyncedAt: new Date().toISOString() },
          quota: { lowBalanceThreshold: 0.5, quotaCooldownMs: 18_000_000, injectStreamUsage: true }
        }
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

async function modelEntry(id: string): Promise<{ context_length: number | null; capabilities: { vision: boolean | null } } | undefined> {
  try {
    const response = await fetch(MODELS_URL)
    const body = (await response.json()) as {
      data?: Array<{ id: string; context_length: number | null; capabilities: { vision: boolean | null } }>
    }
    return (body.data ?? []).find((model) => model.id === id)
  } catch {
    return undefined
  }
}

test('edits model metadata and restores the automatic value', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-e2e-meta-'))
  seedConfig(dataDir)
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    const win = await app.firstWindow()
    await expect.poll(() => modelEntry('claude-sonnet-4-5'), { timeout: 15_000 }).toMatchObject({ context_length: 200_000 })

    await win.getByRole('link', { name: '模型' }).click()
    const modelList = win.getByRole('list', { name: '模型列表', exact: true })
    await expect(modelList.getByText('200K', { exact: true })).toBeVisible()
    await expect(modelList.getByText('视觉', { exact: true })).toBeVisible()
    await expect(modelList.getByText('上下文未标注', { exact: true })).toBeVisible()

    await win.getByRole('button', { name: '编辑 Provider A / claude-sonnet-4-5 元数据' }).click()
    const dialog = win.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await win.getByLabel('上下文长度').fill('123456')
    await win.getByLabel('视觉支持').selectOption('false')
    await win.getByLabel('思考参数').selectOption('custom')
    await win.getByLabel('原生参数名').fill('reasoning_effort')
    await win.getByLabel('可选值').fill('low, high')
    await win.getByRole('button', { name: '保存元数据' }).click()

    await expect(modelList.getByText('123.5K', { exact: true })).toBeVisible()
    await expect(modelList.getByText('无视觉', { exact: true })).toBeVisible()
    await expect(modelList.getByText('reasoning_effort: low / high', { exact: true })).toBeVisible()
    await expect.poll(() => modelEntry('claude-sonnet-4-5'), { timeout: 10_000 }).toMatchObject({
      context_length: 123456,
      capabilities: { vision: false }
    })

    await win.getByRole('button', { name: '编辑 Provider A / claude-sonnet-4-5 元数据' }).click()
    await win.getByRole('button', { name: '恢复自动值' }).click()
    await expect(modelList.getByText('200K', { exact: true })).toBeVisible()
    await expect.poll(() => modelEntry('claude-sonnet-4-5'), { timeout: 10_000 }).toMatchObject({ context_length: 200_000 })

    await win.waitForTimeout(200)
    await win.screenshot({ path: 'out/model-meta.png' })
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})