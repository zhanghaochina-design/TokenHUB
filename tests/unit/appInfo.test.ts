import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME, APP_VERSION, DEFAULT_PORT, FIRST_BYTE_TIMEOUT_MS } from '../../core/appInfo'

describe('appInfo', () => {
  it('exposes stable constants', () => {
    expect(APP_NAME).toBe('TokenHUB')
    expect(DEFAULT_PORT).toBe(8787)
    expect(FIRST_BYTE_TIMEOUT_MS).toBe(120_000)
  })

  it('keeps APP_VERSION in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
    expect(APP_VERSION).toBe(pkg.version)
  })
})
