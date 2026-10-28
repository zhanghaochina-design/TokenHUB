import { describe, expect, it } from 'vitest'
import { circlePng } from '../../core/trayIcon'

describe('circlePng', () => {
  it('produces a PNG buffer', () => {
    const png = circlePng(32, [34, 197, 94])
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(png.length).toBeGreaterThan(50)
  })
})
