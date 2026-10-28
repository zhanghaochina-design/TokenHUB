import { describe, expect, it } from 'vitest'
import { APP_NAME, DEFAULT_PORT, FIRST_BYTE_TIMEOUT_MS } from '../../core/appInfo'

describe('appInfo', () => {
  it('exposes stable constants', () => {
    expect(APP_NAME).toBe('TokenHUB')
    expect(DEFAULT_PORT).toBe(8787)
    expect(FIRST_BYTE_TIMEOUT_MS).toBe(120_000)
  })
})
