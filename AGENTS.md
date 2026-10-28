# TokenHUB

本地多供应商大模型 API 网关：对外提供 OpenAI 与 Anthropic 兼容接口，按供应商优先级路由，额度耗尽时自动切换。

## 常用命令

- `npm run dev`：Electron 开发模式
- `npm test`：Vitest 单元 + 集成测试
- `npm run typecheck`：Node/Web 两个 tsconfig 的类型检查
- `npm run build`：electron-vite 构建到 `out/`
- `npx playwright test`：Electron E2E（先构建）
- `npm run dist`：构建并打 NSIS 安装包到 `release/`
- 首次运行 Electron 需要二进制；网络不通时用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

## 目录与职责

- `core/`：不依赖 Electron 的核心逻辑（配置、密钥、供应商、路由、协议、额度、Hub）。
- `electron/`：主进程、托盘、IPC、preload、safeStorage 适配。
- `src/`：React + Tailwind 渲染进程，只通过 `window.tokenhub` 调用 IPC。
- `tests/unit`、`tests/integration`、`tests/e2e`：单测、假上游集成、Playwright Electron。

## 稳定契约与易踩的坑

- 本地服务只绑定 `127.0.0.1`，默认端口 8787；端口与本地 Key 可在设置页修改。
- 供应商优先级等于 `config.providers` 数组顺序；任何增删改、重排、启停都必须重建 `catalog`，否则路由顺序会停留在旧值。
- 密钥只保存在 `%APPDATA%/TokenHUB/secrets.bin`（Electron safeStorage/DPAPI），禁止明文落盘、写日志或历史；历史只存请求元数据。
- OpenCode Go 额度查询使用控制台同款 `/zen/go/v1/usage` 接口；响应无法识别时必须按探针失败处理，不能当成“正常”。
- CommandCode Goat 没有公开额度接口，只能靠 429/402 错误码与冷却；DeepSeek 用 `/user/balance`。
- Anthropic 转译：`tool_result` 必须排在用户文本之前；如果响应/流里出现 `tool_use` 块，`finish_reason: stop` 也要映射为 `tool_use`；流式故障切换只允许发生在首字节前。
- 客户端中断不算供应商故障，不得冷却供应商；上游在首字节后截断则按 transient 冷却，但不切换。
- Electron 开发/E2E 不写系统自启项（`app.isPackaged` 守卫）；E2E 使用临时 `TOKENHUB_DATA_DIR` 与 `TOKENHUB_PORT`。
- 启动时端口被占用不是致命错误：`Hub.init` 记录 `server.error` 照常完成，窗口必须出现；用户在设置页重新提交端口才重启监听（相同端口也允许重试）。
- 端口切换必须先持久化并广播新端口，再后台关闭旧监听；`startServer` 的 `close()` 先断空闲连接、2s 宽限后强制断开，任何情况下都 resolve。
- 未知模型（本地目录没有）与上游 404 共用同一个 60s 限流、在途合并的模型发现刷新。
- `build.files` 只打包 `out/main`、`out/preload`、`out/renderer` 与 `package.json`；E2E 截图写在 `out/*.png`，故意不进安装包。
- 未得到用户明确要求，不执行 `git add` / `git commit` / `git push`。
- 打包后若 `release/win-unpacked*` 被外部句柄锁定，需在句柄释放/重启后清理再重跑 `npm run dist`；可用干净的 `--config.directories.output=<临时目录>` 生成安装包后回填。

## 验证门

声称“完成/修复/通过”前，至少运行 `npm run typecheck && npm test`；涉及 Electron/UI 时加 `npm run build && npx playwright test`；涉及打包时运行 `npm run dist` 或等价的 electron-builder 命令并核对安装包内容。
