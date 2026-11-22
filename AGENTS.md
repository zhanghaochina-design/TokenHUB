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
- 模型能力元数据（上下文长度、视觉、思考参数）按「供应商 + 上游模型 ID」保存，生效优先级：`provider.modelMeta`（手动覆盖）> `provider.modelDiscovery`（刷新模型时按上游 `/models` 响应整体重写）> `core/providers/modelMeta.ts` 内置建议表（`MODEL_META_AS_OF` 标注采集时间，未命中的模型为未标注）。上游字段来源：OpenCode Go 的 `limit.context`、`modalities.input`、`capabilities.reasoning.effort`（思考参数记为 `effort`）；CommandCode 只有 `context_length` 与入口声明 `supported_endpoints`；DeepSeek 官方 `/models` 只有 ID，走内置/手动。思考参数沿用上游原生参数名与取值（如 `effort`、`thinking.budget_tokens`、`none`、`builtin`），网关只展示不换算、不注入。统一模型的聚合口径：上下文取各目标最小值，视觉任一支持即支持，思考仅在同一参数名时取交集，否则不聚合。`/v1/models` 两种形状都追加 `context_length` 与 `capabilities: { vision, thinking }`，客户端不读取时无影响。
- 模型可见性按「供应商 + 上游模型」保存在 `provider.models`：`hidden`（手动隐藏）、`scanHidden`（扫描自动隐藏）、`shown`（用户对自动隐藏的显式恢复）。生效隐藏 = (hidden ∪ scanHidden) − shown，只影响模型页与 `/v1/models` 的展示，路由、别名与故障切换不受影响；合并模型只有在全部目标隐藏时才从列表消失。扫描仅当同一模型的 A/O 两个入口都明确为 `false` 时自动隐藏，任一入口为 `true` 即自动显示，`null`（超时/限流）保持原状；本轮未扫描到的模型不被改动。
- 密钥只保存在 `%APPDATA%/TokenHUB/secrets.bin`（Electron safeStorage/DPAPI），禁止明文落盘、写日志或历史；历史只存请求元数据。
- OpenCode Go 额度查询使用控制台同款 `/zen/go/v1/usage` 接口；响应无法识别时必须按探针失败处理，不能当成“正常”。
- CommandCode Goat 用控制台同款 `/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/whoami`（Bearer Provider API Key）读取 5 小时/周/月额度；个人账号的 whoami 返回 `org: null`，订阅必须不带参数查询（把 user id 当 `orgId` 会 403），团队账号仍按 `orgId` 过滤；未识别套餐时月上限按 $70 估算，余额高于上限时以余额定标；接口未公开，403/解析失败按探针失败处理，401 才是 Key 无效；DeepSeek 用 `/user/balance`。
- DeepSeek 的 Anthropic 入口与 OpenAI 不同：官方 Anthropic base 为 `https://api.deepseek.com/anthropic/v1`（OpenCode Go/CommandCode 仍与 Base URL 共用）。供应商可配置 `anthropicBaseUrl` 覆盖；留空时 DeepSeek 官方域名自动推导，其它预设沿用 Base URL。扫描与 `/messages` 转发都必须走这个 resolver。
- Anthropic 转译：`tool_result` 必须排在用户文本之前；如果响应/流里出现 `tool_use` 块，`finish_reason: stop` 也要映射为 `tool_use`；流式故障切换只允许发生在首字节前。
- Anthropic 用量口径：总输入 = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`；上游可能只在最终 `message_delta` 给输入量（OpenCode Go 实测 `message_start` 全为 0），旁路解析与非流式读取都不得只看 `message_start` / 单取 `input_tokens`。
- 上游协议按客户端入口 + 能力表选择：本地 `/v1/messages` 优先直连上游 `/messages`，本地 `/v1/chat/completions` 优先直连 `/chat/completions`；`provider.protocolSupport` 明确不支持时改走另一形状，未知时按预设兜底（CommandCode 按模型，OpenCode Go 两端皆可，其余仅 Chat）。首字节前 400/404/405/422/5xx 会换另一入口重试一次；401/402/429 与首字节后失败不换。CommandCode 的 `claude*` 模型只能走 `/messages`，其余只能走 `/chat/completions`；OpenAI 客户端请求这些 Claude 模型时走双向转译（`core/protocol/openai.ts`）。OpenCode Go 的 `/messages` 实测也支持 DeepSeek（官方文档未标注）。
- 上游 `/models` 若声明 `supported_endpoints`（CommandCode），刷新模型时按模型保存到 `provider.endpointDiscovery`，只映射网关认识的 `/messages`（anthropic）与 `/chat/completions`（openai），整体重写且不推断缺失字段。扫描只探测声明的入口，未声明的入口不发请求、直接记不支持；CommandCode 缺少该声明时首次扫描会先补一次模型发现（失败按无声明继续）。只有实际探测的入口全部 401（Key 无效）才提前停止，403/402 只记录当前模型并继续。扫描结果仍存 `protocolSupport`；探测为 `null`（超时/限流/403 权限拒绝）时，能力判断与界面用 `endpointDiscovery` 兜底，避免把套餐/地区限制误判成协议不支持。扫描不写历史、不计供应商冷却。
- 额度探针默认每 5 分钟探测一次（`quotaRefreshSec` 默认 300，可调）；失败按 30s/1m/2m/4m/8m/15m 指数退避并写 WARN 日志，任何一次成功探测（含手动刷新）都清零失败计数，不得永久停用探针。
- 额度卡速度仪表由 `getSpeedStats(day)` 聚合当天历史：只统计流式成功请求，速度 = 输出 token ÷（总耗时 − 首字节耗时）；生成耗时 <100ms 或速度 >1000 t/s 视为测量噪声，不参与仪表。
- 「用量」标签页由 `getUsageStats()` 跨多天聚合历史（`HistoryStore.listRange`），每供应商输出 5 小时/周/月 三个周期的累计 token（输入+输出，只统计成功请求）。探针只给百分比/美元额度、不含 token，故 token 数必须来自本地历史；周期边界用探针 `resetsAt` 反推（`resetsAt − 周期时长`，OpenCode Go/CommandCode），重置时间缺失/已过期、DeepSeek 余额快照及无探针供应商回退「最近 5 小时/7 天/30 天」滚动；月周期按 30 天近似。窗口起点早于历史保留 cutoff 时标 `partial`，界面提示「数据不足」。聚合纯函数在 `core/usage.ts`（`resolveUsageWindows` + `computeUsageStats`），柱状图为手写 SVG（`src/components/UsageBarChart.tsx`），不引图表库。
- 计量类视觉（进度条、仪表）只使用 `meter-*` 色板：轨道统一 `meter-track`；常态填充 `meter-primary`，用量输入 `meter-soft`，仪表指针 `meter-strong`，平均弧为 `meter-soft→meter-primary` 渐变；仅额度条按 <70% 主蓝、70–89% 琥珀、≥90% 红切警示色。状态点与徽标仍用绿/琥珀/红语义色，不属于计量色板；新增进度条必须复用这些 token。
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
- 本地模型经内置 `local` 供应商接入路由：`llama-server` 只绑 `127.0.0.1:<localPort>`（默认 8788）且没有 API Key，`core/server/forward.ts` 对空 Key 不发鉴权头，云端供应商缺 Key 仍按 401 处理。只有已加载的模型进入 `provider.models.cached`，停止/崩溃/卸载后立即清空，否则请求会静默转到云端。
- 本地供应商由 Hub 独占维护：`addProvider` 拒绝 `preset: 'local'`，`deleteProvider` 与改 Base URL / API Key / `maxConcurrency` / 手动模型 / 额度适配器一律拒绝——这些字段由本地服务按运行状态同步，手改会被下一次同步覆盖；供应商页对本地项只暴露启停开关与拖拽排序（优先级就是 `config.providers` 顺序，重排后照常重建 `catalog`），本地模型的展示隐藏仍在模型页切换。
- `localPort` 与监听端口无关：它是 llama-server 的端口，变更后即使没有已加载模型也要重新 `syncLocalProvider`，否则供应商 `baseUrl` 停在旧端口。设置先原子写 `local.json` 再同步本地服务。
- 显存必须读注册表 `HardwareInformation.qwMemorySize`（WMI `AdapterRAM` 是 uint32，24GB 会截断成 ~4GB），按 `MatchingDeviceId` 的设备 ID 精确配对、再退化到名称匹配，`vramEstimated` 标出估算值。AMD 默认 Vulkan、NVIDIA 默认 CUDA 12.4，ROCm 只在用户显式选择时使用。设备真值来自 `llama-server --list-devices`：安装门槛是两个各带 15s 超时的探针（`--version` 与非空 `--list-devices`），任一非零退出或空输出都拒绝该包并把安装错误抛到界面；已安装记录没有报出设备时硬件卡只显示「未报告设备」，不做驱动提示。
- 双探针缺一不可（`probeRuntime`）：只跑 `--list-devices` 时缺 DLL 的坏包会被解析成空列表并记成「安装成功」，所以安装前必须先用 `--version` 确认二进制能跑。安装/导入互斥（`installing` 为真直接拒绝），进度经 `LocalSnapshot.installProgress` 上浮、结束（成功或失败）清空，目前不支持取消安装。
- 运行时资产从 GitHub `releases?per_page=10` 列表里挑第一个「资产齐全」的版本，不能依赖 `/releases/latest`（可能指向没有 Windows 资产的版本）；CUDA 需要主包加 `cudart-llama-bin-win-cuda-12.4-x64.zip`，两个 zip 必须**追加**解压进同一 staging 目录，校验通过后才换目录、写记录。
- 运行时、GGUF 与本地配置都落在数据目录：`local/runtime/`、`models/`（可在设置里改目录，手动放入 GGUF 后「重新扫描」即可加载）、`local.json`、`local/runtime.json`、`local/downloads.json`，都不进安装包；这三个 JSON 一律原子写（`.tmp` + rename），HF Token 只存 `secrets.bin`。
- HF 源只在 `hfBaseUrl` 一处推导（官方 / `hf-mirror.com` / 自定义），API 请求统一 15s 超时并覆盖响应体读取；401/403 提示「需要 Token 或需要授权」而不是网络故障，仓库 ID 必须是 `org/repo` 且拒绝 `.`/`..`。
- 下载用 `.part` + Range 断点续传；入队前要求模型目录可用空间 ≥2 GB（`MIN_FREE_BYTES`），并拒绝同一仓库同一文件的活动任务重叠——两条任务写同一个 `.part` 会拼出坏文件。重启时只把非终态任务降级为 paused，绝不自动续传。
- 分片模型要整组 `-0000N-of-0000M` 齐全才进列表，删除必须走 `shardPaths(model)` 逐片删（只删第一个分片会留下永远拼不起来的残片）；`.gguf.part` 与 `mmproj-*` 不参与扫描。
- `LocalService.open` 在窗口创建前跑硬件探测与模型扫描，探测必须带超时且失败降级为「空列表 + 错误文案」，否则挂住的 PowerShell 会让窗口不出现；llama-server 就绪探针单次上限 5s，`/props` 在途时发生停止/退出，状态不得被翻回 `running`。

## 验证门

声称“完成/修复/通过”前，至少运行 `npm run typecheck && npm test`；涉及 Electron/UI 时加 `npm run build && npx playwright test`；涉及打包时运行 `npm run dist` 或等价的 electron-builder 命令并核对安装包内容。
