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
  /**
   * 下载单个资产到 `dest`。`signal` 与 `RuntimeInstallerOptions.signal` 是同一个对象，
   * 中止时必须拒绝（AbortError），否则「停止安装」只能等下载跑完。
   */
  download(options: {
    url: string
    dest: string
    onProgress?: (received: number, total: number | null) => void
    signal?: AbortSignal
  }): Promise<void>
  /**
   * 解压 zip 到 `destDir`。契约：
   * - 必须**追加**解压，不得清空 `destDir` 已有文件：CUDA 需要把主包与 cudart 两个 zip 依次解压进同一个 staging 目录。
   * - 必须拒绝越出 `destDir` 的条目（`../`、绝对路径、盘符），发现即抛错，不能把文件写到目录外。
   * - 失败必须抛错，由调用方清理 staging。
   */
  extract(zipPath: string, destDir: string): Promise<void>
  /** 运行 `llama-server.exe` 探测可用设备（如 `--list-devices`）；抛错表示这个包在本机跑不起来。 */
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
  /** 逐个资产的下载进度；`index` 从 1 开始，`count` 是本次安装的资产总数。 */
  onProgress?: (progress: { asset: string; index: number; count: number; received: number; total: number | null }) => void
  /** 中止安装：传入下载端口，中止后清理 staging 且不写记录。 */
  signal?: AbortSignal
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

  /** 用整份记录列表原子替换 runtime.json（先写 .tmp 再 rename）。 */
  private async writeRecords(installs: RuntimeInstall[]): Promise<void> {
    await mkdir(join(this.options.dataDir, 'local'), { recursive: true })
    await replaceFileAtomically(this.recordFile, JSON.stringify(installs, null, 2))
  }

  private async saveRecord(install: RuntimeInstall): Promise<void> {
    const installs = (await this.listInstalled()).filter((item) => item.backend !== install.backend)
    installs.push(install)
    await this.writeRecords(installs)
  }

  /**
   * 拉 release 列表并挑出含目标后端资产的版本；响应不是数组时直接报错，
   * 避免把 GitHub 的错误对象（如 `{ message }`）当成「没有可用版本」。
   */
  private async selectRelease(backend: LocalBackend): Promise<{ tag: string; assets: Array<{ name: string; url: string }> }> {
    const response = await this.options.fetchFn(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'TokenHUB' }
    })
    if (!response.ok) throw new Error(`GitHub release 查询失败：HTTP ${response.status}`)
    const parsed = (await response.json()) as unknown
    if (!Array.isArray(parsed)) throw new Error('GitHub release 响应格式无效')
    const selected = selectRuntimeRelease(parsed as ReleaseInfo[], backend)
    if (!selected) throw new Error(`没有找到包含 ${backend} Windows 资产的 llama.cpp 版本`)
    return selected
  }

  /**
   * 逐个资产下载（URL 走镜像），把 onProgress 折算成「第几个包」的进度再上抛。
   * `onAsset` 在**每个** zip 落地后立刻回调，调用方据此记录已下载路径：中途某个资产失败时，
   * 前面已下载的 zip 才落在 `finally` 能看到的数组里（整体赋值只在全部成功后才发生）。
   */
  private async downloadAssets(
    assets: Array<{ name: string; url: string }>,
    onAsset: (zipPath: string) => void
  ): Promise<void> {
    const downloadDir = join(this.options.dataDir, 'local', 'downloads', 'runtime')
    await mkdir(downloadDir, { recursive: true })
    const mirror = this.options.mirror()
    for (const [offset, asset] of assets.entries()) {
      const dest = join(downloadDir, asset.name)
      const index = offset + 1
      await this.options.ports.download({
        url: mirroredUrl(asset.url, mirror),
        dest,
        signal: this.options.signal,
        onProgress: (received, total) =>
          this.options.onProgress?.({ asset: asset.name, index, count: assets.length, received, total })
      })
      onAsset(dest)
    }
  }

  /** exe 探测 → 校验 → 原子换上新目录 → 写记录。校验放在换目录前，坏包不会顶掉已有可用安装。 */
  private async finalize(params: {
    backend: LocalBackend
    tag: string
    staging: string
    sourceUrl: string
  }): Promise<RuntimeInstall> {
    const targetDir = join(this.runtimeRoot, params.backend, params.tag)
    const stagedExe = await findExecutable(params.staging)
    if (!stagedExe) throw new Error('压缩包中没有找到 llama-server.exe')
    const devices = await this.options.ports.validate(stagedExe)

    await rm(targetDir, { recursive: true, force: true })
    await mkdir(join(this.runtimeRoot, params.backend), { recursive: true })
    await rename(params.staging, targetDir)

    const install: RuntimeInstall = {
      backend: params.backend,
      tag: params.tag,
      installedAt: this.now().toISOString(),
      devices,
      sourceUrl: params.sourceUrl,
      exePath: rebase(stagedExe, params.staging, targetDir)
    }
    await this.saveRecord(install)
    return install
  }

  /**
   * 安装成功后清掉同一后端的其它版本目录：`remove()` 是唯一会回收磁盘的路径，而它只能跑到
   * 用户显式卸载；不在这里剪枝，每次升级都会留下整套旧运行时（数百 MB 到数 GB）。
   * 当前 tag 已换到正式目录，其余目录都是被替换掉的旧版本或残留 staging。
   */
  private async pruneSiblings(backend: LocalBackend, keepTag: string): Promise<void> {
    const backendDir = join(this.runtimeRoot, backend)
    const entries = await readdir(backendDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === keepTag) continue
      // 剪枝是尽力而为：旧目录被正在退出的 llama-server 句柄占用时不能让刚成功的安装变失败。
      await rm(join(backendDir, entry.name), { recursive: true, force: true }).catch(() => {})
    }
  }

  /** 扫描 release 列表 → 下载所需 zip（可走镜像）→ 解压到 `.tmp` → 校验 → 换目录 → 写记录。 */
  async install(backend: LocalBackend): Promise<RuntimeInstall> {
    this.options.signal?.throwIfAborted()
    const selected = await this.selectRelease(backend)
    // tag 与资产名会被拼进本地路径，含分隔符或 `..` 时必须拒绝，否则可能写到数据目录之外。
    assertSafePathSegment(selected.tag, 'tag_name')
    for (const asset of selected.assets) assertSafePathSegment(asset.name, '资产名')

    const staging = `${join(this.runtimeRoot, backend, selected.tag)}.tmp`
    // 下载成功的 zip 逐个累加进这个数组（而不是等 downloadAssets 整体返回），
    // 这样 CUDA 第二个包失败时，第一个包也能在 finally 里被删掉。
    const zips: string[] = []
    try {
      await this.downloadAssets(selected.assets, (zipPath) => zips.push(zipPath))
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })
      // 多个 zip 解压进同一个 staging，所以 extract 必须是追加解压（见 InstallerPorts 契约）。
      for (const zip of zips) await this.options.ports.extract(zip, staging)
      const install = await this.finalize({
        backend,
        tag: selected.tag,
        staging,
        sourceUrl: selected.assets.map((asset) => asset.url).join(' ')
      })
      await this.pruneSiblings(backend, selected.tag)
      return install
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    } finally {
      // zip 只服务这一次安装：留着只会占满下载目录（CUDA 两个包加起来近 300 MB），成功失败都要删。
      for (const zip of zips) await rm(zip, { force: true }).catch(() => {})
    }
  }

  /** 离线安装：用户自备 zip（如镜像站手动下载），tag 用时间戳避免与线上 tag 混淆。 */
  async importZip(zipPath: string, backend: LocalBackend): Promise<RuntimeInstall> {
    const tag = `manual-${this.now().toISOString().replace(/[:.]/g, '-')}`
    const staging = `${join(this.runtimeRoot, backend, tag)}.tmp`
    try {
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })
      await this.options.ports.extract(zipPath, staging)
      return await this.finalize({ backend, tag, staging, sourceUrl: zipPath })
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async remove(backend: LocalBackend): Promise<void> {
    const kept = (await this.listInstalled()).filter((install) => install.backend !== backend)
    // 先原子落记录、再删目录：记录写失败时抛错并保留安装，不会留下「文件已删但记录还在」的悬空条目。
    await this.writeRecords(kept)
    await rm(join(this.runtimeRoot, backend), { recursive: true, force: true })
  }
}

// runtime.json 保存所有后端的安装记录，非原子覆盖一旦崩溃会丢掉全部后端：先写 `.tmp` 再 rename。
// Windows 上杀毒/索引进程会短暂占用目标文件，重命名失败按递增间隔重试两次，仍失败则删掉 `.tmp` 并上抛。
async function replaceFileAtomically(target: string, contents: string): Promise<void> {
  const tmp = `${target}.tmp`
  await writeFile(tmp, contents, 'utf8')
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, target)
      return
    } catch (error) {
      if (attempt >= 2) {
        await rm(tmp, { force: true }).catch(() => {})
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)))
    }
  }
}

// 单个路径片段：非空、不是 `.`/`..`、不含分隔符、也不含 `..`（防 zip-slip / 目录穿越）。
function assertSafePathSegment(value: string, label: string): void {
  if (!value || value === '.' || value === '..' || /[\\/]/.test(value) || value.includes('..')) {
    throw new Error(`GitHub release ${label} 不合法：${value}`)
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