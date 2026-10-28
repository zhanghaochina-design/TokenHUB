import { timingSafeEqual } from 'node:crypto'

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function providedKey(headers: Headers): string | null {
  const auth = headers.get('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return headers.get('x-api-key')
}
