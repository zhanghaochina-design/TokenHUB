import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, clipboard } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { Hub } from '../core/hub'
import { LocalService } from '../core/local/service'
import { Logger } from '../core/store/logger'
import { safeStorageCipher } from './safeStorageCipher'
import { registerIpc, syncAutoStart } from './ipc'
import { UpdateController, type UpdaterLike } from './updateController'
import { circlePng } from '../core/trayIcon'
import type { AppState } from '../core/types'

const TRAY_GREEN: [number, number, number] = [34, 197, 94]
const TRAY_YELLOW: [number, number, number] = [234, 179, 8]
const TRAY_RED: [number, number, number] = [239, 68, 68]

let win: BrowserWindow | null = null
let tray: Tray | null = null
let hub: Hub | null = null
let localService: LocalService | null = null
let quitting = false
// 退出流程只能跑一次：before-quit 会被多次触发（窗口关闭 + app.quit + 二次点击托盘「退出」），
// 并发跑两遍 shutdown 会重复 kill/落盘，也会让 app.exit 被提前调用。
let shutdownStarted = false

// 必须在 ready 前改 userData，否则 secrets/config 会先落到默认目录。
// setPath 要求目录已存在，覆盖目录由调用方指定，先补建以免自定义目录不存在时直接崩溃。
const dataDir = process.env.TOKENHUB_DATA_DIR
if (dataDir) {
  mkdirSync(dataDir, { recursive: true })
  app.setPath('userData', dataDir)
}

// 红：所有供应商都不可路由；黄：任一供应商额度耗尽/限流；绿：其余情况。
function trayColor(state: AppState): [number, number, number] {
  const degraded = state.runtime.some((rt) => rt.availability === 'exhausted' || rt.availability === 'rate_limited')
  const noneRoutable = state.providers.every((provider) => {
    if (!provider.enabled) return true
    const rt = state.runtime.find((runtime) => runtime.providerId === provider.id)
    if (!rt) return false
    if (rt.availability === 'auth_error' || rt.availability === 'exhausted') return true
    return Boolean(rt.cooldownUntil && Date.parse(rt.cooldownUntil) > Date.now())
  })
  if (noneRoutable) return TRAY_RED
  return degraded ? TRAY_YELLOW : TRAY_GREEN
}

function showWindow(): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function updateTray(state: AppState): void {
  if (!tray) return
  // 监听失败时 port 为 0；托盘仍显示用户配置的端口，避免出现 127.0.0.1:0。
  const port = state.server.running ? state.server.port : state.settings.port
  tray.setImage(nativeImage.createFromBuffer(circlePng(32, trayColor(state))))
  tray.setToolTip(`TokenHUB · 127.0.0.1:${port}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主界面', click: () => showWindow() },
      {
        label: state.server.paused ? '恢复路由' : '暂停路由',
        click: () => {
          hub?.setPaused(!state.server.paused)
        }
      },
      { label: '复制 OpenAI 地址', click: () => clipboard.writeText(`http://127.0.0.1:${port}/v1`) },
      { label: '复制 Anthropic 地址', click: () => clipboard.writeText(`http://127.0.0.1:${port}`) },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

// 只允许停留/回到开发服务器或当前页面；外部链接与新窗口一律拦截。
function navigationAllowed(target: string): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  try {
    if (devUrl) return new URL(target).origin === new URL(devUrl).origin
    return win !== null && target === win.webContents.getURL()
  } catch {
    return false
  }
}

async function boot(): Promise<void> {
  hub = new Hub({
    dataDir: app.getPath('userData'),
    cipher: safeStorageCipher,
    portOverride: process.env.TOKENHUB_PORT ? Number(process.env.TOKENHUB_PORT) : undefined
  })
  await hub.init()

  // 本地服务在 Hub 之后启动：它要在 init 里立即把「无模型」同步给本地供应商。
  // 启动阶段的快照广播发生在窗口创建前，订阅方靠 getState 补当前状态；win 判空是必须的。
  localService = await LocalService.open({
    dataDir: app.getPath('userData'),
    hub: {
      syncLocalProvider: (input) => hub!.syncLocalProvider(input)
    },
    secrets: {
      getHfToken: () => hub!.getHfToken(),
      hasHfToken: () => Boolean(hub!.getHfToken()),
      setHfToken: (token) => hub!.setHfToken(token)
    },
    logger: new Logger(join(app.getPath('userData'), 'logs', 'app.log')),
    onSnapshot: (snapshot) => {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('tokenhub:localState', snapshot)
      }
    }
  })

  const updateController = new UpdateController(
    app.isPackaged ? (autoUpdater as unknown as UpdaterLike) : null,
    app.getVersion(),
    app.isPackaged
  )

  registerIpc(
    hub,
    localService,
    (state) => {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('tokenhub:state', state)
      }
      updateTray(state)
    },
    updateController,
    (state) => {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('tokenhub:updateState', state)
      }
    }
  )

  const state = hub.getState()
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: !state.settings.startMinimized,
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win = window

  window.on('close', (event) => {
    if (!quitting && hub?.getState().settings.closeToTray) {
      event.preventDefault()
      window.hide()
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!navigationAllowed(url)) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(__dirname, '../renderer/index.html'))

  tray = new Tray(nativeImage.createFromBuffer(circlePng(32, TRAY_GREEN)))
  updateTray(state)
  syncAutoStart(state.settings.autoStart)
}

// 单实例锁以 userData 为粒度：第二次启动只聚焦已有窗口，绝不重复起服务。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app
    .whenReady()
    .then(boot)
    .catch((error) => {
      dialog.showErrorBox('TokenHUB 启动失败', error instanceof Error ? error.message : String(error))
      app.quit()
    })

  app.on('window-all-closed', () => {
    if (!hub?.getState().settings.closeToTray) app.quit()
  })

  // Electron 不会等待异步监听器：第一次 before-quit 先拦下默认退出，异步关完本地运行时与 Hub 后
  // 用 app.exit(0) 收尾；后续重复触发的 before-quit 直接返回，不会插进正在进行的关闭流程。
  // 本地运行时排在最前：先杀掉 llama-server，Hub 关闭时在途的本地请求会立即失败，而不是挂在将死的上游上。
  app.on('before-quit', (event) => {
    if (shutdownStarted) return
    shutdownStarted = true
    event.preventDefault()
    quitting = true
    void (async () => {
      await localService?.shutdown().catch((error) => console.error('TokenHUB local runtime shutdown failed:', error))
      await hub?.shutdown().catch((error) => console.error('TokenHUB shutdown failed:', error))
      app.exit(0)
    })()
  })
}
