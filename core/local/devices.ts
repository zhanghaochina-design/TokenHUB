export interface RuntimeDevice {
  // 可原样下发给 llama-server `--device` 的标识，如 Vulkan0 / CUDA0。
  id: string
  // 设备描述，如 AMD Radeon RX 7900 XTX (24576 MiB)。
  label: string
}

// `--list-devices` 的设备行形如 `Vulkan0: AMD Radeon RX 7900 XTX (24576 MiB, ...)`。
// 表头 `Available devices:` 与后端日志行没有「名称+序号:」前缀，不能当成可下发的设备。
const DEVICE_LINE = /^([A-Za-z][A-Za-z0-9_]*\d+)\s*:\s*(.+)$/

export function parseRuntimeDevices(lines: readonly string[]): RuntimeDevice[] {
  const devices: RuntimeDevice[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const match = DEVICE_LINE.exec(line.trim())
    if (!match) continue
    const id = match[1]
    if (seen.has(id)) continue
    seen.add(id)
    devices.push({ id, label: match[2].trim() })
  }
  return devices
}