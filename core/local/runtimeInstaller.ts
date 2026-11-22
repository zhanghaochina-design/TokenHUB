import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { FetchFn } from './http'
import type { LocalBackend, RuntimeInstall } from './types'

export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

export interface ReleaseInfo {
  tag_name: string
  assets: ReleaseAsset[]
}

export interface InstallerPorts {
  download(options: { url: string; dest: string; onProgress?: (received: number, total: number | null) => void }): Promise<void>
  extract(zipPath: string, destDir: string): Promise<void>
  validate(exePath: string): Promise<string[]>
}

// 资产命名取自 llama.cpp 官方 release：CUDA 需要运行时包 cudart 与主包两个 zip 一起解压，其它后端只有主包。
// tag 用 release.tag_name 原样拼接（如 b12627），不要补 v 前缀。
export function assetNamesFor(backend: LocalBackend, tag: string): string[] {
  if (backend === 'cuda') return [`llama-${tag}-bin-win-cuda-12.4-x64.zip`, 'cudart-llama-bin-win-cuda-12.4-x64.zip']
  return [`llama-${tag}-bin-win-${backend}-x64.zip`]
}

// /releases/latest 可能指向没有 Windows 资产的版本（如只有 nightly-tag.txt），
// 因此按列表顺序（新→旧）返回第一个「所需资产齐全」的 release，全部缺失时返回 null。
export function selectRuntimeRelease(
  releases: ReleaseInfo[],
  backend: LocalBackend
): { tag: string; assets: Array<{ name: string; url: string }> } | null {
  for (const release of releases) {
    const required = assetNamesFor(backend, release.tag_name)
    const found = required.map((name) => release.assets.find((asset) => asset.name === name))
    if (found.every((asset): asset is ReleaseAsset => Boolean(asset))) {
      return {
        tag: release.tag_name,
        assets: found.map((asset) => ({ name: asset!.name, url: asset!.browser_download_url }))
      }
    }
  }
  return null
}

// 镜像前缀常被用户写成 https://ghfast.top/ 或 https://ghfast.top///，统一去掉尾部斜杠再拼原始 URL；
// 空串表示直连。
export function mirroredUrl(url: string, mirror: string): string {
  const prefix = mirror.trim().replace(/\/+$/, '')
  return prefix ? `${prefix}/${url}` : url
}

const RELEASES_URL = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10'

export interface RuntimeInstallerOptions {
  dataDir: string
  ports: InstallerPorts
  fetchFn: FetchFn
  mirror: () => string
  now?: () => Date
}

export class RuntimeInstaller {
  private readonly now: () => Date

  constructor(private readonly options: RuntimeInstallerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  private get runtimeRoot(): string {
    return join(this.options.dataDir, 'local', 'runtime')
  }

  // 记录文件与运行时目录分开：卸载只需删目录，记录损坏时按「未安装」处理而不是让整个本地功能挂掉。
  private get recordFile(): string {
    return join(this.options.dataDir, 'local', 'runtime.json')
  }

  async listInstalled(): Promise<RuntimeInstall[]> {
    const text = await readFile(this.recordFile, 'utf8').catch(() => null)
    if (!text) return []
    try {
      const parsed = JSON.parse(text) as unknown
      return Array.isArray(parsed) ? (parsed as RuntimeInstall[]) : []
    } catch {
      return []
    }
  }

  async getExe(backend: LocalBackend): Promise<RuntimeInstall | null> {
    const installs = await this.listInstalled()
    return installs.find((install) => install.backend === backend) ?? null
  }

  private async saveRecord(install: RuntimeInstall): Promise<void> {
    const installs = (await this.listInstalled()).filter((item) => item.backend !== install.backend)
    installs.push(install)
    await mkdir(join(this.options.dataDir, 'local'), { recursive: true })
    await writeFile(this.recordFile, JSON.stringify(installs, null, 2), 'utf8')
  }

  /**
   * 扫描 release 列表 → 下载所需 zip（可走镜像）→ 解压到 `.tmp` → 校验 exe 能列出设备 → 原子重命名到
   * `runtime/<backend>/<tag>` → 写记录。校验放在重命名前，坏包不会覆盖已有可用安装。
   */
  async install(backend: LocalBackend): Promise<RuntimeInstall> {
    const response = await this.options.fetchFn(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'TokenHUB' }
    })
    if (!response.ok) throw new Error(`GitHub release 查询失败：HTTP ${response.status}`)
    const releases = (await response.json()) as ReleaseInfo[]
    const selected = selectRuntimeRelease(releases, backend)
    if (!selected) throw new Error(`没有找到包含 ${backend} Windows 资产的 llama.cpp 版本`)

    const downloadDir = join(this.options.dataDir, 'local', 'downloads', 'runtime')
    await mkdir(downloadDir, { recursive: true })
    const zips: string[] = []
    for (const asset of selected.assets) {
      const dest = join(downloadDir, asset.name)
      await this.options.ports.download({ url: mirroredUrl(asset.url, this.options.mirror()), dest })
      zips.push(dest)
    }

    const targetDir = join(this.runtimeRoot, backend, selected.tag)
    const staging = `${targetDir}.tmp`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      for (const zip of zips) await this.options.ports.extract(zip, staging)

      const stagedExe = await findExecutable(staging)
      if (!stagedExe) throw new Error('压缩包中没有找到 llama-server.exe')
      const devices = await this.options.ports.validate(stagedExe)

      await rm(targetDir, { recursive: true, force: true })
      await mkdir(join(this.runtimeRoot, backend), { recursive: true })
      await rename(staging, targetDir)

      const install: RuntimeInstall = {
        backend,
        tag: selected.tag,
        installedAt: this.now().toISOString(),
        devices,
        sourceUrl: selected.assets.map((asset) => asset.url).join(' '),
        exePath: rebase(stagedExe, staging, targetDir)
      }
      await this.saveRecord(install)
      return install
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  /** 离线安装：用户自备 zip（如镜像站手动下载），tag 用时间戳避免与线上 tag 混淆。 */
  async importZip(zipPath: string, backend: LocalBackend): Promise<RuntimeInstall> {
    const tag = `manual-${this.now().toISOString().replace(/[:.]/g, '-')}`
    const targetDir = join(this.runtimeRoot, backend, tag)
    const staging = `${targetDir}.tmp`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      await this.options.ports.extract(zipPath, staging)
      const stagedExe = await findExecutable(staging)
      if (!stagedExe) throw new Error('压缩包中没有找到 llama-server.exe')
      const devices = await this.options.ports.validate(stagedExe)

      await rm(targetDir, { recursive: true, force: true })
      await mkdir(join(this.runtimeRoot, backend), { recursive: true })
      await rename(staging, targetDir)

      const install: RuntimeInstall = {
        backend,
        tag,
        installedAt: this.now().toISOString(),
        devices,
        sourceUrl: zipPath,
        exePath: rebase(stagedExe, staging, targetDir)
      }
      await this.saveRecord(install)
      return install
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async remove(backend: LocalBackend): Promise<void> {
    const installs = await this.listInstalled()
    const kept = installs.filter((install) => install.backend !== backend)
    await rm(join(this.runtimeRoot, backend), { recursive: true, force: true })
    await mkdir(join(this.options.dataDir, 'local'), { recursive: true })
    await writeFile(this.recordFile, JSON.stringify(kept, null, 2), 'utf8')
  }
}

// 用相对路径重定位 exe：直接字符串替换 staging 会在路径含 `$` 等替换模式或前缀重复时出错。
function rebase(filePath: string, from: string, to: string): string {
  return join(to, relative(from, filePath))
}

// zip 内可能多一层目录（build/bin/），所以要递归找；大小写按 Windows 语义忽略。
async function findExecutable(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === 'llama-server.exe') return path
    if (entry.isDirectory()) {
      const nested = await findExecutable(path)
      if (nested) return nested
    }
  }
  return null
}