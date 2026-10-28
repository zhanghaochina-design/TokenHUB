import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EncryptionUnavailableError, SecretStore, type CipherPort } from '../../core/store/secrets'

const xorCipher: CipherPort = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8')
}

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'tokenhub-secrets-')), 'secrets.bin')
}

describe('secret store', () => {
  it('round-trips provider keys without plaintext on disk', async () => {
    const file = await tempFile()
    const store = await SecretStore.open(file, xorCipher)
    await store.setProviderKey('p1', 'sk-super-secret')
    await store.setLocalApiKey('local-key')
    const reloaded = await SecretStore.open(file, xorCipher)
    expect(reloaded.getProviderKey('p1')).toBe('sk-super-secret')
    expect(reloaded.getLocalApiKey()).toBe('local-key')
    expect(await readFile(file, 'utf8')).not.toContain('sk-super-secret')
  })

  it('removes provider keys', async () => {
    const file = await tempFile()
    const store = await SecretStore.open(file, xorCipher)
    await store.setProviderKey('p1', 'k')
    await store.removeProviderKey('p1')
    expect(store.getProviderKey('p1')).toBeNull()
  })

  it('refuses to save when encryption is unavailable', async () => {
    const file = await tempFile()
    const unavailable: CipherPort = { ...xorCipher, isAvailable: () => false }
    const store = await SecretStore.open(file, unavailable)
    await expect(store.setProviderKey('p1', 'k')).rejects.toBeInstanceOf(EncryptionUnavailableError)
  })

  it('opens an empty store without a warning when the file is missing', async () => {
    const file = await tempFile()
    const store = await SecretStore.open(file, xorCipher)
    expect(store.hasProviderKey('p1')).toBe(false)
    expect(store.getLocalApiKey()).toBeNull()
    expect(store.getRecoveryWarning()).toBeNull()
  })

  it('quarantines a bad-magic file, returns an empty store, and warns', async () => {
    const file = await tempFile()
    const original = 'GARBAGE-MAGIC\nAAAA'
    await writeFile(file, original, 'utf8')
    const store = await SecretStore.open(file, xorCipher)
    expect(store.getProviderKey('p1')).toBeNull()
    expect(store.getLocalApiKey()).toBeNull()
    const quarantined = await quarantineFiles(file)
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]).toMatch(/^secrets\.corrupt-\d+\.bin$/)
    expect(await readFile(join(dirname(file), quarantined[0]), 'utf8')).toBe(original)
    expect(await readFile(file, 'utf8').catch(() => null)).toBeNull()
    const warning = store.getRecoveryWarning()
    expect(warning).not.toBeNull()
    expect(warning).toContain(quarantined[0])
  })

  it('quarantines an undecryptable payload and warns', async () => {
    const file = await tempFile()
    const payload = Buffer.from('this decrypts to non-json garbage').toString('base64')
    await writeFile(file, `TOKENHUB-SECRETS-1\n${payload}`, 'utf8')
    const store = await SecretStore.open(file, xorCipher)
    expect(store.getProviderKey('p1')).toBeNull()
    expect(store.getLocalApiKey()).toBeNull()
    expect(store.getRecoveryWarning()).not.toBeNull()
    expect(await quarantineFiles(file)).toHaveLength(1)
    expect(await readFile(file, 'utf8').catch(() => null)).toBeNull()
  })

  it('quarantines a decrypted payload with an invalid shape and warns', async () => {
    const file = await tempFile()
    const payload = xorCipher.encrypt(JSON.stringify({ version: 99, providerKeys: 'nope' })).toString('base64')
    await writeFile(file, `TOKENHUB-SECRETS-1\n${payload}`, 'utf8')
    const store = await SecretStore.open(file, xorCipher)
    expect(store.getProviderKey('p1')).toBeNull()
    expect(store.getRecoveryWarning()).not.toBeNull()
    expect(await quarantineFiles(file)).toHaveLength(1)
  })

  it('throws without touching the file when encryption is unavailable but a file exists', async () => {
    const file = await tempFile()
    const writer = await SecretStore.open(file, xorCipher)
    await writer.setProviderKey('p1', 'persisted')
    const before = await readFile(file, 'utf8')
    const unavailable: CipherPort = { ...xorCipher, isAvailable: () => false }
    await expect(SecretStore.open(file, unavailable)).rejects.toBeInstanceOf(EncryptionUnavailableError)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readdir(dirname(file))).toEqual(['secrets.bin'])
  })
})

async function quarantineFiles(file: string): Promise<string[]> {
  return (await readdir(dirname(file))).filter((f) => f.startsWith('secrets.corrupt-'))
}
