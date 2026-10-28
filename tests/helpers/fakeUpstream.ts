import { createServer } from 'node:http'

export interface FakeResponse {
  status: number
  body?: string
  headers?: Record<string, string>
  /** 写完 body 后销毁 socket 且不补 chunk 终止块，模拟上游流中途断连（body 被截断） */
  truncate?: boolean
  /** 写完 body 后保持连接不结束，直到客户端断开；用于「首字节后客户端中断」的场景 */
  holdOpen?: boolean
}

export async function startFakeUpstream(
  handler: (path: string, body: string) => FakeResponse | Promise<FakeResponse>
): Promise<{ url: string; requests: Array<{ path: string; body: string }>; close(): Promise<void> }> {
  const requests: Array<{ path: string; body: string }> = []
  const server = createServer(async (req, res) => {
    // 客户端中断后写入已销毁的 socket 不应产生未处理的 error
    res.on('error', () => {})
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push({ path: req.url ?? '', body })
    const out = await handler(req.url ?? '', body)
    const headers = { 'content-type': 'application/json', ...(out.headers ?? {}) }
    if (out.truncate) {
      const payload = Buffer.from(out.body ?? '')
      // 声明比实际更长的 Content-Length 并在首个 chunk 落盘后断连：客户端必须观察到截断错误
      res.writeHead(out.status, { ...headers, 'content-length': String(payload.length + 64) })
      res.write(payload, () => {
        setTimeout(() => res.destroy(), 20)
      })
      return
    }
    if (out.holdOpen) {
      // 不发终止块，连接保持到客户端断开（测试里的 abort 会关闭它）
      res.writeHead(out.status, headers)
      res.write(out.body ?? '')
      return
    }
    res.writeHead(out.status, headers)
    res.end(out.body ?? '')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      // holdOpen 等长连接不会自行结束，关闭测试服务器时一并断开
      server.closeAllConnections()
    })
  }
}
