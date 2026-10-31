# TokenHUB 自动更新与文档站点实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页提供手动检查更新的完整链路，并把 README 与教程发布到 GitHub Pages。

**Architecture:** 主进程新增一个可注入的 `UpdateController` 包装 `electron-updater`，通过 IPC 暴露检查/下载/安装与状态事件；渲染层只消费状态。打包配置接入 GitHub publish 源并生成 `latest.yml`，发布 workflow 上传更新元数据。Pages 用独立 workflow 把 `README.html` 与教程组装成静态站点。

**Tech Stack:** Electron 45、electron-updater 6、React 19、Vitest 5、Playwright、GitHub Actions、GitHub Pages。

**Spec:** `docs/superpowers/specs/2026-10-31-auto-update-pages-design.md`

## Global Constraints

- 仅 Windows 10/11；不处理 macOS / Linux。
- 更新只允许手动触发：启动不检查、不定时轮询、不自动下载、不自动安装。
- 版本从 `0.1.0` 升到 `0.1.1`，`package.json` 与 `core/appInfo.ts` 必须一致。
- 安装包产物名固定为 `TokenHUB-Setup-${version}.${ext}`，不得含空格。
- GitHub 更新源固定为 `zhanghaochina-design/TokenHUB`。
- 开发与 E2E（`app.isPackaged === false`）不构造更新器、不发起网络请求。
- 提交与推送前必须取得用户明确授权（沿用 AGENTS.md 的现有约定）。
- 声称完成前必须运行 `npm run typecheck && npm test`；涉及 UI 加 `npm run build && npx playwright test`；涉及打包加 `npx electron-builder --win nsis --publish never`。

---

### Task 1: 更新状态机与控制器

**Files:**
- Modify: `core/ipc-types.ts`
- Create: `electron/updateController.ts`
- Test: `tests/unit/updateController.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `UpdatePhase`, `UpdateProgress`, `UpdateState`（从 `core/ipc-types.ts` 导出）。
  - `UpdateController` 类：`getState(): UpdateState`、`subscribe(listener): () => void`、`check(): Promise<UpdateState>`、`download(): Promise<UpdateState>`、`install(): void`。
  - `UpdaterLike`、`UpdateInfoLike`、`UpdateProgressLike`（从 `electron/updateController.ts` 导出）。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/updateController.test.ts`：

```ts
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { UpdateController, type UpdaterLike } from '../../electron/updateController'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  checkForUpdates = vi.fn(async () => null)
  downloadUpdate = vi.fn(async () => null)
  quitAndInstall = vi.fn()
}

function createController(enabled = true, currentVersion = '0.1.1') {
  const updater = new FakeUpdater()
  const controller = new UpdateController(updater as unknown as UpdaterLike, currentVersion, enabled)
  return { updater, controller }
}

describe('UpdateController', () => {
  it('disables updates outside packaged builds', async () => {
    const controller = new UpdateController(null, '0.1.1', false)
    expect(controller.getState()).toEqual({ phase: 'disabled', currentVersion: '0.1.1' })
    await expect(controller.check()).resolves.toMatchObject({ phase: 'disabled' })
    await expect(controller.download()).resolves.toMatchObject({ phase: 'disabled' })
    expect(() => controller.install()).not.toThrow()
  })

  it('forces manual download and install', () => {
    const { updater } = createController()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
  })

  it('reports an available update after a manual check', async () => {
    const { updater, controller } = createController()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('checking-for-update')
      updater.emit('update-available', { version: '0.1.2' })
      return null
    })
    const state = await controller.check()
    expect(state.phase).toBe('available')
    expect(state.availableVersion).toBe('0.1.2')
    expect(state.checkedAt).toBeTruthy()
  })

  it('reports up-to-date when no update exists', async () => {
    const { updater, controller } = createController()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-not-available', { version: '0.1.1' })
      return null
    })
    await expect(controller.check()).resolves.toMatchObject({ phase: 'up-to-date' })
  })

  it('reports check failures without throwing', async () => {
    const { updater, controller } = createController()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('error', new Error('network down'))
      throw new Error('network down')
    })
    const state = await controller.check()
    expect(state.phase).toBe('error')
    expect(state.message).toContain('network down')
  })

  it('tracks download progress and readiness', async () => {
    const { updater, controller } = createController()
    updater.emit('update-available', { version: '0.1.2' })
    const phases: string[] = []
    controller.subscribe((state) => phases.push(state.phase))
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('download-progress', { percent: 42.4, transferred: 42, total: 100 })
      updater.emit('update-downloaded', { version: '0.1.2' })
      return null
    })
    const state = await controller.download()
    expect(state.phase).toBe('ready')
    expect(phases).toContain('downloading')
  })

  it('returns to available when a download fails', async () => {
    const { updater, controller } = createController()
    updater.emit('update-available', { version: '0.1.2' })
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('error', new Error('disk full'))
      throw new Error('disk full')
    })
    const state = await controller.download()
    expect(state.phase).toBe('available')
    expect(state.availableVersion).toBe('0.1.2')
    expect(state.message).toContain('disk full')
  })

  it('installs only after the update is downloaded', () => {
    const { updater, controller } = createController()
    controller.install()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    updater.emit('update-downloaded', { version: '0.1.2' })
    controller.install()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/updateController.test.ts`
Expected: FAIL，模块 `electron/updateController` 不存在。

- [ ] **Step 3: 添加类型**

在 `core/ipc-types.ts` 末尾加入：

```ts
export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
}

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  availableVersion?: string
  progress?: UpdateProgress
  message?: string
  checkedAt?: string
}
```

- [ ] **Step 4: 实现控制器**

创建 `electron/updateController.ts`：

```ts
import type { UpdateProgress, UpdateState } from '../core/ipc-types'

export interface UpdateInfoLike {
  version: string
}

export interface UpdateProgressLike {
  percent: number
  transferred: number
  total: number
}

interface UpdaterEvents {
  'checking-for-update': () => void
  'update-available': (info: UpdateInfoLike) => void
  'update-not-available': (info: UpdateInfoLike) => void
  'download-progress': (progress: UpdateProgressLike) => void
  'update-downloaded': (info: UpdateInfoLike) => void
  error: (error: Error) => void
}

export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  on<E extends keyof UpdaterEvents>(event: E, listener: UpdaterEvents[E]): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class UpdateController {
  private state: UpdateState
  private readonly listeners = new Set<(state: UpdateState) => void>()

  constructor(
    private readonly updater: UpdaterLike | null,
    currentVersion: string,
    private readonly enabled: boolean
  ) {
    this.state = { phase: enabled && updater ? 'idle' : 'disabled', currentVersion }
    if (!enabled || !updater) return

    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false

    updater.on('checking-for-update', () => this.patch({ phase: 'checking', message: undefined }))
    updater.on('update-available', (info) =>
      this.patch({
        phase: 'available',
        availableVersion: info.version,
        checkedAt: new Date().toISOString(),
        message: undefined
      })
    )
    updater.on('update-not-available', () =>
      this.patch({
        phase: 'up-to-date',
        availableVersion: undefined,
        checkedAt: new Date().toISOString(),
        message: undefined
      })
    )
    updater.on('download-progress', (progress) =>
      this.patch({
        phase: 'downloading',
        progress: {
          percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
          transferred: progress.transferred,
          total: progress.total
        }
      })
    )
    updater.on('update-downloaded', () =>
      this.patch({ phase: 'ready', progress: undefined, message: undefined })
    )
    updater.on('error', (error) => {
      // 下载失败保留可用版本，用户可以直接重试下载。
      if (this.state.phase === 'downloading') {
        this.patch({ phase: 'available', progress: undefined, message: error.message })
      } else {
        this.patch({ phase: 'error', message: error.message })
      }
    })
  }

  getState(): UpdateState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : undefined }
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async check(): Promise<UpdateState> {
    const phase = this.state.phase
    if (!this.updater || phase === 'disabled' || phase === 'checking' || phase === 'downloading' || phase === 'ready') {
      return this.getState()
    }
    this.patch({ phase: 'checking', message: undefined, checkedAt: undefined, availableVersion: undefined })
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      this.patch({ phase: 'error', message: errorMessage(error) })
    }
    return this.getState()
  }

  async download(): Promise<UpdateState> {
    if (!this.updater || this.state.phase !== 'available') return this.getState()
    this.patch({
      phase: 'downloading',
      progress: { percent: 0, transferred: 0, total: 0 },
      message: undefined
    })
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      this.patch({ phase: 'available', progress: undefined, message: errorMessage(error) })
    }
    return this.getState()
  }

  install(): void {
    if (!this.updater || this.state.phase !== 'ready') return
    try {
      this.updater.quitAndInstall(false, true)
    } catch (error) {
      this.patch({ phase: 'ready', message: errorMessage(error) })
    }
  }

  private patch(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next }
    const snapshot = this.getState()
    for (const listener of this.listeners) listener(snapshot)
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/unit/updateController.test.ts`
Expected: PASS（8 个用例）。

- [ ] **Step 6: 提交（等待用户授权）**

```bash
git add core/ipc-types.ts electron/updateController.ts tests/unit/updateController.test.ts
git commit -m "feat: add manual update controller with state machine"
```

---

### Task 2: 接通 IPC、preload 与主进程

**Files:**
- Modify: `core/ipc-types.ts`
- Modify: `electron/ipc.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`

**Interfaces:**
- Consumes: `UpdateController`、`UpdateState`。
- Produces: `TokenHubApi.getUpdateState/checkForUpdates/downloadUpdate/installUpdate/onUpdate`；主进程在安装版构造控制器，开发与 E2E 传 `null`。

- [ ] **Step 1: 扩展 TokenHubApi 类型**

在 `core/ipc-types.ts` 的 `TokenHubApi` 接口中加入：

```ts
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  installUpdate(): Promise<void>
  onUpdate(cb: (state: UpdateState) => void): () => void
```

- [ ] **Step 2: 注册主进程 handler**

修改 `electron/ipc.ts`：

```ts
import type { UpdateState } from '../core/ipc-types'
import type { UpdateController } from './updateController'

export function registerIpc(
  hub: Hub,
  broadcast: (state: AppState) => void,
  updateController: UpdateController,
  broadcastUpdate: (state: UpdateState) => void
): void {
  // 原有 hub handler 保持不变
  hub.onStateChange(broadcast)
  // ...原有 handler...

  ipcMain.handle('tokenhub:getUpdateState', () => updateController.getState())
  ipcMain.handle('tokenhub:checkForUpdates', () => updateController.check())
  ipcMain.handle('tokenhub:downloadUpdate', () => updateController.download())
  ipcMain.handle('tokenhub:installUpdate', () => updateController.install())
  updateController.subscribe(broadcastUpdate)
}
```

- [ ] **Step 3: 暴露 preload API**

修改 `electron/preload.ts` 的 `api` 对象：

```ts
  getUpdateState: () => ipcRenderer.invoke('tokenhub:getUpdateState'),
  checkForUpdates: () => ipcRenderer.invoke('tokenhub:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('tokenhub:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('tokenhub:installUpdate'),
  onUpdate: (cb) => {
    const handler = (_event: unknown, state: Parameters<typeof cb>[0]) => cb(state)
    ipcRenderer.on('tokenhub:updateState', handler)
    return () => ipcRenderer.removeListener('tokenhub:updateState', handler)
  },
```

- [ ] **Step 4: 主进程接入更新器**

修改 `electron/main.ts`：

```ts
import { autoUpdater } from 'electron-updater'
import { UpdateController, type UpdaterLike } from './updateController'

// boot() 内、registerIpc 之前：
const updateController = new UpdateController(
  app.isPackaged ? (autoUpdater as unknown as UpdaterLike) : null,
  app.getVersion(),
  app.isPackaged
)

registerIpc(
  hub,
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
```

- [ ] **Step 5: 安装依赖并跑类型检查**

Run: `npm install electron-updater && npm run typecheck`
Expected: 退出码 0；`package.json` 的 dependencies 出现 `electron-updater`。

- [ ] **Step 6: 提交（等待用户授权）**

```bash
git add package.json package-lock.json core/ipc-types.ts electron/ipc.ts electron/preload.ts electron/main.ts
git commit -m "feat: wire update controller through ipc and main process"
```

---

### Task 3: 设置页更新卡片与 E2E

**Files:**
- Create: `src/lib/useUpdateState.ts`
- Modify: `src/pages/SettingsPage.tsx`
- Test: `tests/e2e/update.spec.ts`

**Interfaces:**
- Consumes: `window.tokenhub.getUpdateState/checkForUpdates/downloadUpdate/installUpdate/onUpdate`。
- Produces: 设置页「软件更新」卡片；开发态显示禁用说明。

- [ ] **Step 1: 写失败的 E2E**

创建 `tests/e2e/update.spec.ts`：

```ts
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = '18792'

function launchEnv(dataDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') continue
    if (value !== undefined) env[key] = value
  }
  env.TOKENHUB_DATA_DIR = dataDir
  env.TOKENHUB_PORT = PORT
  return env
}

test('settings shows the manual update card in development mode', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tokenhub-e2e-update-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: ['.'], env: launchEnv(dataDir) })
    const win = await app.firstWindow()
    await win.getByRole('link', { name: '设置' }).click()

    await expect(win.getByRole('heading', { name: '软件更新' })).toBeVisible()
    await expect(win.getByText('当前版本')).toBeVisible()
    await expect(win.getByText('仅安装版支持更新检查；开发与测试环境不会请求 GitHub。')).toBeVisible()
    await expect(win.getByRole('button', { name: '检查更新' })).toBeDisabled()
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: 构建并确认失败**

Run: `npm run build && npx playwright test tests/e2e/update.spec.ts`
Expected: FAIL，找不到「软件更新」标题。

- [ ] **Step 3: 实现状态 Hook**

创建 `src/lib/useUpdateState.ts`：

```ts
import { useEffect, useState } from 'react'
import type { UpdateState } from '../../core/ipc-types'

export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    let active = true
    void window.tokenhub
      .getUpdateState()
      .then((next) => {
        if (active) setState(next)
      })
      .catch(() => {
        if (active) setState(null)
      })
    const unsubscribe = window.tokenhub.onUpdate((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}
```

- [ ] **Step 4: 增加更新卡片**

在 `src/pages/SettingsPage.tsx`：

```ts
import type { UpdateState } from '../../core/ipc-types'
import { useUpdateState } from '../lib/useUpdateState'
```

在 `SettingsPage` 内加入状态与操作：

```ts
  const update = useUpdateState()
  const updateBusy = update?.phase === 'checking' || update?.phase === 'downloading'
  const updateDisabled = !update || update.phase === 'disabled'

  function updateStatus(state: UpdateState | null): string {
    if (!state) return '读取中'
    switch (state.phase) {
      case 'disabled': return '仅安装版'
      case 'idle': return '未检查'
      case 'checking': return '检查中'
      case 'up-to-date': return '已是最新'
      case 'available': return `发现 v${state.availableVersion ?? ''}`
      case 'downloading': return '下载中'
      case 'ready': return '等待重启'
      case 'error': return '检查失败'
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
  }

  async function checkUpdates(): Promise<void> {
    try {
      await window.tokenhub.checkForUpdates()
    } catch (error) {
      setToast(`检查更新失败：${errorMessage(error)}`)
    }
  }

  async function downloadUpdate(): Promise<void> {
    try {
      await window.tokenhub.downloadUpdate()
    } catch (error) {
      setToast(`下载更新失败：${errorMessage(error)}`)
    }
  }

  async function installUpdate(): Promise<void> {
    try {
      await window.tokenhub.installUpdate()
    } catch (error) {
      setToast(`安装更新失败：${errorMessage(error)}`)
    }
  }
```

在「启动与托盘」卡片之后插入：

```tsx
        <Card
          id="settings-update-heading"
          title="软件更新"
          description="手动检查 GitHub Release；不会在后台自动请求网络。"
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-md bg-canvas/60 px-3 py-2.5 ring-1 ring-inset ring-line">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted">当前版本</p>
                <p className="mt-0.5 font-mono text-sm text-ink">v{update?.currentVersion ?? '—'}</p>
              </div>
              <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-muted ring-1 ring-inset ring-line">
                {updateStatus(update)}
              </span>
            </div>

            {update?.phase === 'downloading' && update.progress && (
              <div>
                <div className="h-2 overflow-hidden rounded-full bg-neutral-200" role="progressbar" aria-valuenow={update.progress.percent} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${update.progress.percent}%` }} />
                </div>
                <p className="mt-1 text-xs text-muted">
                  {update.progress.percent}% · {formatBytes(update.progress.transferred)} / {formatBytes(update.progress.total)}
                </p>
              </div>
            )}

            {update?.message && (
              <p role="alert" className="text-xs leading-5 text-red-600">
                {update.message}
              </p>
            )}

            {updateDisabled && (
              <p className="text-xs leading-5 text-muted">仅安装版支持更新检查；开发与测试环境不会请求 GitHub。</p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void checkUpdates()}
                disabled={updateDisabled || updateBusy}
                className={SECONDARY_BUTTON}
              >
                {update?.phase === 'checking' ? '检查中…' : '检查更新'}
              </button>
              {update?.phase === 'available' && (
                <button type="button" onClick={() => void downloadUpdate()} className={PRIMARY_BUTTON}>
                  下载 v{update.availableVersion}
                </button>
              )}
              {update?.phase === 'ready' && (
                <button type="button" onClick={() => void installUpdate()} className={PRIMARY_BUTTON}>
                  重启并安装
                </button>
              )}
            </div>

            {update?.checkedAt && (
              <p className="text-xs text-muted">上次检查：{new Date(update.checkedAt).toLocaleString()}</p>
            )}
          </div>
        </Card>
```

- [ ] **Step 5: 构建并确认 E2E 通过**

Run: `npm run build && npx playwright test tests/e2e/update.spec.ts`
Expected: PASS。

- [ ] **Step 6: 跑全量门禁**

Run: `npm run typecheck && npm test && npx playwright test`
Expected: 全部通过。

- [ ] **Step 7: 提交（等待用户授权）**

```bash
git add src/lib/useUpdateState.ts src/pages/SettingsPage.tsx tests/e2e/update.spec.ts
git commit -m "feat: add manual update card to settings"
```

---

### Task 4: 版本号、打包配置与发布资产

**Files:**
- Modify: `package.json`
- Modify: `core/appInfo.ts`
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `electron-updater` 依赖。
- Produces: `release/latest.yml`、`release/win-unpacked/resources/app-update.yml`、无空格产物名。

- [ ] **Step 1: 升版本并配置 publish**

修改 `package.json`：

```json
  "version": "0.1.1",
  "build": {
    "appId": "com.tokenhub.app",
    "productName": "TokenHUB",
    "artifactName": "TokenHUB-Setup-${version}.${ext}",
    "directories": { "output": "release" },
    "files": ["out/main/**/*", "out/preload/**/*", "out/renderer/**/*", "package.json"],
    "publish": [{ "provider": "github", "owner": "zhanghaochina-design", "repo": "TokenHUB" }],
    "win": { "target": ["nsis"], "icon": "build/icon.ico" },
    "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true }
  }
```

修改 `core/appInfo.ts`：

```ts
export const APP_VERSION = '0.1.1'
```

- [ ] **Step 2: 发布 workflow 上传 latest.yml**

修改 `.github/workflows/release.yml` 的校验和与上传步骤：

```powershell
      - name: Write checksums
        shell: pwsh
        run: |
          $files = @()
          $files += Get-ChildItem release/*.exe | ForEach-Object FullName
          $files += (Resolve-Path release/latest.yml).Path
          $sums = foreach ($file in $files) {
            "$((Get-FileHash $file -Algorithm SHA256).Hash.ToLower())  $(Split-Path $file -Leaf)"
          }
          $sums | Set-Content release/SHA256SUMS.txt -Encoding ascii

      - name: Publish GitHub Release
        shell: pwsh
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          $files = @()
          $files += Get-ChildItem release -Filter *.exe | ForEach-Object FullName
          $files += Get-ChildItem release -Filter *.blockmap | ForEach-Object FullName
          $files += (Resolve-Path release/latest.yml).Path
          $files += (Resolve-Path release/SHA256SUMS.txt).Path
          gh release create "${{ github.ref_name }}" --title "TokenHUB ${{ github.ref_name }}" --generate-notes @files
```

- [ ] **Step 3: 更新文档中的产物名**

`README.md` 快速开始改为：

```md
从 [Releases](../../releases/latest) 下载 `TokenHUB-Setup-x.y.z.exe` 并安装。
```

`AGENTS.md` 在稳定契约中补充：

```md
- 更新只允许手动触发；开发/E2E 不构造 electron-updater、不请求网络。发布资产必须包含 `latest.yml`，安装包名为 `TokenHUB-Setup-${version}.${ext}`（无空格），否则更新器与 GitHub 资产名对不上。
```

- [ ] **Step 4: 本地打包并验证更新元数据**

Run: `npm run typecheck && npm test && npm run build && npx electron-builder --win nsis --publish never`

然后运行：

```bash
ls -lh release/latest.yml release/win-unpacked/resources/app-update.yml "release/TokenHUB-Setup-0.1.1.exe"
grep -E "^(version|path|sha512):" release/latest.yml
```

Expected: 三个文件存在；`latest.yml` 的 `version` 为 `0.1.1`，`path` 为 `TokenHUB-Setup-0.1.1.exe`；`app-update.yml` 含 `provider: github` 与仓库信息。

- [ ] **Step 5: 提交（等待用户授权）**

```bash
git add package.json package-lock.json core/appInfo.ts .github/workflows/release.yml README.md AGENTS.md
git commit -m "build: configure github updates and bump to 0.1.1"
```

---

### Task 5: GitHub Pages 站点

**Files:**
- Create: `.github/workflows/pages.yml`
- Add: `docs/guide/claude-code-deepseek.html`
- Modify: `docs/readme/template.html`
- Regenerate: `README.html`
- Modify: `README.md`

**Interfaces:**
- Consumes: 现有 `README.html` 与教程 HTML（自包含，无外部图片）。
- Produces: 首页 `https://zhanghaochina-design.github.io/TokenHUB/` 与教程页 `/docs/guide/claude-code-deepseek.html`。

- [ ] **Step 1: 添加 Pages workflow**

创建 `.github/workflows/pages.yml`：

```yaml
name: Pages

on:
  push:
    branches: [master]
    paths:
      - 'README.html'
      - 'docs/guide/**'
      - '.github/workflows/pages.yml'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Assemble site
        run: |
          mkdir -p _site/docs/guide
          cp README.html _site/index.html
          cp docs/guide/*.html _site/docs/guide/

      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: _site
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: 增加教程入口并重建 HTML**

在 `docs/readme/template.html` 的 hero 操作区加入：

```html
        <a class="btn btn-ghost" href="docs/guide/claude-code-deepseek.html">实战教程</a>
```

Run: `node docs/readme/build.mjs`
Expected: `README.html written`。

在 `README.md` 顶部介绍后加入：

```md
[在线文档](https://zhanghaochina-design.github.io/TokenHUB/) · [实战教程](https://zhanghaochina-design.github.io/TokenHUB/docs/guide/claude-code-deepseek.html)
```

并在「文档」小节加入：

```md
- [把 DeepSeek V4.1 Flash 接进 Claude Code](docs/guide/claude-code-deepseek.html)：从安装到路由验证的实战教程。
```

- [ ] **Step 3: 启用 Pages（一次性设置）**

Run:

```bash
"$HOME/tools/gh/gh.exe" api -X POST repos/zhanghaochina-design/TokenHUB/pages -f build_type=workflow
```

若返回 409，改用：

```bash
"$HOME/tools/gh/gh.exe" api -X PUT repos/zhanghaochina-design/TokenHUB/pages -f build_type=workflow
```

Expected: 返回 JSON 含 `"build_type":"workflow"`。

- [ ] **Step 4: 提交并推送（等待用户授权）**

```bash
git add .github/workflows/pages.yml docs/guide/claude-code-deepseek.html docs/readme/template.html README.html README.md
git commit -m "docs: publish guide and readme to github pages"
git push origin master
```

推送后等待 Pages workflow 完成。

- [ ] **Step 5: 验证站点**

Run:

```bash
curl -sS -o /dev/null -w "index:%{http_code}\n" https://zhanghaochina-design.github.io/TokenHUB/
curl -sS -o /dev/null -w "guide:%{http_code}\n" https://zhanghaochina-design.github.io/TokenHUB/docs/guide/claude-code-deepseek.html
```

Expected: 两个 `200`。

- [ ] **Step 6: 提交（等待用户授权）**

已包含在 Step 4。

---

### Task 6: 发布 v0.1.1 并验证更新链路

**Files:**
- 无新增；只做发布与验证。

**Interfaces:**
- Consumes: Task 1–5 的全部改动。
- Produces: GitHub Release `v0.1.1`，含 `TokenHUB-Setup-0.1.1.exe`、blockmap、`latest.yml`、`SHA256SUMS.txt`。

- [ ] **Step 1: 完整门禁**

Run: `npm run typecheck && npm test && npm run build && npx playwright test`
Expected: 全部通过。

- [ ] **Step 2: 提交剩余改动（等待用户授权）**

```bash
git status --short
git add <上述任务列出的文件>
git commit -m "chore: prepare v0.1.1 release"
```

- [ ] **Step 3: 打 tag 并推送**

```bash
git tag -a v0.1.1 -m "TokenHUB v0.1.1"
git push origin v0.1.1
```

- [ ] **Step 4: 等待并验证 Release**

Run:

```bash
"$HOME/tools/gh/gh.exe" run list --workflow release.yml --limit 1
"$HOME/tools/gh/gh.exe" release view v0.1.1 --json assets --jq '.assets[].name'
```

Expected: 资产包含 `TokenHUB-Setup-0.1.1.exe`、`.blockmap`、`latest.yml`、`SHA256SUMS.txt`。

- [ ] **Step 5: 验证更新元数据与校验和**

Run:

```bash
"$HOME/tools/gh/gh.exe" release download v0.1.1 -p latest.yml -O "$TEMP/tokenhub-latest.yml" --clobber
cat "$TEMP/tokenhub-latest.yml"
"$HOME/tools/gh/gh.exe" release download v0.1.1 -p SHA256SUMS.txt -O "$TEMP/tokenhub-sums.txt" --clobber
cat "$TEMP/tokenhub-sums.txt"
```

Expected: `latest.yml` 的 `path` 与 release 资产名一致；`SHA256SUMS.txt` 中的 exe 与 `latest.yml` 哈希与 GitHub 资产摘要一致。

---

## 自查

- Spec 覆盖：手动检查、状态机、IPC、UI、打包、发布资产、Pages、验证均有对应任务。
- 无占位符：每个代码步骤包含可直接粘贴的实现。
- 类型一致性：`UpdateState`、`UpdateController`、`TokenHubApi` 在任务间签名一致。
- 待用户授权：所有 commit/push 步骤在 AGENTS.md 约定下暂停确认。
