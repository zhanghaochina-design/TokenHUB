import { _electron as electron } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DATA = join(ROOT, 'out', 'readme-demo-data')
const SHOTS = join(ROOT, 'out', 'readme-raw')
const FINAL = join(HERE, 'assets')
const PORT = '18799'

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })
rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(FINAL, { recursive: true })

const now = new Date()
const iso = (date) => date.toISOString()
const dayKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const providerBase = {
  enabled: true,
  models: { cached: [], manual: [], lastSyncedAt: now.toISOString() },
  quota: { lowBalanceThreshold: 0.5, quotaCooldownMs: 5 * 60 * 60 * 1000, injectStreamUsage: true }
}
const support = (anthropic, openai, checkedAt) => ({ anthropic, openai, checkedAt })

const providers = [
  {
    ...providerBase,
    id: 'p-open',
    name: 'OpenCode Go',
    preset: 'opencode-go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    quotaAdapter: 'opencode-go',
    models: {
      cached: ['claude-sonnet-4-5', 'claude-opus-4-1', 'deepseek-v4.1-flash', 'qwen3-coder'],
      manual: [],
      lastSyncedAt: now.toISOString()
    },
    protocolSupport: {
      'claude-sonnet-4-5': support(true, true, now.toISOString()),
      'claude-opus-4-1': support(true, true, now.toISOString()),
      'deepseek-v4.1-flash': support(true, true, now.toISOString()),
      'qwen3-coder': support(false, true, now.toISOString())
    }
  },
  {
    ...providerBase,
    id: 'p-cc',
    name: 'CommandCode Goat',
    preset: 'commandcode',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    quotaAdapter: 'none',
    models: {
      cached: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'glm-5.1'],
      manual: [],
      lastSyncedAt: now.toISOString()
    },
    protocolSupport: {
      'claude-sonnet-4-5': support(true, false, now.toISOString()),
      'claude-haiku-4-5': support(true, false, now.toISOString()),
      'glm-5.1': support(false, true, now.toISOString())
    }
  },
  {
    ...providerBase,
    id: 'p-ds',
    name: 'DeepSeek',
    preset: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    quotaAdapter: 'deepseek-balance',
    models: {
      cached: ['deepseek-chat', 'deepseek-reasoner'],
      manual: [],
      lastSyncedAt: now.toISOString()
    },
    protocolSupport: {
      'deepseek-chat': support(false, true, now.toISOString()),
      'deepseek-reasoner': support(false, true, now.toISOString())
    }
  }
]

const config = {
  version: 1,
  providers,
  modelAliases: [
    {
      id: 'claude-sonnet-4-5',
      targets: [
        { providerId: 'p-open', upstreamModel: 'claude-sonnet-4-5' },
        { providerId: 'p-cc', upstreamModel: 'claude-sonnet-4-5' }
      ]
    }
  ],
  settings: {
    port: 18799,
    localKeyEnabled: false,
    autoStart: false,
    startMinimized: false,
    closeToTray: true,
    retentionDays: 30,
    quotaRefreshSec: 60
  }
}

const inHours = (hours) => iso(new Date(now.getTime() + hours * 3600_000))
const quotaCache = {
  'p-open': {
    providerId: 'p-open',
    availability: 'ok',
    windows: {
      rolling: { percent: 36, status: 'ok', resetsAt: inHours(2) },
      weekly: { percent: 58, status: 'ok', resetsAt: inHours(72) },
      monthly: { percent: 72, status: 'ok', resetsAt: inHours(432) }
    },
    source: 'probe',
    fetchedAt: iso(now)
  },
  'p-ds': {
    providerId: 'p-ds',
    availability: 'ok',
    balance: { amount: 42.18, currency: 'USD' },
    source: 'probe',
    fetchedAt: iso(now)
  }
}

const rows = [
  ['p-open', 'claude-sonnet-4-5', 'anthropic', true, true, 1820, 640, 2380, 610, null, []],
  ['p-ds', 'deepseek-chat', 'openai', true, true, 940, 380, 1740, 420, null, []],
  ['p-cc', 'glm-5.1', 'openai', false, true, 1260, 540, 3120, null, null, []],
  ['p-cc', 'claude-sonnet-4-5', 'anthropic', true, true, 2140, 720, 2860, 830, null, ['p-open']],
  ['p-ds', 'deepseek-reasoner', 'openai', true, false, null, null, 1530, null, 'rate_limit', []],
  ['p-open', 'claude-opus-4-1', 'anthropic', false, true, 3200, 980, 4420, null, null, []],
  ['p-ds', 'deepseek-chat', 'openai', true, true, 760, 300, 1380, 360, null, []],
  ['p-open', 'qwen3-coder', 'openai', true, false, null, null, 2680, null, 'transient', []],
  ['p-cc', 'claude-haiku-4-5', 'anthropic', true, true, 680, 240, 1120, 310, null, []],
  ['p-ds', 'deepseek-reasoner', 'openai', false, true, 1450, 860, 5240, null, null, []],
  ['p-open', 'claude-sonnet-4-5', 'anthropic', true, true, 1980, 700, 2560, 590, null, []],
  ['p-cc', 'glm-5.1', 'openai', true, true, 1120, 460, 2210, 480, null, []],
  ['p-open', 'qwen3-coder', 'openai', false, true, 880, 420, 1640, null, null, []],
  ['p-ds', 'deepseek-chat', 'openai', true, true, 1020, 390, 1870, 410, null, []]
]

const startOfDay = new Date(now)
startOfDay.setHours(0, 1, 0, 0)
const minutesAvailable = Math.max(10, Math.floor((now.getTime() - startOfDay.getTime()) / 60000) - 2)
const step = Math.max(1, Math.min(9, Math.floor(minutesAvailable / rows.length)))

const history = rows.reverse().map((row, index) => {
  const [providerId, model, protocol, stream, ok, promptTokens, completionTokens, latencyMs, firstByteMs, errorKind, failoverFrom] = row
  return {
    ts: iso(new Date(now.getTime() - (rows.length - 1 - index) * step * 60000)),
    requestId: `req_${String(5260 - index).padStart(4, '0')}`,
    protocol,
    model,
    providerId,
    upstreamModel: model,
    stream,
    httpStatus: ok ? 200 : errorKind === 'rate_limit' ? 429 : 502,
    outcome: ok ? 'ok' : 'error',
    promptTokens,
    completionTokens,
    latencyMs,
    firstByteMs,
    errorKind,
    failoverFrom
  }
})

mkdirSync(join(DATA, 'history'), { recursive: true })
writeFileSync(join(DATA, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
writeFileSync(join(DATA, 'quota-cache.json'), JSON.stringify(quotaCache, null, 2), 'utf8')
writeFileSync(
  join(DATA, 'history', `${dayKey(now)}.jsonl`),
  history.map((record) => JSON.stringify(record)).join('\n') + '\n',
  'utf8'
)

function launchEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') continue
    if (value !== undefined) env[key] = value
  }
  env.TOKENHUB_DATA_DIR = DATA
  env.TOKENHUB_PORT = PORT
  return env
}

let app
try {
  app = await electron.launch({ args: [ROOT], env: launchEnv() })
  const win = await app.firstWindow()
  await win.waitForSelector('h1')
  await win.addStyleTag({ content: '::-webkit-scrollbar{width:0!important;height:0!important}' })
  console.log('DPR:', await win.evaluate(() => window.devicePixelRatio))

  const ids = providers.map((provider) => provider.id)
  await win.evaluate(async (providerIds) => {
    for (const id of providerIds) {
      await window.tokenhub.updateProvider(id, { apiKey: `sk-demo-${id}-not-a-real-key` })
    }
    await window.tokenhub.setLocalKey('sk-tokenhub-demo-local')
    await window.tokenhub.resetProvider('p-cc')
  }, ids)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await win.evaluate((providerIds) => {
      const state = window.tokenhub.getState()
      return state.then((value) => providerIds.every((id) => value.providers.find((p) => p.id === id)?.hasKey))
    }, ids)
    if (ready) break
    await win.waitForTimeout(200)
  }

  const state = await win.evaluate(() => window.tokenhub.getState())
  console.log(
    'state:',
    state.providers.map((provider) => `${provider.name}=${provider.hasKey}`).join(', '),
    '| catalog:',
    state.catalog.length,
    '| stats:',
    JSON.stringify(state.stats)
  )

  async function resize(width, height) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const target = BrowserWindow.getAllWindows()[0]
        target.setContentSize(size.width, size.height)
        target.center()
      },
      { width, height }
    )
    await win.waitForTimeout(250)
  }

  async function go(hash) {
    await win.evaluate((value) => {
      window.location.hash = value
      document.querySelector('main')?.scrollTo(0, 0)
    }, hash)
    await win.waitForTimeout(450)
  }

  // 概览 + 最近请求
  await resize(1440, 900)
  await go('#overview')
  await win.screenshot({ path: join(SHOTS, 'overview.png') })
  const quotaSection = win.locator('section[aria-labelledby="quota-heading"]')
  await quotaSection.screenshot({ path: join(SHOTS, 'overview-quota.png') })
  const historySection = win.locator('section[aria-labelledby="history-heading"]')
  await historySection.scrollIntoViewIfNeeded()
  await win.waitForTimeout(200)
  const failoverRow = win
    .locator('tbody tr', { hasText: 'CommandCode Goat' })
    .filter({ hasText: 'claude-sonnet-4-5' })
    .first()
  await failoverRow.getByRole('button', { name: /展开请求/ }).click()
  await win.waitForTimeout(250)
  await historySection.screenshot({ path: join(SHOTS, 'history.png') })

  // 供应商列表 + 编辑对话框
  await resize(1440, 760)
  await go('#providers')
  await win.screenshot({ path: join(SHOTS, 'providers.png') })
  await win.getByRole('button', { name: '编辑 OpenCode Go' }).click()
  const providerDialog = win.getByRole('dialog')
  await providerDialog.waitFor()
  await win.waitForTimeout(250)
  await resize(1440, 1000)
  await providerDialog.screenshot({ path: join(SHOTS, 'provider-dialog.png') })
  await win.getByRole('button', { name: '关闭对话框' }).click()
  await win.waitForTimeout(200)

  // 模型：兼容性、统一模型、目录、扫描结果
  await resize(1440, 900)
  await go('#models')
  const compat = win.locator('section[aria-label="调用方式兼容性"]')
  await compat.screenshot({ path: join(SHOTS, 'models-compat.png') })
  const aliases = win.locator('section[aria-label="统一模型"]')
  await aliases.screenshot({ path: join(SHOTS, 'models-aliases.png') })
  const catalog = win.locator('section').filter({ has: win.getByRole('list', { name: '模型列表', exact: true }) })
  await catalog.screenshot({ path: join(SHOTS, 'models-catalog.png') })
  await win.getByRole('button', { name: '查看结果' }).first().click()
  const scanDialog = win.getByRole('dialog')
  await scanDialog.waitFor()
  await win.waitForTimeout(250)
  await scanDialog.locator('div').first().screenshot({ path: join(SHOTS, 'scan-dialog.png') })
  await win.getByRole('button', { name: '关闭兼容性结果' }).click()
  await win.waitForTimeout(200)

  // 设置：上半部分 + 连接信息
  await resize(1440, 1000)
  await go('#settings')
  await win.screenshot({ path: join(SHOTS, 'settings.png') })
  await win.locator('section[aria-labelledby="settings-connection-heading"]').screenshot({
    path: join(SHOTS, 'settings-connection.png')
  })

  // 若为 2x 截图，统一缩到 1600px 宽，兼顾清晰度与体积
  const files = [
    'overview.png',
    'overview-quota.png',
    'history.png',
    'providers.png',
    'provider-dialog.png',
    'models-compat.png',
    'models-aliases.png',
    'models-catalog.png',
    'scan-dialog.png',
    'settings.png',
    'settings-connection.png'
  ]
  for (const file of files) {
    const source = join(SHOTS, file)
    const base64 = await app.evaluate(({ nativeImage }, job) => {
      const image = nativeImage.createFromPath(job.path)
      const size = image.getSize()
      if (size.width <= job.width) return null
      return image.resize({ width: job.width, quality: 'best' }).toPNG().toString('base64')
    }, { path: source, width: 1600 })
    const target = join(FINAL, file)
    if (base64) writeFileSync(target, Buffer.from(base64, 'base64'))
    else writeFileSync(target, (await import('node:fs')).readFileSync(source))
    console.log('shot:', file)
  }
} finally {
  await app?.close().catch(() => {})
  rmSync(DATA, { recursive: true, force: true })
}
