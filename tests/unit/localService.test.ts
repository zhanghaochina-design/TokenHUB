import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCAL_SETTINGS } from '../../core/local/settings'
import { LocalService, defaultInstallerPorts, type RuntimeProbe } from '../../core/local/service'
import type { LocalRuntimeStatus, LocalSnapshot, RuntimeInstall } from '../../core/local/types'

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

type SyncRecord = {
  baseUrl: string
  models: string[]
  meta?: Record<string, { contextLength?: number | null; vision?: boolean | null }>
}

interface HarnessOptions {
  /** 相对 modelsDir 的模型文件，父目录自动创建。 */
  files?: string[]
  installs?: RuntimeInstall[]
  hfToken?: string | null
  /** 模拟 llama-server 启动失败：load 不改变状态，服务必须把供应商模型清空。 */
  loadFails?: boolean
  /** 模拟安装被运行时自检拒绝（如 CUDA 包缺 cudart）。 */
  installFails?: boolean
  onSnapshot?: (snapshot: LocalSnapshot) => void
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

  const synced: SyncRecord[] = []
  const state = {
    loaded: false,
    modelId: null as string | null,
    contextLength: null as number | null,
    hfToken: options.hfToken ?? null,
    // null 表示按 loaded 推导；显式值用于模拟「runtime 还记着 modelId，但进程已经停了」。
    phase: null as LocalRuntimeStatus['phase'] | null
  }
  let onExit: (() => void) | null = null

  const service = await LocalService.open({
    dataDir,
    modelsDirOverride: modelsDir,
    hub: {
      syncLocalProvider: async (input) => {
        synced.push({ baseUrl: input.baseUrl, models: input.models, meta: input.meta })
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
      install: async () => {
        if (options.installFails) throw new Error('llama-server --version 失败（退出码 3221225781）')
        return install
      },
      importZip: async () => install,
      remove: async () => {},
      getExe: async () => install,
      listInstalled: async () => options.installs ?? [install]
    },
    runtime: {
      getStatus: () =>
        idleStatus({
          phase: state.phase ?? (state.loaded ? 'running' : 'stopped'),
          modelId: state.modelId,
          backend: state.loaded ? 'vulkan' : null,
          port: state.loaded ? 8788 : null,
          contextLength: state.contextLength
        }),
      load: async (model, _backend, contextSize) => {
        if (options.loadFails) return
        state.loaded = true
        state.modelId = model.modelId
        state.contextLength = contextSize
      },
      stop: async () => {
        state.loaded = false
        state.modelId = null
        state.contextLength = null
        state.phase = null
      },
      shutdown: async () => {
        state.loaded = false
        state.modelId = null
        state.contextLength = null
        state.phase = null
      },
      setOnExit: (cb) => {
        onExit = cb
      }
    },
    onSnapshot: options.onSnapshot,
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
    expect(synced.at(-1)).toMatchObject({ baseUrl: 'http://127.0.0.1:8788/v1', models: ['Qwen3-8B-Q4_K_M'] })
    expect(service.getSnapshot().models[0].loaded).toBe(true)
    await service.stopModel()
    expect(synced.at(-1)).toEqual({ baseUrl: 'http://127.0.0.1:8788/v1', models: [] })
    expect(service.getSnapshot().models[0].loaded).toBe(false)
    await service.shutdown()
  })

  it('sends the runtime-reported context and vision=false as sync meta', async () => {
    const { service, synced } = await createHarness({ files: ['Qwen3-8B-Q4_K_M.gguf'] })

    await service.loadModel('Qwen3-8B-Q4_K_M', 4096)

    expect(synced.at(-1)).toEqual({
      baseUrl: 'http://127.0.0.1:8788/v1',
      models: ['Qwen3-8B-Q4_K_M'],
      meta: { 'Qwen3-8B-Q4_K_M': { contextLength: 4096, vision: false } }
    })
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

  it('re-points the provider on a port change even when idle', async () => {
    const { service, synced, state } = await createHarness({ files: ['Qwen3-8B-Q4_K_M.gguf'] })
    expect(state.loaded).toBe(false)
    const before = synced.length

    await service.updateSettings({ localPort: 9001 })

    // 空闲时没有 stopModel 的副作用可依赖：新 baseUrl 必须由 updateSettings 自己同步一次。
    expect(synced.length).toBe(before + 1)
    expect(synced.at(-1)).toEqual({ baseUrl: 'http://127.0.0.1:9001/v1', models: [] })
    expect(service.getSnapshot().settings.localPort).toBe(9001)
  })

  it('stops the running model when the port changes', async () => {
    const { service, state } = await createHarness({ files: ['Qwen3-8B-Q4_K_M.gguf'] })
    await service.loadModel('Qwen3-8B-Q4_K_M')
    expect(state.loaded).toBe(true)

    await service.updateSettings({ localPort: 9001 })

    expect(state.loaded).toBe(false)
    expect(service.getSnapshot().models[0].loaded).toBe(false)
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

  it('marks a model loaded only while the runtime is running', async () => {
    const { service, state } = await createHarness({ files: ['Qwen3-8B-Q4_K_M.gguf'] })
    // runtime 还记着 modelId（如崩溃后），但进程没在跑：不能把卡片点亮。
    state.modelId = 'Qwen3-8B-Q4_K_M'
    state.phase = 'stopped'
    await service.refreshModels()
    expect(service.getSnapshot().models[0].loaded).toBe(false)

    state.phase = 'running'
    await service.refreshModels()
    expect(service.getSnapshot().models[0].loaded).toBe(true)
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

  it('keeps the previous runtime when the installer rejects a broken package', async () => {
    const { service } = await createHarness({ files: [], installFails: true })
    const before = service.getSnapshot().install
    expect(before).toMatchObject({ backend: 'vulkan', tag: 'b1' })

    await expect(service.installRuntime('vulkan')).rejects.toThrow('3221225781')

    expect(service.getSnapshot().install).toEqual(before)
    expect(service.getSnapshot().installProgress ?? null).toBeNull()
  })

  it('lets callers subscribe after open() resolves', async () => {
    const { service } = await createHarness({ files: ['Qwen3-8B-Q4_K_M.gguf'] })
    const received: LocalSnapshot[] = []

    service.setOnSnapshot((snapshot) => received.push(snapshot))
    const snapshot = await service.detectHardware()

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(snapshot)
  })

  it('keeps the constructor snapshot callback until it is replaced', async () => {
    const early: LocalSnapshot[] = []
    const { service } = await createHarness({ files: [], onSnapshot: (snapshot) => early.push(snapshot) })
    // open() 期间 init() 已经在广播，构造参数能收到那一段快照。
    const earlyCount = early.length
    expect(earlyCount).toBeGreaterThan(0)

    const late: LocalSnapshot[] = []
    service.setOnSnapshot((snapshot) => late.push(snapshot))
    await service.detectHardware()

    expect(early).toHaveLength(earlyCount)
    expect(late).toHaveLength(1)
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

  it('falls back to default settings when local.json is zero-length', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-local-'))
    // 写到一半崩溃会留下零长度文件：必须按默认设置启动，而不是抛错或读到半截 JSON。
    await writeFile(join(dataDir, 'local.json'), '')

    const service = await LocalService.open({
      dataDir,
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

    expect(service.getSnapshot().settings).toEqual(DEFAULT_LOCAL_SETTINGS)
    await service.shutdown()
  })
})

describe('defaultInstallerPorts.validate', () => {
  const portsWith = (probe: RuntimeProbe) => defaultInstallerPorts(async () => new Response(''), probe)

  it('runs --version before --list-devices and keeps the device lines', async () => {
    const calls: string[] = []
    const ports = portsWith(async (_exe, flag) => {
      calls.push(flag)
      return flag === '--version'
        ? { ok: true, exitCode: 0, output: 'version: 7000 (abc)' }
        : { ok: true, exitCode: 0, output: 'Vulkan0: AMD Radeon RX 7900 XTX\n\n  Vulkan1: Intel Arc  \n' }
    })

    await expect(ports.validate('C:/rt/llama-server.exe')).resolves.toEqual([
      'Vulkan0: AMD Radeon RX 7900 XTX',
      'Vulkan1: Intel Arc'
    ])
    expect(calls).toEqual(['--version', '--list-devices'])
  })

  it('rejects with the exit code and output when --version fails', async () => {
    const ports = portsWith(async (_exe, flag) =>
      flag === '--version'
        ? { ok: false, exitCode: 3221225781, output: 'cudart64_12.dll was not found' }
        : { ok: true, exitCode: 0, output: 'Vulkan0: AMD Radeon' }
    )

    await expect(ports.validate('C:/rt/llama-server.exe')).rejects.toThrow(
      /--version 失败（退出码 3221225781）：cudart64_12\.dll was not found/
    )
  })

  it('rejects an empty --version or a failing/empty --list-devices', async () => {
    const silentVersion = portsWith(async () => ({ ok: true, exitCode: 0, output: '' }))
    await expect(silentVersion.validate('C:/rt/llama-server.exe')).rejects.toThrow('--version 没有输出')

    const failingDevices = portsWith(async (_exe, flag) =>
      flag === '--version'
        ? { ok: true, exitCode: 0, output: 'version: 7000' }
        : { ok: false, exitCode: 1, output: 'no devices' }
    )
    await expect(failingDevices.validate('C:/rt/llama-server.exe')).rejects.toThrow(
      '--list-devices 失败（退出码 1）：no devices'
    )

    const emptyDevices = portsWith(async (_exe, flag) =>
      flag === '--version' ? { ok: true, exitCode: 0, output: 'version: 7000' } : { ok: true, exitCode: 0, output: '' }
    )
    await expect(emptyDevices.validate('C:/rt/llama-server.exe')).rejects.toThrow('没有输出设备列表')
  })
})