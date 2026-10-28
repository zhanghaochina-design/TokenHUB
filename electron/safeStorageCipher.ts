import { safeStorage } from 'electron'
import type { CipherPort } from '../core/store/secrets'

// 密钥落盘一律用系统 DPAPI（safeStorage）；不可用时 SecretStore 会拒绝写入明文。
export const safeStorageCipher: CipherPort = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data)
}
