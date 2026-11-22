import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RuntimeInstaller,
  assetNamesFor,
  mirroredUrl,
  selectRuntimeRelease,
  type InstallerPorts,
  type ReleaseInfo
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
})