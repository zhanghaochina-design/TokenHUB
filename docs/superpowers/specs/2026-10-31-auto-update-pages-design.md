# TokenHUB 自动更新与文档站点设计

日期：2026-10-31

## 目标

1. 在设置页提供手动检查更新：检查、下载、重启安装全部由用户点击触发，不做后台轮询。
2. 把 `README.html` 与实战教程发布到 GitHub Pages，作为公开文档入口。

## 非目标

- 不做自动检查、自动下载或静默安装。
- 不做增量包之外的安装方式，不支持 macOS / Linux 更新。
- 不引入回滚机制；更新失败由用户重新安装处理。

## 更新子系统

### 组件

- `electron/updateController.ts`：纯控制器，接收可注入的更新器接口，不直接依赖 Electron；负责状态机、事件订阅和错误归一化。
- `electron/main.ts`：安装版启动时构造 `electron-updater` 的 `autoUpdater` 并交给控制器。
- `electron/ipc.ts`、`electron/preload.ts`、`core/ipc-types.ts`：暴露查询、检查、下载、安装与状态事件；`UpdateState` 类型放在 `core/ipc-types.ts`。
- `src/pages/SettingsPage.tsx`：新增「软件更新」卡片，订阅更新状态并渲染按钮。

### 状态模型

`UpdateState`：

```ts
type UpdatePhase =
  | 'disabled'     // 开发 / E2E，不请求网络
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  availableVersion?: string
  progress?: { percent: number; transferred: number; total: number }
  message?: string
  checkedAt?: string
}
```

状态迁移：

- `disabled`：`app.isPackaged === false`，所有操作直接返回当前状态。
- `check`：`idle/up-to-date/error/available → checking → available | up-to-date | error`。
- `download`：`available → downloading → ready`；下载失败回到 `available` 并带 `message`，可重试。
- `install`：`ready → quitAndInstall()`；调用失败保持 `ready` 并带 `message`。
- 更新器事件 `checking-for-update / update-available / update-not-available / download-progress / update-downloaded / error` 只由控制器转换为状态，渲染层不解析事件。

### IPC 契约

```ts
getUpdateState(): Promise<UpdateState>
checkForUpdates(): Promise<UpdateState>
downloadUpdate(): Promise<UpdateState>
installUpdate(): Promise<void>
onUpdate(cb: (state: UpdateState) => void): () => void
```

通道：`tokenhub:getUpdateState`、`tokenhub:checkForUpdates`、`tokenhub:downloadUpdate`、`tokenhub:installUpdate`、事件 `tokenhub:updateState`。

### 更新器配置

- `autoDownload = false`、`autoInstallOnAppQuit = false`、`allowPrerelease = false`。
- 只允许从 `zhanghaochina-design/TokenHUB` 的 GitHub Release 更新。
- 检查失败只更新卡片文案，不弹系统对话框。

### 打包与发布

- 依赖新增 `electron-updater`。
- `package.json` 增加 `build.publish`（GitHub，owner `zhanghaochina-design`，repo `TokenHUB`）。
- 增加无空格产物名 `TokenHUB-Setup-${version}.${ext}`，避免 GitHub 把空格改成点后与 `latest.yml` 的 `path` 不一致。
- 发布 workflow 在打包后上传 `latest.yml`、exe、blockmap 与校验和；本地打包必须确认 `release/latest.yml` 与 `release/win-unpacked/resources/app-update.yml` 存在。
- 版本升到 `0.1.1`，`package.json` 与 `core/appInfo.ts` 同步。已安装 0.1.0 的用户需要手动安装 0.1.1 一次，之后才能使用手动检查更新。

## GitHub Pages

- 将 `docs/guide/claude-code-deepseek.html` 纳入仓库。
- 新增 `.github/workflows/pages.yml`：在 `master` 的文档变更或手动触发时，把 `README.html` 复制为 `index.html`，并复制 `docs/guide/*.html`，用官方 Pages actions 部署。
- 站点路径：
  - 首页：`https://zhanghaochina-design.github.io/TokenHUB/`
  - 教程：`https://zhanghaochina-design.github.io/TokenHUB/docs/guide/claude-code-deepseek.html`
- `README.md` 与 `README.html` 增加教程入口，链接使用仓库相对路径 `docs/guide/claude-code-deepseek.html`。
- 通过 `gh api` 把仓库 Pages 的构建来源设为 GitHub Actions（一次性设置）。

## 测试与验证

- 单元测试：用假更新器覆盖 disabled、检查成功/无更新/失败、下载进度、下载失败重试、ready 安装。
- E2E：设置页显示「软件更新」卡片；开发态显示「仅安装版支持」且不请求网络。
- 本地打包：`npx electron-builder --win nsis --publish never` 后检查 `latest.yml`、`app-update.yml` 与无空格产物名。
- 发布：推送 `v0.1.1` 后确认 Release 含 exe、blockmap、`latest.yml`、`SHA256SUMS.txt`。
- Pages：部署后对首页与教程 URL 做 HTTP 200 检查。

## 风险与约束

- 安装包未签名，SmartScreen 提示与代码签名无关，仍会存在。
- Pages 需要在仓库设置中启用 GitHub Actions 作为构建来源；该设置只做一次。
- 更新依赖 GitHub Releases 可达；手动检查失败不应影响本地路由服务。
- `latest.yml` 必须与 release 资产同时存在，否则更新器无法解析版本。
