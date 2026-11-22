import { describe, expect, it } from 'vitest'
import { detectHardware, parseGpuReport, pickRecommendedBackend } from '../../core/local/hardware'

const report = JSON.stringify({
  wmi: [
    { Name: 'AMD Radeon RX 7900 XTX', PNPDeviceID: 'PCI\\VEN_1002&DEV_744C', AdapterRAM: 4293918720 },
    { Name: 'AMD Radeon(TM) 780M Graphics', PNPDeviceID: 'PCI\\VEN_1002&DEV_15BF', AdapterRAM: 536870912 },
    { Name: 'Microsoft Basic Display Adapter', PNPDeviceID: 'PCI\\VEN_1414', AdapterRAM: 0 }
  ],
  reg: [
    { Desc: 'AMD Radeon RX 7900 XTX', Vram: 25753026560 },
    { Desc: 'AMD Radeon(TM) 780M Graphics', Vram: 1073741824 }
  ]
})

describe('hardware detection', () => {
  it('reads real VRAM from the registry and recommends the discrete GPU', () => {
    const gpus = parseGpuReport(report)
    expect(gpus).toHaveLength(2)
    expect(gpus[0]).toMatchObject({ name: 'AMD Radeon RX 7900 XTX', vendor: 'amd', vramEstimated: false, recommended: true })
    expect(gpus[0].vramBytes).toBe(25753026560)
    expect(gpus[1]).toMatchObject({ name: 'AMD Radeon(TM) 780M Graphics', recommended: false })
    expect(pickRecommendedBackend(gpus, 'auto')).toBe('vulkan')
  })

  it('matches registry entries by device id instead of a stale same-family name', () => {
    const gpus = parseGpuReport(
      JSON.stringify({
        wmi: [
          { Name: 'AMD Radeon RX 7900 XTX', PNPDeviceID: 'PCI\\VEN_1002&DEV_744C&SUBSYS_0E3A1002', AdapterRAM: 4293918720 }
        ],
        reg: [
          // 旧驱动残留子键：名字是当前卡的前缀，但设备 ID 不同，不能被包含匹配选中。
          { Desc: 'AMD Radeon RX 7900 XT', Vram: 21474836480, MatchingDeviceId: 'PCI\\VEN_1002&DEV_7443' },
          { Desc: 'amd radeon rx 7900 xtx', Vram: 25753026560, MatchingDeviceId: 'pci\\ven_1002&dev_744c' }
        ]
      })
    )
    expect(gpus[0]).toMatchObject({ vramEstimated: false })
    expect(gpus[0].vramBytes).toBe(25753026560)
    expect(gpus[0].vramBytes).not.toBe(21474836480)
  })

  it('matches registry names case-insensitively', () => {
    const gpus = parseGpuReport(
      JSON.stringify({
        wmi: [{ Name: 'NVIDIA GeForce RTX 4070', PNPDeviceID: 'PCI\\VEN_10DE&DEV_2786', AdapterRAM: 4293918720 }],
        reg: [{ Desc: 'nvidia geforce rtx 4070', Vram: 12884901888 }]
      })
    )
    expect(gpus[0]).toMatchObject({ vramBytes: 12884901888, vramEstimated: false })
  })

  it('flags VRAM taken from a fuzzy (contains) registry match as estimated', () => {
    const gpus = parseGpuReport(
      JSON.stringify({
        wmi: [{ Name: 'NVIDIA GeForce RTX 4070 SUPER', PNPDeviceID: 'PCI\\VEN_10DE&DEV_2783', AdapterRAM: 4293918720 }],
        reg: [{ Desc: 'NVIDIA GeForce RTX 4070', Vram: 12884901888 }]
      })
    )
    expect(gpus[0]).toMatchObject({ vramBytes: 12884901888, vramEstimated: true })
  })

  it('falls back to AdapterRAM and marks it estimated', () => {
    const gpus = parseGpuReport(
      JSON.stringify({ wmi: [{ Name: 'NVIDIA GeForce RTX 4070', PNPDeviceID: 'PCI\\VEN_10DE&DEV_2786', AdapterRAM: 4293918720 }], reg: [] })
    )
    expect(gpus[0]).toMatchObject({ vramEstimated: true, vramBytes: 4293918720 })
    expect(pickRecommendedBackend(gpus, 'auto')).toBe('cuda')
  })

  it('honours an explicit backend preference and cpu fallback', () => {
    expect(pickRecommendedBackend([], 'auto')).toBe('cpu')
    expect(pickRecommendedBackend([], 'cuda')).toBe('cuda')
    expect(pickRecommendedBackend(parseGpuReport(report), 'rocm')).toBe('rocm')
  })

  it('reports a readable error when the query fails', async () => {
    const result = await detectHardware(async () => {
      throw new Error('powershell missing')
    }, 'auto')
    expect(result.gpus).toEqual([])
    expect(result.recommendedBackend).toBe('cpu')
    expect(result.error).toContain('powershell missing')
  })

  it('surfaces a WMI failure reported inside the JSON payload', async () => {
    const result = await detectHardware(async () => JSON.stringify({ wmi: [], reg: [], error: 'Access denied' }), 'auto')
    expect(result.gpus).toEqual([])
    expect(result.error).toContain('Access denied')
    expect(result.recommendedBackend).toBe('cpu')
    const explicit = await detectHardware(async () => JSON.stringify({ wmi: [], reg: [], error: 'Access denied' }), 'vulkan')
    expect(explicit.recommendedBackend).toBe('vulkan')
  })

  it('reports a readable error instead of throwing on malformed output', async () => {
    const result = await detectHardware(async () => 'not json at all', 'vulkan')
    expect(result.gpus).toEqual([])
    expect(result.recommendedBackend).toBe('vulkan')
    expect(result.error).toBeTruthy()
  })
})