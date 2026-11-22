import { describe, expect, it } from 'vitest'
import { parseRuntimeDevices } from '../../core/local/devices'

describe('runtime devices', () => {
  it('parses device lines and skips headers, log lines and duplicates', () => {
    expect(
      parseRuntimeDevices([
        'Available devices:',
        '  Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 24468 MiB free)',
        'Vulkan1: AMD Radeon(TM) Graphics (1024 MiB, 900 MiB free)',
        'ggml_vulkan: 1 = AMD Radeon(TM) Graphics',
        'Vulkan0: duplicate'
      ])
    ).toEqual([
      { id: 'Vulkan0', label: 'AMD Radeon RX 7900 XTX (24560 MiB, 24468 MiB free)' },
      { id: 'Vulkan1', label: 'AMD Radeon(TM) Graphics (1024 MiB, 900 MiB free)' }
    ])
  })

  it('returns an empty list when nothing looks like a device', () => {
    expect(parseRuntimeDevices(['Available devices:', 'CUDA: no index', ''])).toEqual([])
  })
})