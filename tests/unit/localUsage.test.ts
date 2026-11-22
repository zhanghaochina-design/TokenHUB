import { describe, expect, it } from 'vitest'
import { parseUsageReport, sampleSystemUsage } from '../../core/local/usage'

const GB = 1024 ** 3
const now = () => new Date('2026-01-01T00:00:00.000Z')

function report(engines: unknown, memory: unknown): string {
  return JSON.stringify({ engines, memory })
}

describe('system usage report', () => {
  it('aggregates RAM and the adapter with the most dedicated VRAM', () => {
    const usage = parseUsageReport(
      report(
        [
          // 同一引擎多个进程求和；不同引擎之间取最大值。
          { Name: 'pid_1_luid_0x00000000_0xaaaa_phys_0_eng_0_engtype_3D', UtilizationPercentage: 40 },
          { Name: 'pid_2_luid_0x00000000_0xaaaa_phys_0_eng_0_engtype_3D', UtilizationPercentage: 35 },
          { Name: 'pid_1_luid_0x00000000_0xaaaa_phys_0_eng_1_engtype_Compute', UtilizationPercentage: 10 },
          // 核显利用率很高但显存占用小：显存/GPU 口径跟随占用最大的适配器，应忽略它。
          { Name: 'pid_3_luid_0x00000000_0xbbbb_phys_0_eng_0_engtype_3D', UtilizationPercentage: 99 }
        ],
        [
          { Name: 'pid_1_luid_0x00000000_0xaaaa_phys_0', DedicatedUsage: 20 * GB },
          { Name: 'pid_3_luid_0x00000000_0xbbbb_phys_0', DedicatedUsage: 512 * 1024 ** 2 }
        ]
      ),
      { ramTotalBytes: 32 * GB, ramFreeBytes: 12 * GB, vramTotalBytes: 24 * GB, now }
    )

    expect(usage).toEqual({
      sampledAt: '2026-01-01T00:00:00.000Z',
      ramUsedBytes: 20 * GB,
      ramTotalBytes: 32 * GB,
      vramUsedBytes: 20 * GB,
      vramTotalBytes: 24 * GB,
      gpuPercent: 75
    })
  })

  it('accepts single-object JSON, BOM and clamps engine sums at 100', () => {
    const raw =
      '\uFEFF' +
      JSON.stringify({
        engines: { Name: 'pid_1_luid_0x00000000_0xaaaa_phys_0_eng_0_engtype_3D', UtilizationPercentage: 80 },
        memory: { Name: 'pid_1_luid_0x00000000_0xaaaa_phys_0', DedicatedUsage: 1024 }
      })
    const usage = parseUsageReport(raw, { ramTotalBytes: 16 * GB, ramFreeBytes: 4 * GB, vramTotalBytes: null, now })
    expect(usage).toMatchObject({ ramUsedBytes: 12 * GB, vramUsedBytes: 1024, vramTotalBytes: null, gpuPercent: 80 })

    const capped = parseUsageReport(
      report(
        [
          { Name: 'pid_1_luid_0x00000000_0xaaaa_phys_0_eng_0_engtype_3D', UtilizationPercentage: 60 },
          { Name: 'pid_2_luid_0x00000000_0xaaaa_phys_0_eng_0_engtype_3D', UtilizationPercentage: 60 }
        ],
        []
      ),
      { ramTotalBytes: 16 * GB, ramFreeBytes: 4 * GB, vramTotalBytes: null, now }
    )
    expect(capped.gpuPercent).toBe(100)
  })

  it('falls back to the busiest adapter when memory counters are missing', () => {
    const usage = parseUsageReport(
      report(
        [
          { Name: 'pid_1_luid_0x00000000_0xaaaa_phys_0_eng_0_engtype_3D', UtilizationPercentage: 12 },
          { Name: 'pid_2_luid_0x00000000_0xbbbb_phys_0_eng_0_engtype_3D', UtilizationPercentage: 64 }
        ],
        []
      ),
      { ramTotalBytes: 8 * GB, ramFreeBytes: 2 * GB, vramTotalBytes: null, now }
    )
    expect(usage).toMatchObject({ vramUsedBytes: 0, gpuPercent: 64 })
  })

  it('returns zeroed metrics when the counters are unavailable', () => {
    const usage = parseUsageReport('{}', { ramTotalBytes: 8 * GB, ramFreeBytes: 10 * GB, vramTotalBytes: null, now })
    expect(usage).toEqual({
      sampledAt: '2026-01-01T00:00:00.000Z',
      ramUsedBytes: 0,
      ramTotalBytes: 8 * GB,
      vramUsedBytes: 0,
      vramTotalBytes: null,
      gpuPercent: 0
    })
  })
})

describe('sampleSystemUsage', () => {
  it('returns null instead of throwing when the query fails', async () => {
    const usage = await sampleSystemUsage({
      run: async () => {
        throw new Error('powershell unavailable')
      },
      vramTotalBytes: null
    })
    expect(usage).toBeNull()
  })
})