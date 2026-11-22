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
export const GPU_QUERY_SCRIPT = [
  "$cls = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
  '$wmi = Get-CimInstance Win32_VideoController | Select-Object Name, PNPDeviceID, AdapterRAM',
  '$reg = Get-ChildItem $cls -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
  "  if ($p.DriverDesc) { [pscustomobject]@{ Desc = $p.DriverDesc; Vram = $p.'HardwareInformation.qwMemorySize' } }",
  '}',
  '[pscustomobject]@{ wmi = $wmi; reg = $reg } | ConvertTo-Json -Depth 4 -Compress'
].join('; ')

interface RawWmi {
  Name?: unknown
  PNPDeviceID?: unknown
  AdapterRAM?: unknown
}

interface RawReg {
  Desc?: unknown
  Vram?: unknown
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

// ConvertTo-Json 对单个元素不输出数组；reg 为空时也可能缺字段，两种形状都要吃。
function asArray<T>(value: T[] | T | null | undefined): T[] {
  if (Array.isArray(value)) return value
  return value ? [value as T] : []
}

export function parseGpuReport(rawJson: string): GpuInfo[] {
  // PowerShell 输出可能带 BOM 与首尾空白，JSON.parse 不认 BOM。
  const parsed = JSON.parse(rawJson.replace(/^\uFEFF/, '').trim()) as { wmi?: RawWmi[] | RawWmi; reg?: RawReg[] | RawReg }
  const wmi = asArray(parsed.wmi)
  const reg = asArray(parsed.reg)
  const gpus: GpuInfo[] = []
  const seen = new Set<string>()
  for (const item of wmi) {
    const name = typeof item.Name === 'string' ? item.Name.trim() : ''
    if (!name || SOFTWARE_ADAPTER.test(name) || seen.has(name)) continue
    seen.add(name)
    const pnp = typeof item.PNPDeviceID === 'string' ? item.PNPDeviceID : ''
    // 注册表描述常带厂商后缀，先精确匹配再退化为包含匹配，避免同名系列串值。
    const match =
      reg.find((entry) => regDesc(entry) === name) ??
      reg.find((entry) => {
        const desc = regDesc(entry)
        return desc !== '' && (name.includes(desc) || desc.includes(name))
      })
    const registryVram = numberOrNull(match?.Vram)
    const adapterVram = numberOrNull(item.AdapterRAM)
    gpus.push({
      name,
      vendor: vendorOf(name, pnp),
      vramBytes: registryVram ?? adapterVram,
      vramEstimated: registryVram === null && adapterVram !== null,
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
  try {
    const raw = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', GPU_QUERY_SCRIPT])
    const gpus = parseGpuReport(raw)
    return { gpus, recommendedBackend: pickRecommendedBackend(gpus, preference), detectedAt: now().toISOString() }
  } catch (error) {
    // 探测失败不能让 Hub 启动失败：返回空列表 + 错误文案，交给界面提示。
    return {
      gpus: [],
      recommendedBackend: preference === 'auto' ? 'cpu' : preference,
      detectedAt: now().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}