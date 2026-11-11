# TokenHUB

本地多供应商大模型 API 网关：对外提供 OpenAI 与 Anthropic 兼容接口，按供应商优先级路由，额度耗尽时自动切换。

## 常用命令

- `npm run dev`：Electron 开发模式
- `npm test`：Vitest 单元 + 集成测试
- `npm run typecheck`：Node/Web 两个 tsconfig 的类型检查
- `npm run build`：electron-vite 构建到 `out/`
- `npx playwright test`：Electron E2E（先构建）
- `npm run dist`：构建并打 NSIS 安装包到 `release/`
- 发布：`package.json` 的 `version` 必须与推送的 tag 一致（如 `0.1.0` 对应 `v0.1.0`）；推送 tag 触发 `.github/workflows/release.yml`，在 Windows runner 上跑类型检查、测试与打包，并创建 GitHub Release（附 exe、blockmap 与 `SHA256SUMS.txt`）
- `node docs/readme/build.mjs`：由 `docs/readme/` 的模板与截图生成根目录 `README.html`
- 首次运行 Electron 需要二进制；网络不通时用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

## 目录与职责

- `core/`：不依赖 Electron 的核心逻辑（配置、密钥、供应商、路由、协议、额度、Hub）。
- `electron/`：主进程、托盘、IPC、preload、safeStorage 适配。
- `src/`：React + Tailwind 渲染进程，只通过 `window.tokenhub` 调用 IPC。
- `tests/unit`、`tests/integration`、`tests/e2e`：单测、假上游集成、Playwright Electron。
- `docs/readme/`：HTML README 的模板、截图与生成脚本；产物是根目录 `README.html`，不要直接改产物。
- `docs/toutiao/`：头条推广素材（含 DOCX/ZIP 生成物），整目录忽略，不入库。
- 共享 agent 规则只写 `AGENTS.md`；`.claude/`、`.qoder/`、`.cursor/` 等工具目录及 `.mcp.json`、`AGENTS.local.md` 属本地状态，已忽略不入库。

## 稳定契约与易踩的坑

- 本地服务只绑定 `127.0.0.1`，默认端口 8787；端口与本地 Key 可在设置页修改。
- 供应商优先级等于 `config.providers` 数组顺序；任何增删改、重排、启停都必须重建 `catalog`，否则路由顺序会停留在旧值。
- `config.modelAliases` 是本地统一模型 ID 到各供应商 upstream ID 的手动映射；显式映射优先，原始 ID 恰好等于统一 ID 的其他供应商会自动纳入；被映射的原始 ID 从 `/v1/models` 隐藏，仍可用 `providerId/原始ID` 强制访问。模型页的自动建议只生成候选，绝不自动合并。
- 密钥只保存在 `%APPDATA%/TokenHUB/secrets.bin`（Electron safeStorage/DPAPI），禁止明文落盘、写日志或历史；历史只存请求元数据。
- OpenCode Go 额度查询使用控制台同款 `/zen/go/v1/usage` 接口；响应无法识别时必须按探针失败处理，不能当成“正常”。
- CommandCode Goat 用控制台同款 `/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/whoami`（Bearer Provider API Key）读取 5 小时/周/月额度；未识别套餐时月上限按 $70 估算，余额高于上限时以余额定标；接口未公开，403/解析失败按探针失败处理，401 才是 Key 无效；DeepSeek 用 `/user/balance`。
- DeepSeek 的 Anthropic 入口与 OpenAI 不同：官方 Anthropic base 为 `https://api.deepseek.com/anthropic/v1`（OpenCode Go/CommandCode 仍与 Base URL 共用）。供应商可配置 `anthropicBaseUrl` 覆盖；留空时 DeepSeek 官方域名自动推导，其它预设沿用 Base URL。扫描与 `/messages` 转发都必须走这个 resolver。
- Anthropic 转译：`tool_result` 必须排在用户文本之前；如果响应/流里出现 `tool_use` 块，`finish_reason: stop` 也要映射为 `tool_use`；流式故障切换只允许发生在首字节前。
- Anthropic 用量口径：总输入 = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`；上游可能只在最终 `message_delta` 给输入量（OpenCode Go 实测 `message_start` 全为 0），旁路解析与非流式读取都不得只看 `message_start` / 单取 `input_tokens`。
- 上游协议按客户端入口 + 能力表选择：本地 `/v1/messages` 优先直连上游 `/messages`，本地 `/v1/chat/completions` 优先直连 `/chat/completions`；`provider.protocolSupport` 明确不支持时改走另一形状，未知时按预设兜底（CommandCode 按模型，OpenCode Go 两端皆可，其余仅 Chat）。首字节前 400/404/405/422/5xx 会换另一入口重试一次；401/402/429 与首字节后失败不换。CommandCode 的 `claude*` 模型只能走 `/messages`，其余只能走 `/chat/completions`；OpenAI 客户端请求这些 Claude 模型时走双向转译（`core/protocol/openai.ts`）。OpenCode Go 的 `/messages` 实测也支持 DeepSeek（官方文档未标注）。
- 模型页「扫描」按供应商探测每个模型的 `/messages` 与 `/chat/completions`（max_tokens=16），结果持久化到 `config.json` 的 `protocolSupport`；扫描不写历史、不计供应商冷却。只有同一模型两个入口都 401（Key 无效）才提前停止，403/402 只记录当前模型并继续。
- 额度探针默认每 5 分钟探测一次（`quotaRefreshSec` 默认 300，可调）；失败按 30s/1m/2m/4m/8m/15m 指数退避并写 WARN 日志，任何一次成功探测（含手动刷新）都清零失败计数，不得永久停用探针。
- 额度卡速度仪表由 `getSpeedStats(day)` 聚合当天历史：只统计流式成功请求，速度 = 输出 token ÷（总耗时 − 首字节耗时）；生成耗时 <100ms 或速度 >1000 t/s 视为测量噪声，不参与仪表。
- OpenCode Go 要求 `x-opencode-session` 与可识别 User-Agent：优先透传客户端会话头（`x-claude-code-session-id` 等），缺失时每请求生成 UUID，否则上游返回 400。
- 客户端中断不算供应商故障，不得冷却供应商；上游在首字节后截断则按 transient 冷却，但不切换。瞬时故障冷却按连续次数退避 10/20/40/60 秒；因冷却导致无候选时，503 必须带 `Retry-After`（剩余秒数），客户端据此等待而不是立即重试。
- 每个供应商可配置 `maxConcurrency`（0=不限，OpenCode Go 与 CommandCode Goat 默认 3）；并发槽从请求开始持有到响应体结束（流式到流结束），满员时按优先级跳到下一家供应商，所有候选都满才在最高优先级排队；排队请求随客户端中断取消。概览页额度卡显示 Hub 持有的实时在途并发数（`AppState.concurrency`）。普通限流 429 在切换前先退避重试一次（默认 1.5 秒；`Retry-After` 超过 3 秒则直接切换），额度类 429 不重试。
- Electron 开发/E2E 不写系统自启项（`app.isPackaged` 守卫）；E2E 使用临时 `TOKENHUB_DATA_DIR` 与 `TOKENHUB_PORT`。
- `secrets.bin` 不能跨实例复用：safeStorage/DPAPI 与写入它的实例绑定，复制到其他数据目录会解密失败并按损坏隔离；真机联调必须在原实例内进行或重新录入 Key。
- 启动时端口被占用不是致命错误：`Hub.init` 记录 `server.error` 照常完成，窗口必须出现；用户在设置页重新提交端口才重启监听（相同端口也允许重试）。
- 端口切换必须先持久化并广播新端口，再后台关闭旧监听；`startServer` 的 `close()` 先断空闲连接、2s 宽限后强制断开，任何情况下都 resolve。
- 未知模型（本地目录没有）与上游 404 共用同一个 60s 限流、在途合并的模型发现刷新。
- `build.files` 只打包 `out/main`、`out/preload`、`out/renderer` 与 `package.json`；E2E 截图写在 `out/*.png`，故意不进安装包。
- 安装包与 exe 图标来自 `build/icon.ico`，`build/icon.png` 是源图；改图标后必须本地 `npm run dist` 并确认无签名警告以外的打包错误。
- 更新只允许手动触发；开发/E2E 不构造 electron-updater、不请求网络。发布资产必须包含 `latest.yml`，安装包名为 `TokenHUB-Setup-${version}.${ext}`（无空格），否则更新器与 GitHub 资产名对不上。
- 未得到用户明确要求，不执行 `git add` / `git commit` / `git push`。
- 打包后若 `release/win-unpacked*` 被外部句柄锁定，需在句柄释放/重启后清理再重跑 `npm run dist`；可用干净的 `--config.directories.output=<临时目录>` 生成安装包后回填。若换目录仍在移动 `default_app.asar` 时 `EBUSY`，用本地解压运行时绕过解压步骤：`electron-builder --win nsis --config.directories.output=<临时目录> --config.electronDist=node_modules/electron/dist`。

## 验证门

声称“完成/修复/通过”前，至少运行 `npm run typecheck && npm test`；涉及 Electron/UI 时加 `npm run build && npx playwright test`；涉及打包时运行 `npm run dist` 或等价的 electron-builder 命令并核对安装包内容。
