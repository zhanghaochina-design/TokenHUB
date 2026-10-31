import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = '18790'

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

async function startFakeUpstream(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    req.resume()
    const send = (payload: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.url === '/v1/models') {
      send({ data: [{ id: 'm' }] })
      return
    }
    if (req.url === '/v1/messages') {
      send({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'm',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 1 }
      })
      return
    }
    if (req.url === '/v1/chat/completions') {
      send({
        id: 'chat-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

test('scans provider protocol compatibility and persists badges', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-e2e-'))
  const upstream = await startFakeUpstream()
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    const win = await app.firstWindow()

    await win.getByRole('link', { name: '供应商', exact: true }).click()
    await win.getByRole('button', { name: '添加供应商' }).click()
    await win.getByLabel('预设').selectOption('custom')
    await win.getByLabel('名称').fill('Fake Upstream')
    await win.getByLabel('Base URL', { exact: true }).fill(`${upstream.url}/v1`)
    await win.getByLabel('API Key').fill('sk-test')
    await win.getByLabel('手动模型').fill('m')
    await win.getByRole('button', { name: '保存' }).click()
    await expect(win.getByRole('list', { name: '供应商列表' }).getByText('Fake Upstream')).toBeVisible()

    // 扫描确认框是原生 confirm；测试里直接放行，避免阻塞。
    await win.evaluate(() => {
      ;(globalThis as unknown as { confirm: () => boolean }).confirm = () => true
    })
    await win.getByRole('link', { name: '模型', exact: true }).click()
    const scanList = win.getByRole('list', { name: '供应商兼容性扫描' })
    await scanList.getByRole('listitem').filter({ hasText: 'Fake Upstream' }).getByRole('button', { name: '扫描' }).click()

    const dialog = win.getByRole('dialog', { name: /调用方式兼容性结果：Fake Upstream/ })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByText('m', { exact: true })).toBeVisible()
    await expect(dialog.locator('tbody').getByText('可用')).toHaveCount(2)
    await dialog.getByRole('button', { name: '关闭兼容性结果' }).click()

    await expect(scanList.getByText(/已扫描 1\/1/)).toBeVisible()
    await expect(win.getByText('A✓')).toBeVisible()
    await expect(win.getByText('O✓')).toBeVisible()

    const saved = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as {
      providers: Array<{ protocolSupport?: Record<string, { anthropic: boolean | null; openai: boolean | null }> }>
    }
    expect(saved.providers[0].protocolSupport?.m).toMatchObject({ anthropic: true, openai: true })
  } finally {
    await app?.close()
    await upstream.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
