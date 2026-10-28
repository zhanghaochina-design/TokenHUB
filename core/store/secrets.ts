import { rename } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { readText, writeFileAtomic } from './fsUtil'

const MAGIC = 'TOKENHUB-SECRETS-1'

export interface CipherPort {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super('系统加密不可用（safeStorage/DPAPI），拒绝以明文保存密钥')
  }
}

interface Secrets {
  version: 1
  providerKeys: Record<string, string>
  localApiKey: string | null
}

function emptySecrets(): Secrets {
  return { version: 1, providerKeys: {}, localApiKey: null }
}

function isSecrets(value: unknown): value is Secrets {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.version !== 1) return false
  const keys = candidate.providerKeys
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) return false
  if (!Object.values(keys).every((key) => typeof key === 'string')) return false
  return candidate.localApiKey === null || typeof candidate.localApiKey === 'string'
}

// 任何格式/解密/结构问题都视为损坏，由调用方隔离原文件而不是静默清空。
function decodeSecrets(text: string, cipher: CipherPort): Secrets {
  const newline = text.indexOf('\n')
  const magic = newline === -1 ? text : text.slice(0, newline)
  const payload = newline === -1 ? '' : text.slice(newline + 1)
  if (magic !== MAGIC || payload.length === 0) throw new Error('invalid secrets file header')
  const decrypted: unknown = JSON.parse(cipher.decrypt(Buffer.from(payload, 'base64')))
  if (!isSecrets(decrypted)) throw new Error('invalid secrets payload shape')
  return decrypted
}

export class SecretStore {
  private data: Secrets = emptySecrets()
  private recoveryWarning: string | null = null

  private constructor(private readonly file: string, private readonly cipher: CipherPort) {}

  static async open(file: string, cipher: CipherPort): Promise<SecretStore> {
    const store = new SecretStore(file, cipher)
    const text = await readText(file)
    if (text === null) return store
    if (!cipher.isAvailable()) throw new EncryptionUnavailableError()
    try {
      store.data = decodeSecrets(text, cipher)
    } catch {
      await store.quarantine()
    }
    return store
  }

  getRecoveryWarning(): string | null {
    return this.recoveryWarning
  }

  getProviderKey(id: string): string | null {
    return this.data.providerKeys[id] ?? null
  }

  hasProviderKey(id: string): boolean {
    return Boolean(this.data.providerKeys[id])
  }

  getLocalApiKey(): string | null {
    return this.data.localApiKey
  }

  async setProviderKey(id: string, key: string): Promise<void> {
    this.data.providerKeys[id] = key
    await this.persist()
  }

  async removeProviderKey(id: string): Promise<void> {
    delete this.data.providerKeys[id]
    await this.persist()
  }

  async setLocalApiKey(key: string | null): Promise<void> {
    this.data.localApiKey = key
    await this.persist()
  }

  // 重命名失败必须上抛：宁可启动报错，也不能让空密钥库覆盖用户原文件。
  private async quarantine(): Promise<void> {
    const ext = extname(this.file)
    const stem = basename(this.file, ext)
    const target = join(dirname(this.file), `${stem}.corrupt-${Date.now()}${ext}`)
    await rename(this.file, target)
    this.data = emptySecrets()
    this.recoveryWarning = `密钥文件已损坏，原文件已隔离到 ${target}，当前使用空密钥库`
  }

  private async persist(): Promise<void> {
    if (!this.cipher.isAvailable()) throw new EncryptionUnavailableError()
    const payload = this.cipher.encrypt(JSON.stringify(this.data)).toString('base64')
    await writeFileAtomic(this.file, `${MAGIC}\n${payload}`)
  }
}
