import { serve } from '@hono/node-server'
import { createApp, type AppDeps } from './app'

// 端口切换只允许旧连接继续一小会儿：SSE 长连接不能把关闭流程永远挂住。
const CLOSE_GRACE_MS = 2000

export interface RunningServer {
  port: number
  // 幂等：先关空闲连接，宽限期后强制断开剩余连接，即使仍有连接也必定 resolve。
  close(): Promise<void>
}

export async function startServer(deps: AppDeps, port: number): Promise<RunningServer> {
  const app = createApp(deps)
  return await new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
      // 只跑 HTTP/1 监听；这两个方法来自 node:http，http2 类型里没有声明。
      const connections = server as typeof server & {
        closeIdleConnections?(): void
        closeAllConnections?(): void
      }
      let closing: Promise<void> | null = null
      resolve({
        port: info.port,
        close: () => {
          if (closing) return closing
          closing = new Promise<void>((done) => {
            const timer = setTimeout(() => {
              // 宽限期内未自然结束的连接（通常是进行中的 SSE）直接丢弃，避免 IPC/退出被拖住。
              connections.closeAllConnections?.()
              done()
            }, CLOSE_GRACE_MS)
            server.close(() => {
              clearTimeout(timer)
              done()
            })
            connections.closeIdleConnections?.()
          })
          return closing
        }
      })
    })
    server.on('error', reject)
  })
}
