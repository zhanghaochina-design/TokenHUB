import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RuntimeInstaller,
  assetNamesFor,
  mirroredUrl,
  selectRuntimeRelease,
  type InstallerPorts,
  type ReleaseInfo,
  type RuntimeInstallerOptions
} from '../../core/local/runtimeInstaller'

const releases: ReleaseInfo[] = [
  { tag_name: 'v1.0.0', assets: [{ name: 'nightly-tag.txt', browser_download_url: 'https://x/nightly' }] },
  {
    tag_name: 'b12627',
    assets: [
      { name: 'llama-b12627-bin-win-vulkan-x64.zip', browser_download_url: 'https://x/vulkan.zip' },
      { name: 'llama-b12627-bin-win-cuda-12.4-x64.zip', browser_download_url: 'https://x/cuda.zip' },
      { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', browser_download_url: 'https://x/cudart.zip' },
      { name: 'llama-b12627-bin-win-cpu-x64.zip', browser_download_url: 'https://x/cpu.zip' }
    ]
  }
]

describe('runtime assets', () => {
  it('picks the newest release that actually has the backend assets', () => {
    const vulkan = selectRuntimeRelease(releases, 'vulkan')
    expect(vulkan?.tag).toBe('b12627')
    expect(vulkan?.assets.map((asset) => asset.name)).toEqual(['llama-b12627-bin-win-vulkan-x64.zip'])
    const cuda = selectRuntimeRelease(releases, 'cuda')
    expect(cuda?.assets.map((asset) => asset.name)).toEqual([
      'llama-b12627-bin-win-cuda-12.4-x64.zip',
      'cudart-llama-bin-win-cuda-12.4-x64.zip'
    ])
    expect(selectRuntimeRelease(releases, 'rocm')).toBeNull()
  })

  it('builds asset names per backend and applies a mirror prefix', () => {
    expect(assetNamesFor('vulkan', 'b1')).toEqual(['llama-b1-bin-win-vulkan-x64.zip'])
    expect(assetNamesFor('cuda', 'b1')).toEqual([
      'llama-b1-bin-win-cuda-12.4-x64.zip',
      'cudart-llama-bin-win-cuda-12.4-x64.zip'
    ])
    expect(mirroredUrl('https://github.com/a.zip', 'https://ghfast.top/')).toBe('https://ghfast.top/https://github.com/a.zip')
    expect(mirroredUrl('https://github.com/a.zip', '')).toBe('https://github.com/a.zip')
  })
})

// —— 测试脚手架：全部走注入端口，不发真实网络请求 ——

const okDownload: InstallerPorts['download'] = async ({ dest }) => {
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, 'zip')
}

const okExtract: InstallerPorts['extract'] = async (_zipPath, destDir) => {
  await mkdir(destDir, { recursive: true })
  await writeFile(join(destDir, 'llama-server.exe'), 'exe')
}

const okValidate: InstallerPorts['validate'] = async () => ['Vulkan0: AMD Radeon RX 7900 XTX (24576 MiB)']

async function tempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tokenhub-runtime-'))
}

// 与 RuntimeInstaller 的目录约定一致：<dataDir>/local/runtime/<backend>/<tag>
function runtimeDir(dataDir: string, backend: string, tag: string): string {
  return join(dataDir, 'local', 'runtime', backend, tag)
}

function makeInstaller(
  dataDir: string,
  overrides: Partial<InstallerPorts> = {},
  options: Partial<RuntimeInstallerOptions> = {}
): RuntimeInstaller {
  return new RuntimeInstaller({
    dataDir,
    ports: { download: okDownload, extract: okExtract, validate: okValidate, ...overrides },
    fetchFn: async () => new Response(JSON.stringify(releases), { status: 200 }),
    mirror: () => '',
    now: () => new Date('2026-11-22T00:00:00.000Z'),
    ...options
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('RuntimeInstaller', () => {
  it('downloads, extracts, validates and records an install', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tokenhub-runtime-'))
    const downloads: string[] = []
    const ports: InstallerPorts = {
      download: async ({ url, dest }) => {
        downloads.push(url)
        await import('node:fs/promises').then((fs) => fs.mkdir(join(dest, '..'), { recursive: true }))
        await import('node:fs/promises').then((fs) => fs.writeFile(dest, 'zip'))
      },
      extract: async (_zipPath, destDir) => {
        const fs = await import('node:fs/promises')
        await fs.mkdir(destDir, { recursive: true })
        await fs.writeFile(join(destDir, 'llama-server.exe'), 'exe')
      },
      validate: async () => ['Vulkan0: AMD Radeon RX 7900 XTX (24576 MiB)']
    }
    const installer = new RuntimeInstaller({
      dataDir,
      ports,
      fetchFn: async () => new Response(JSON.stringify(releases), { status: 200 }),
      mirror: () => '',
      now: () => new Date('2026-11-22T00:00:00.000Z')
    })
    const install = await installer.install('vulkan')
    expect(install).toMatchObject({
      backend: 'vulkan',
      tag: 'b12627',
      devices: ['Vulkan0: AMD Radeon RX 7900 XTX (24576 MiB)'],
      installedAt: '2026-11-22T00:00:00.000Z'
    })
    expect(downloads).toEqual(['https://x/vulkan.zip'])
    expect(await readFile(install.exePath, 'utf8')).toBe('exe')
    expect(await installer.getExe('vulkan')).toMatchObject({ backend: 'vulkan', tag: 'b12627' })
  })

  it('reports per-asset download progress and forwards the abort signal', async () => {
    const dataDir = await tempDataDir()
    const controller = new AbortController()
    const progress: unknown[] = []
    const signals: Array<AbortSignal | undefined> = []
    const installer = makeInstaller(
      dataDir,
      {
        download: async ({ dest, onProgress, signal }) => {
          signals.push(signal)
          await mkdir(dirname(dest), { recursive: true })
          await writeFile(dest, 'zip')
          onProgress?.(5, 10)
          onProgress?.(10, 10)
        }
      },
      { onProgress: (item) => progress.push(item), signal: controller.signal }
    )

    await installer.install('cuda')

    expect(progress).toEqual([
      { asset: 'llama-b12627-bin-win-cuda-12.4-x64.zip', index: 1, count: 2, received: 5, total: 10 },
      { asset: 'llama-b12627-bin-win-cuda-12.4-x64.zip', index: 1, count: 2, received: 10, total: 10 },
      { asset: 'cudart-llama-bin-win-cuda-12.4-x64.zip', index: 2, count: 2, received: 5, total: 10 },
      { asset: 'cudart-llama-bin-win-cuda-12.4-x64.zip', index: 2, count: 2, received: 10, total: 10 }
    ])
    expect(signals).toEqual([controller.signal, controller.signal])
  })
})

describe('RuntimeInstaller failures', () => {
  it('cleans the staging directory and records nothing when extract throws', async () => {
    const dataDir = await tempDataDir()
    const installer = makeInstaller(dataDir, {
      extract: async () => {
        throw new Error('zip 损坏')
      }
    })

    await expect(installer.install('vulkan')).rejects.toThrow('zip 损坏')

    expect(await exists(`${runtimeDir(dataDir, 'vulkan', 'b12627')}.tmp`)).toBe(false)
    expect(await exists(runtimeDir(dataDir, 'vulkan', 'b12627'))).toBe(false)
    expect(await installer.listInstalled()).toEqual([])
  })

  it('rejects an archive without llama-server.exe and writes no record', async () => {
    const dataDir = await tempDataDir()
    const installer = makeInstaller(dataDir, {
      extract: async (_zipPath, destDir) => {
        await mkdir(destDir, { recursive: true })
        await writeFile(join(destDir, 'README.txt'), 'not a runtime')
      }
    })

    await expect(installer.install('vulkan')).rejects.toThrow('没有找到 llama-server.exe')

    expect(await exists(`${runtimeDir(dataDir, 'vulkan', 'b12627')}.tmp`)).toBe(false)
    expect(await installer.listInstalled()).toEqual([])
    expect(await installer.getExe('vulkan')).toBeNull()
  })

  it('keeps the previous install when reinstall validation fails', async () => {
    const dataDir = await tempDataDir()
    const first = await makeInstaller(dataDir).install('vulkan')
    const failing = makeInstaller(dataDir, {
      validate: async () => {
        throw new Error('设备探测失败')
      }
    })

    await expect(failing.install('vulkan')).rejects.toThrow('设备探测失败')

    expect(await failing.getExe('vulkan')).toEqual(first)
    expect(await readFile(first.exePath, 'utf8')).toBe('exe')
    expect(await exists(`${runtimeDir(dataDir, 'vulkan', 'b12627')}.tmp`)).toBe(false)
  })

  it('drops the record and the directory on remove', async () => {
    const dataDir = await tempDataDir()
    const installer = makeInstaller(dataDir)
    const install = await installer.install('vulkan')

    await installer.remove('vulkan')

    expect(await installer.getExe('vulkan')).toBeNull()
    expect(await installer.listInstalled()).toEqual([])
    const record = JSON.parse(await readFile(join(dataDir, 'local', 'runtime.json'), 'utf8')) as unknown[]
    expect(record).toEqual([])
    expect(await exists(runtimeDir(dataDir, 'vulkan', 'b12627'))).toBe(false)
    expect(await exists(join(dataDir, 'local', 'runtime', 'vulkan'))).toBe(false)
    expect(await exists(install.exePath)).toBe(false)
  })

  it('keeps the installation on disk when the record rewrite fails during remove', async () => {
    const dataDir = await tempDataDir()
    const installer = makeInstaller(dataDir)
    const install = await installer.install('vulkan')
    // 让 runtime.json 的 .tmp 落点变成目录，写入必然失败：记录优先，失败时目录必须原样保留。
    await mkdir(join(dataDir, 'local', 'runtime.json.tmp'), { recursive: true })

    await expect(installer.remove('vulkan')).rejects.toThrow()

    expect(await installer.getExe('vulkan')).toEqual(install)
    expect(await exists(install.exePath)).toBe(true)
  })

  it('aborts a running install, removes staging and leaves no record', async () => {
    const dataDir = await tempDataDir()
    const controller = new AbortController()
    const installer = makeInstaller(
      dataDir,
      {
        // 模拟 downloadFile：signal 中止后以 AbortError 拒绝。
        download: async ({ dest, signal }) => {
          await mkdir(dirname(dest), { recursive: true })
          await writeFile(dest, 'zip')
          controller.abort()
          await new Promise((resolve) => setTimeout(resolve, 0))
          if (signal?.aborted) throw new Error('download aborted')
        }
      },
      { signal: controller.signal }
    )

    await expect(installer.install('vulkan')).rejects.toThrow('download aborted')

    expect(await exists(`${runtimeDir(dataDir, 'vulkan', 'b12627')}.tmp`)).toBe(false)
    expect(await installer.listInstalled()).toEqual([])
  })

  it('treats a corrupt runtime.json as no installations', async () => {
    const dataDir = await tempDataDir()
    await mkdir(join(dataDir, 'local'), { recursive: true })
    await writeFile(join(dataDir, 'local', 'runtime.json'), '{ not json', 'utf8')
    const installer = makeInstaller(dataDir)

    expect(await installer.listInstalled()).toEqual([])
    expect(await installer.getExe('vulkan')).toBeNull()
  })

  it('rejects a GitHub response that is not an array', async () => {
    const dataDir = await tempDataDir()
    const installer = makeInstaller(dataDir, {}, {
      fetchFn: async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 200 })
    })

    await expect(installer.install('vulkan')).rejects.toThrow('GitHub release 响应格式无效')
  })

  it('rejects release tags that would escape the data directory', async () => {
    for (const tag of ['..', '../evil', 'a/b', 'evil\\nested']) {
      const dataDir = await tempDataDir()
      const evil: ReleaseInfo[] = [
        { tag_name: tag, assets: [{ name: `llama-${tag}-bin-win-vulkan-x64.zip`, browser_download_url: 'https://x/evil.zip' }] }
      ]
      const installer = makeInstaller(dataDir, {}, {
        fetchFn: async () => new Response(JSON.stringify(evil), { status: 200 })
      })

      await expect(installer.install('vulkan')).rejects.toThrow('不合法')
      expect(await installer.listInstalled()).toEqual([])
    }
  })
})