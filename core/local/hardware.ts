import { execFile } from 'node:child_process'
import type { BackendPreference, GpuInfo, HardwareReport, LocalBackend } from './types'

export type CommandRunner = (file: string, args: string[], timeoutMs?: number) => Promise<string>

export function runCommand(file: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()))
      else resolve(stdout)
    })
  })
}

// WMI AdapterRAM 是 uint32，24GB 显卡会被截断成 ~4GB，因此以注册表
// HardwareInformation.qwMemorySize（64 位真实显存）为准，WMI 仅作兜底。
// MatchingDeviceId（如 PCI\VEN_1002&DEV_744C）用于按设备 ID 精确配对，避免同系列旧子键串值；
// WMI 查询必须 -ErrorAction Stop 并显式回传 error，否则失败会静默变成「没有独显」。
export const GPU_QUERY_SCRIPT = [
  "$cls = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
  '$err = $null',
  '$wmi = @()',
  'try { $wmi = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object Name, PNPDeviceID, AdapterRAM) } catch { $err = $_.Exception.Message }',
  '$reg = Get-ChildItem $cls -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
  "  if ($p.DriverDesc) { [pscustomobject]@{ Desc = $p.DriverDesc; Vram = $p.'HardwareInformation.qwMemorySize'; MatchingDeviceId = $p.MatchingDeviceId } }",
  '}',
  '[pscustomobject]@{ wmi = $wmi; reg = $reg; error = $err } | ConvertTo-Json -Depth 4 -Compress'
].join('; ')

interface RawWmi {
  Name?: unknown
  PNPDeviceID?: unknown
  AdapterRAM?: unknown
}

interface RawReg {
  Desc?: unknown
  Vram?: unknown
  MatchingDeviceId?: unknown
}

interface RawReport {
  wmi?: RawWmi[] | RawWmi
  reg?: RawReg[] | RawReg
  error?: unknown
}

function numberOrNull(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

function vendorOf(name: string, pnpId: string): GpuInfo['vendor'] {
  const id = pnpId.toUpperCase()
  if (id.includes('VEN_10DE') || /nvidia/i.test(name)) return 'nvidia'
  if (id.includes('VEN_1002') || /amd|radeon/i.test(name)) return 'amd'
  if (id.includes('VEN_8086') || /intel/i.test(name)) return 'intel'
  return 'other'
}

// 远程桌面 / 基本显示适配器没有真实显存，混入后会把推荐逻辑带偏。
const SOFTWARE_ADAPTER = /microsoft basic display|basic render|remote display|virtual display/i

function regDesc(entry: RawReg): string {
  return typeof entry.Desc === 'string' ? entry.Desc.trim() : ''
}

function regDeviceId(entry: RawReg): string {
  return typeof entry.MatchingDeviceId === 'string' ? entry.MatchingDeviceId.trim() : ''
}

// ConvertTo-Json 对单个元素不输出数组；reg 为空时也可能缺字段，两种形状都要吃。
function asArray<T>(value: T[] | T | null | undefined): T[] {
  if (Array.isArray(value)) return value
  return value ? [value as T] : []
}

// PNP 字符串形如 PCI\VEN_1002&DEV_744C&SUBSYS_...，只取厂商+设备两段用于比对；
// 子系统 ID 不同的同芯片卡会共享这两段，因此不能带 SUBSYS。
const VENDOR_DEVICE = /VEN_[0-9A-F]{4}&DEV_[0-9A-F]{4}/i

function deviceIdOf(value: string): string | null {
  const found = VENDOR_DEVICE.exec(value)
  return found ? found[0].toUpperCase() : null
}

// PowerShell 输出可能带 BOM 与首尾空白，JSON.parse 不认 BOM。
function parseRawReport(rawJson: string): RawReport {
  return JSON.parse(rawJson.replace(/^\uFEFF/, '').trim()) as RawReport
}

function reportError(parsed: RawReport): string | null {
  return typeof parsed.error === 'string' && parsed.error.trim() !== '' ? parsed.error.trim() : null
}

export function parseGpuReport(rawJson: string): GpuInfo[] {
  return parseGpus(parseRawReport(rawJson))
}

function parseGpus(parsed: RawReport): GpuInfo[] {
  const wmi = asArray(parsed.wmi)
  const reg = asArray(parsed.reg)
  const gpus: GpuInfo[] = []
  const seen = new Set<string>()
  for (const item of wmi) {
    const name = typeof item.Name === 'string' ? item.Name.trim() : ''
    if (!name || SOFTWARE_ADAPTER.test(name) || seen.has(name)) continue
    seen.add(name)
    const pnp = typeof item.PNPDeviceID === 'string' ? item.PNPDeviceID : ''
    const pnpDeviceId = deviceIdOf(pnp)
    const lowerName = name.toLowerCase()
    // 注册表里可能残留同系列旧卡（如 7900 XT 与 7900 XTX），名字包含匹配会串显存，
    // 所以先按设备 ID 精确配对；没有设备 ID 时退化为忽略大小写的完全相等，最后才是包含匹配。
    const byDeviceId = pnpDeviceId
      ? reg.find((entry) => deviceIdOf(regDeviceId(entry)) === pnpDeviceId)
      : undefined
    const byExactName = reg.find((entry) => regDesc(entry).toLowerCase() === lowerName)
    const byContains = reg.find((entry) => {
      const desc = regDesc(entry).toLowerCase()
      return desc !== '' && (lowerName.includes(desc) || desc.includes(lowerName))
    })
    const match = byDeviceId ?? byExactName ?? byContains
    const registryVram = numberOrNull(match?.Vram)
    const adapterVram = numberOrNull(item.AdapterRAM)
    // 只有包含匹配这一档是近似对应，显存值需按估算提示；设备 ID / 名称精确命中才是实测值。
    const fuzzyMatch = !byDeviceId && !byExactName && byContains !== undefined
    gpus.push({
      name,
      vendor: vendorOf(name, pnp),
      vramBytes: registryVram ?? adapterVram,
      vramEstimated: registryVram === null ? adapterVram !== null : fuzzyMatch,
      recommended: false
    })
  }
  // 优先在独显里挑显存最大的一张；只有核显时退化为全部候选。
  const discrete = gpus.filter((gpu) => gpu.vendor === 'nvidia' || gpu.vendor === 'amd')
  const pool = discrete.length > 0 ? discrete : gpus
  const best = pool.reduce<GpuInfo | null>(
    (current, gpu) => (!current || (gpu.vramBytes ?? 0) > (current.vramBytes ?? 0) ? gpu : current),
    null
  )
  if (best) best.recommended = true
  return gpus
}

export function pickRecommendedBackend(gpus: GpuInfo[], preference: BackendPreference): LocalBackend {
  if (preference !== 'auto') return preference
  const gpu = gpus.find((item) => item.recommended) ?? gpus.find((item) => item.vendor !== 'other')
  if (!gpu) return 'cpu'
  // llama.cpp 在 N 卡上走 CUDA，A 卡 / I 卡走 Vulkan；ROCm 仅由用户显式指定。
  return gpu.vendor === 'nvidia' ? 'cuda' : 'vulkan'
}

export async function detectHardware(
  run: CommandRunner,
  preference: BackendPreference,
  now: () => Date = () => new Date()
): Promise<HardwareReport> {
  // 探测失败不能让 Hub 启动失败：返回空列表 + 错误文案，交给界面提示。
  const fallback: LocalBackend = preference === 'auto' ? 'cpu' : preference
  try {
    const raw = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', GPU_QUERY_SCRIPT])
    const parsed = parseRawReport(raw)
    // 脚本内部捕获的 WMI 失败（如权限不足）退出码仍为 0，必须读 error 字段，否则会误判成「没有独显」。
    const scriptError = reportError(parsed)
    if (scriptError) return { gpus: [], recommendedBackend: fallback, detectedAt: now().toISOString(), error: scriptError }
    const gpus = parseGpus(parsed)
    return { gpus, recommendedBackend: pickRecommendedBackend(gpus, preference), detectedAt: now().toISOString() }
  } catch (error) {
    return {
      gpus: [],
      recommendedBackend: fallback,
      detectedAt: now().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}