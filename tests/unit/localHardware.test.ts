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

  it('reports a readable error instead of throwing on malformed output', async () => {
    const result = await detectHardware(async () => 'not json at all', 'vulkan')
    expect(result.gpus).toEqual([])
    expect(result.recommendedBackend).toBe('vulkan')
    expect(result.error).toBeTruthy()
  })
})