import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalService } from '../../core/local/service'
import type { LocalRuntimeStatus, RuntimeInstall } from '../../core/local/types'

const install: RuntimeInstall = {
  backend: 'vulkan',
  tag: 'b1',
  installedAt: '2026-01-01T00:00:00.000Z',
  devices: ['Vulkan0: AMD Radeon RX 7900 XTX'],
  sourceUrl: 'x',
  exePath: 'C:/rt/llama-server.exe'
}

function idleStatus(overrides: Partial<LocalRuntimeStatus> = {}): LocalRuntimeStatus {
  return {
    phase: 'stopped',
    backend: null,
    tag: null,
    modelId: null,
    modelPath: null,
    port: null,
    contextLength: null,
    error: null,
    logTail: [],
    startedAt: null,
    ...overrides
  }
}

interface HarnessOptions {
  /** 相对 modelsDir 的模型文件，父目录自动创建。 */
  files?: string[]
  installs?: RuntimeInstall[]
  hfToken?: string | null
  /** 模拟 llama-server 启动失败：load 不改变状态，服务必须把供应商模型清空。 */
  loadFails?: boolean
}

async function createHarness(options: HarnessOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-local-'))
  const modelsDir = join(dataDir, 'models')
  await mkdir(modelsDir, { recursive: true })
  for (const file of options.files ?? []) {
    const full = join(modelsDir, file)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, 'gguf')
  }

  const synced: Array<{ baseUrl: string; models: string[] }> = []
  const state = { loaded: false, modelId: null as string | null, hfToken: options.hfToken ?? null }
  let onExit: (() => void) | null = null

  const service = await LocalService.open({
    dataDir,
    modelsDirOverride: modelsDir,
    hub: {
      syncLocalProvider: async (input) => {
        synced.push({ baseUrl: input.baseUrl, models: input.models })
      }
    },
    secrets: {
      getHfToken: () => state.hfToken,
      hasHfToken: () => Boolean(state.hfToken),
      setHfToken: async (token) => {
        state.hfToken = token
      }
    },
    logger: { info: async () => {}, warn: async () => {}, error: async () => {} },
    detect: async () => ({ gpus: [], recommendedBackend: 'vulkan', detectedAt: '2026-01-01T00:00:00.000Z' }),
    installer: {
      install: async () => install,
      importZip: async () => install,
      remove: async () => {},
      getExe: async () => install,
      listInstalled: async () => options.installs ?? [install]
    },
    runtime: {
      getStatus: () =>
        idleStatus({
          phase: state.loaded ? 'running' : 'stopped',
          modelId: state.loaded ? state.modelId : null,
          port: 8788,
          contextLength: 8192
        }),
      load: async (model) => {
        if (options.loadFails) return
        state.loaded = true
        state.modelId = model.modelId
      },
      stop: async () => {
        state.loaded = false
        state.modelId = null
      },
      shutdown: async () => {
        state.loaded = false
        state.modelId = null
      },
      setOnExit: (cb) => {
        onExit = cb
      }
    },
    now: () => new Date('2026-01-01T00:00:00.000Z')
  })

  return { service, synced, state, modelsDir, dataDir, triggerExit: () => onExit?.() }
}

describe('LocalService', () => {
  it('loads an installed model, syncs the hub and clears it on stop', async () => {
    const { service, synced, state } = await createHarness({ files: ['Qwen3-8B-Q4_K_M.gguf'] })

    expect(service.getSnapshot().models.map((model) => model.id)).toEqual(['Qwen3-8B-Q4_K_M'])
    await service.loadModel('Qwen3-8B-Q4_K_M')
    expect(state.loaded).toBe(true)
    expect(synced.at(-1)).toEqual({ baseUrl: 'http://127.0.0.1:8788/v1', models: ['Qwen3-8B-Q4_K_M'] })
    expect(service.getSnapshot().models[0].loaded).toBe(true)
    await service.stopModel()
    expect(synced.at(-1)).toEqual({ baseUrl: 'http://127.0.0.1:8788/v1', models: [] })
    expect(service.getSnapshot().models[0].loaded).toBe(false)
    await service.shutdown()
  })

  it('deletes every shard of a split model and keeps untouched files', async () => {
    const { service, modelsDir } = await createHarness({
      files: [
        'Org/Repo/Big-Q4_K_M-00001-of-00002.gguf',
        'Org/Repo/Big-Q4_K_M-00002-of-00002.gguf',
        'Keep-Q8_0.gguf'
      ]
    })
    expect(service.getSnapshot().models.map((model) => model.id)).toEqual(['Big-Q4_K_M', 'Keep-Q8_0'])

    await service.deleteModel('Big-Q4_K_M')

    expect(await readdir(join(modelsDir, 'Org', 'Repo'))).toEqual([])
    expect(service.getSnapshot().models.map((model) => model.id)).toEqual(['Keep-Q8_0'])
  })

  it('rejects an unknown model id and a delete of a missing model', async () => {
    const { service } = await createHarness({ files: ['Qwen3-8B-Q4_K_M.gguf'] })
    await expect(service.loadModel('nope')).rejects.toThrow('unknown local model: nope')
    await expect(service.deleteModel('nope')).rejects.toThrow('unknown local model: nope')
  })

  it('refuses to load when no runtime is installed', async () => {
    const { service } = await createHarness({ files: ['Qwen3-8B-Q4_K_M.gguf'], installs: [] })
    await expect(service.loadModel('Qwen3-8B-Q4_K_M')).rejects.toThrow('请先安装 llama.cpp 运行时')
  })

  it('stops the running model and re-points the provider when the port changes', async () => {
    const { service, synced, state } = await createHarness({ files: ['Qwen3-8B-Q4_K_M.gguf'] })
    await service.loadModel('Qwen3-8B-Q4_K_M')
    expect(state.loaded).toBe(true)

    await service.updateSettings({ localPort: 9999 })

    expect(state.loaded).toBe(false)
    // 端口变了以后 provider 不能再指向旧端口：即使没有模型在跑也要同步一次新 baseUrl。
    expect(synced.at(-1)).toEqual({ baseUrl: 'http://127.0.0.1:9999/v1', models: [] })
    expect(service.getSnapshot().settings.localPort).toBe(9999)
  })

  it('clears the provider when a load attempt fails and when llama-server exits', async () => {
    const failing = await createHarness({ files: ['Qwen3-8B-Q4_K_M.gguf'], loadFails: true })
    const before = failing.synced.length
    await failing.service.loadModel('Qwen3-8B-Q4_K_M')
    expect(failing.synced.length).toBe(before + 1)
    expect(failing.synced.at(-1)).toEqual({ baseUrl: 'http://127.0.0.1:8788/v1', models: [] })
    expect(failing.service.getSnapshot().models[0].loaded).toBe(false)

    const crashing = await createHarness({ files: ['Qwen3-8B-Q4_K_M.gguf'] })
    await crashing.service.loadModel('Qwen3-8B-Q4_K_M')
    crashing.state.loaded = false
    const count = crashing.synced.length
    crashing.triggerExit()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(crashing.synced.length).toBe(count + 1)
    expect(crashing.synced.at(-1)).toEqual({ baseUrl: 'http://127.0.0.1:8788/v1', models: [] })
    expect(crashing.service.getSnapshot().models[0].loaded).toBe(false)
  })

  it('mirrors the HF token state and the install progress in the snapshot', async () => {
    const { service, state } = await createHarness({ files: [] })
    const initial = service.getSnapshot()
    expect(initial.hfTokenSet).toBe(false)
    expect(initial.installProgress ?? null).toBeNull()
    expect(initial.install).toMatchObject({ backend: 'vulkan' })
    expect(initial.models).toEqual([])

    await service.setHfToken('hf_abc')

    expect(state.hfToken).toBe('hf_abc')
    expect(service.getSnapshot().hfTokenSet).toBe(true)
  })

  it('installs a runtime and reports the resolved install', async () => {
    const { service } = await createHarness({ files: [], installs: [] })
    expect(service.getSnapshot().install).toBeNull()
    const snapshot = await service.installRuntime()
    expect(snapshot.install).toMatchObject({ backend: 'vulkan', tag: 'b1' })
    expect(snapshot.installProgress ?? null).toBeNull()
  })

  it('persists settings and can hand them back', async () => {
    const { service, dataDir } = await createHarness({ files: [] })
    await service.updateSettings({ defaultContext: 4096, githubMirror: 'https://ghfast.top' })
    expect(service.getSettings()).toMatchObject({ defaultContext: 4096, githubMirror: 'https://ghfast.top' })
    const reopened = await LocalService.open({
      dataDir,
      modelsDirOverride: join(dataDir, 'models'),
      hub: { syncLocalProvider: async () => {} },
      secrets: { getHfToken: () => null, hasHfToken: () => false, setHfToken: async () => {} },
      installer: {
        install: async () => install,
        importZip: async () => install,
        remove: async () => {},
        getExe: async () => install,
        listInstalled: async () => []
      },
      runtime: {
        getStatus: () => idleStatus(),
        load: async () => {},
        stop: async () => {},
        shutdown: async () => {},
        setOnExit: () => {}
      },
      detect: async () => ({ gpus: [], recommendedBackend: 'cpu', detectedAt: '' })
    })
    expect(reopened.getSettings()).toMatchObject({ defaultContext: 4096, githubMirror: 'https://ghfast.top' })
    expect(reopened.getModelsDir()).toBe(join(dataDir, 'models'))
  })
})