import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 5

export class Logger {
  constructor(private readonly file: string) {}

  async info(message: string): Promise<void> {
    await this.write('INFO', message)
  }

  async warn(message: string): Promise<void> {
    await this.write('WARN', message)
  }

  async error(message: string): Promise<void> {
    await this.write('ERROR', message)
  }

  private async write(level: string, message: string): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await this.rotateIfNeeded()
      await appendFile(this.file, `${new Date().toISOString()} ${level} ${message}\n`, 'utf8')
    } catch {
      // 日志失败不能影响业务
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    const size = await stat(this.file).then((s) => s.size).catch(() => 0)
    if (size < MAX_BYTES) return
    for (let i = KEEP - 1; i >= 1; i--) {
      await rename(`${this.file}.${i}`, `${this.file}.${i + 1}`).catch(() => {})
    }
    await rename(this.file, `${this.file}.1`).catch(() => {})
  }
}
