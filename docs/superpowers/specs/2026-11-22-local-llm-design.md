# TokenHUB 本地大模型运行能力设计

- 日期：2026-11-22
- 状态：设计已确认（引擎、分发、HF 源、路由定位四项决策）
- 目标版本：0.2.0

## 1. 目标与范围

给 TokenHUB 增加本地 GGUF 模型运行能力：

- 自动识别 NVIDIA / AMD 显卡并选择推理后端；本机 RX 7900 XTX（RDNA3，24GB）必须被正确识别、正确加载、可实际推理。
- 新增「本地模型」页面：硬件状态、运行时安装、HF 浏览与下载、已装模型管理、运行状态。
- 以 HuggingFace 为模型源，通过其公开 API 搜索模型、列文件、断点续传下载 GGUF。
- 本地实例作为内置「本地」供应商接入现有路由：优先级可调、默认排在云端之后、只有已加载模型才参与路由。

**已确认决策**

| 决策 | 选择 |
|---|---|
| 推理引擎 | 内置 llama.cpp，`llama-server` 子进程 |
| 运行时分发 | 按需下载（可选镜像、支持手动导入 ZIP） |
| HF 源 | 官方 `huggingface.co` 默认，设置页可切 `hf-mirror.com` |
| 路由定位 | 内置本地供应商，可调优先级，只有已加载模型参与路由 |

**不在本期范围**

- 训练/微调、多模态图像生成、分布式推理。
- 同时加载多个模型（P1 单模型，切换即换载）。
- CPU 推理性能承诺（保留 CPU 兜底后端，仅作无显卡兜底）。
- 模型许可证合规校验（页面只展示 license 与仓库链接）。
- 局域网/远程访问（所有本地服务只绑 `127.0.0.1`）。

## 2. 总体架构

```
渲染进程 src/pages/LocalModelsPage.tsx
        │ window.tokenhub.local.*（IPC invoke + localState 推送）
主进程 electron/ipc.ts
        │
core/local/LocalService（门面，不依赖 Electron）
  ├─ hardware.ts          显卡/显存识别、后端推荐
  ├─ runtimeInstaller.ts  GitHub release 资产解析、下载、解压、校验
  ├─ hf.ts                HF 搜索/详情/下载 URL、镜像与 Token
  ├─ downloader.ts        下载队列、断点续传、磁盘检查
  ├─ library.ts           modelsDir 扫描、GGUF 分组、模型 ID、删除
  └─ runtime.ts           llama-server 进程生命周期、健康检查、日志
        │ syncLocalProvider(baseUrl, models, meta)
core/hub.ts  ← 内置 provider(id='local', preset='local')
        │ http://127.0.0.1:<localPort>/v1（无 Authorization）
   llama-server.exe（只绑 127.0.0.1）
```

原则：`core/local/` 全部不依赖 Electron，进程与网络都可注入，便于单测；Hub 只认识「一个 OpenAI 兼容供应商」，不感知 llama.cpp 细节。

## 3. 硬件识别与后端选择

### 3.1 识别（Windows）

PowerShell 一次采集，输出 JSON：

- `Get-CimInstance Win32_VideoController`：名称、`PNPDeviceID`、`AdapterRAM`。
- 注册表 `HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\<序号>`：`DriverDesc` + `HardwareInformation.qwMemorySize`。

**关键坑**：`AdapterRAM` 是 uint32，24GB 显卡会被截断为约 4GB，必须用 `qwMemorySize` 取真实显存；取不到时才回退 `AdapterRAM` 并在界面标注「显存为估算值」。

厂商判定：`vendorId` 0x10DE=NVIDIA、0x1002=AMD、0x8086=Intel，名称正则兜底；过滤 `Microsoft Basic Display Adapter` 等虚拟/软件适配器。多显卡时按显存降序，标记推荐设备（独显优先，核显标注「核显，性能受限」）。

### 3.2 后端

| 显卡 | 推荐后端 | 说明 |
|---|---|---|
| NVIDIA | `cuda` | CUDA 12.4 构建，兼容当前主流驱动 |
| AMD | `vulkan` | RDNA3 官方支持，Windows 最稳路径；7900 XTX 默认走这里 |
| AMD（高级） | `rocm` | llama.cpp 已提供 `win-rocm-10.0-x64` 构建，P3 开放，默认不启用 |
| Intel / 无独显 | `vulkan` / `cpu` | CPU 仅兜底 |

设置项 `backend: 'auto' | 'cuda' | 'vulkan' | 'rocm'`，默认 `auto`。

### 3.3 真值校验

运行时安装完成后执行 `llama-server.exe --list-devices`，把实际识别到的设备与后端显示在硬件卡。这是唯一可信的能力判断：若列表里没有 7900 XTX，界面直接提示「更新显卡驱动（缺 Vulkan 运行时）」，不静默失败。

## 4. 运行时安装（按需下载）

### 4.1 资产解析

llama.cpp 的 GitHub `/releases/latest` 可能指向无二进制资产的发布（当前 `v1.0.0` 即如此），因此不能用 latest：

1. `GET https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10`
2. 取最新一个同时含目标资产的 release：
   - Vulkan：`llama-<tag>-bin-win-vulkan-x64.zip`
   - CUDA 12.4：`llama-<tag>-bin-win-cuda-12.4-x64.zip` + `cudart-llama-bin-win-cuda-12.4-x64.zip`（两者缺一不可）
   - CPU：`llama-<tag>-bin-win-cpu-x64.zip`
3. 下载到 `<dataDir>/local/downloads/runtime/`，测速与进度推送同模型下载。

`githubMirror` 设置项为下载 URL 前缀（如 `https://ghfast.top/`），默认空 = 直连；API 请求直连，失败时提示配置镜像或手动导入 ZIP。

### 4.2 解压与安装

- 解压用 PowerShell `Expand-Archive`（Windows 内置，不引额外依赖；项目本就是 Windows 应用）。
- 安装目录：`<dataDir>/local/runtime/<backend>/<tag>/`，自动处理 zip 内嵌套目录。
- 安装后校验 `llama-server.exe` 存在并运行 `--version`、`--list-devices`；记录 `local/runtime.json`：`{ backend, tag, installedAt, devices, sourceUrl }`。
- 卸载 = 停止进程后删除该后端目录。
- 手动导入：选择 llama.cpp 官方 zip，走同一解压/校验流程，作为网络不通兜底。

### 4.3 安全

- 记录来源 tag 与 URL；不执行 zip 内除 `llama-server.exe` / `llama-server --version|--list-devices` 之外的任何文件。
- 运行时与模型都不进安装包（`build.files` 不变），全部落在用户数据目录。

## 5. 本地供应商接入

### 5.1 内置供应商

- `Preset` 增加 `'local'`；`PROVIDER_PRESETS` 仍只列云端预设，「添加供应商」对话框不会出现本地项。
- Hub 新增 `syncLocalProvider(input)`：确保存在 `id='local'` 的供应商（`preset='local'`、`quotaAdapter='none'`、`maxConcurrency=1`、`baseUrl=http://127.0.0.1:<localPort>/v1`），按入参更新 `models.cached` 与 `modelDiscovery`，然后 `rebuildCatalog()` + `emit()`。
- 默认排在 `config.providers` 末尾；用户可拖拽调整优先级，与云端一致。`enabled` 开关保留。
- 模型加载成功后：`models.cached = [模型ID]`、`modelDiscovery[模型ID] = { contextLength, vision:false }`。
- 停止/崩溃/卸载后：`models.cached = []`，本地模型立即从 catalog 与 `/v1/models` 消失，避免请求静默转到云端。
- 供应商页对 `preset==='local'`：允许启用/停用与排序；隐藏删除、测试、扫描、刷新、编辑 Key/Base URL。
- 跳过该供应商的模型发现、协议扫描与额度探针（`quotaAdapter='none'` 已跳过探针；`refreshStaleModels` 因无 Key 自然跳过）。

### 5.2 无 Key 转发

现有 `core/server/app.ts` 在 `getProviderKey` 为 null 时直接按 401 失败。调整：

- 本地供应商允许空 Key：`apiKey = getProviderKey(id) ?? (preset === 'local' ? '' : null)`；仍为 null 才走 auth 失败。
- `forward.ts` 的 `Authorization` / `x-api-key` 仅在 Key 非空时附加。
- 协议：本地只走 OpenAI 形状（llama-server `/v1/chat/completions`）；Anthropic 客户端由现有双向转译处理，`defaultProtocolSupport('local') = { openai:true, anthropic:false }`。

### 5.3 请求路径

客户端 → 网关 → 目录命中 `local` → 并发闸（1 路，满员按优先级转下一家）→ 转发到 llama-server → 流式返回。历史、用量、速度仪表自动生效（llama-server 返回标准 usage）。

## 6. llama-server 进程管理

### 6.1 启动参数

```
llama-server.exe
  -m <gguf 路径>
  --host 127.0.0.1
  --port <localPort>
  -c <上下文>              # 默认 8192，可在页面调整
  -ngl 99                  # 全部层卸载到 GPU
  -np 1                    # 单路并行，与 maxConcurrency=1 对应
  --jinja                  # 启用模型自带对话模板 / 工具调用
```

实现前用 `llama-server --help` 核对参数名；不确定的开关不加。

- `localPort` 默认 8788，可配置，必须与主服务端口不同且未占用。
- 加载超时 180s（大模型从磁盘冷读可能很慢），期间状态 `starting`；`/health` 200 且 `/props` 可读即 `running`。
- 从 `/props` 读取实际 `n_ctx` 写回模型元数据。
- 日志：stdout/stderr 只进内存环形缓冲（保留最近 200 行），状态里带最近 20 行；不落盘、不写 `local/logs/llama-server.log`，日志仅供界面与错误排查使用，重启即丢失。

### 6.2 停止与异常

- 切换模型：先停止旧进程（立即 `child.kill()`，随后 `taskkill /pid <pid> /T /F` 兜底整个进程树，不等待优雅退出），再启动新进程。
- 崩溃：记录退出码与日志尾部，状态转 `error`；本地供应商置为不可路由（`runtime.reset` 不适用，由 Hub `syncLocalProvider` 清空模型即可），请求不再尝试本地。
- 应用退出：`electron/main.ts` 的 `before-quit` 先 `localService.shutdown()` 再关闭 Hub，确保无残留 llama-server。
- 端口占用：启动失败给出明确提示并建议改 `localPort`，不影响主网关。

## 7. HuggingFace 模型库

### 7.1 端点与 Token

- `hfEndpoint: 'official' | 'mirror' | 'custom'`，默认 official；mirror = `https://hf-mirror.com`；custom 允许填自建反代。
- 所有 API 与下载 URL 同源切换。
- 可选 HF Token：只存 `secrets.bin`（`SecretStore` 增加 `hfToken` 字段，向后兼容旧文件），仅作请求头；界面只显示「已设置」。用于 Gated 模型与更高频率上限。

### 7.2 API

- 搜索：`GET {base}/api/models?search=<kw>&filter=gguf&sort=downloads&direction=-1&limit=50`；结果展示 id、downloads、likes、lastModified、license（来自 tags）、gated。
- 详情：`GET {base}/api/models/<org>/<repo>?blobs=true`，取 `siblings[]` 的 `rfilename`、`size`/`lfs.size`；只保留 `.gguf`，解析量化标记（文件名中的 `Q4_K_M` 等）、分片（`-00001-of-000NN`）与 `mmproj`（P3 使用，P1 只展示）。
- 下载：`GET {base}/<org>/<repo>/resolve/main/<rfilename>`，带 Token 时加 `Authorization: Bearer`。
- Gated/401/403：提示设置 Token；404：提示仓库或文件不存在。

### 7.3 下载器

- 任务按「模型」聚合（多分片顺序下载），持久化到 `local/downloads.json`，重启后续传。
- `.part` 临时文件 + `Range: bytes=<have>-`：206 追加，200 从头写；完成后原子改名。
- 目标路径 `<modelsDir>/<org>/<repo>/<rfilename>`；`rfilename` 拒绝绝对路径与 `..`，org/repo 需匹配 `^[\w.-]+/[\w.-]+$`。
- 同时最多 2 个下载任务；进度与速度 300ms 节流推送。
- 删除/取消任务清掉 `.part`；磁盘空间不足（可用空间 < 固定 2 GB 下限 `MIN_FREE_BYTES`，与模型大小无关）时拒绝开始。

## 8. 模型库与模型 ID

- `modelsDir` 默认 `<dataDir>/models`，可在本地模型页修改为任意绝对路径；修改后重新扫描。
- 扫描 `modelsDir` 下最多 3 层 `*.gguf`，忽略 `.part`、`mmproj-*`（单列展示，不参与推理）。
- 分片分组：`<name>-00001-of-000NN.gguf` 必须整组齐全才视为可用，大小求和。
- 模型 ID：分片主文件名去掉 `-00001-of-000NN` 与 `.gguf`，非法字符替换为 `-`；与其他模型冲突时追加 `@<org-repo>` 去重。
- 只读扫描，不改文件；删除模型需二次确认，且先停止正在加载的模型。
- 手动放文件也可用：「打开模型目录」+「重新扫描」。

## 9. 数据与配置

不扩展 `AppConfig`（避免版本与广播负担），新增独立文件：

| 文件 | 内容 |
|---|---|
| `<dataDir>/local.json` | `LocalSettings`：`modelsDir`、`localPort`、`backend`、`hfEndpoint`、`hfEndpointCustom`、`githubMirror`、`defaultContext` |
| `<dataDir>/local/runtime.json` | 已安装运行时：backend、tag、installedAt、devices、sourceUrl |
| `<dataDir>/local/downloads.json` | 下载任务与断点位置 |

`SecretStore` 增加可选 `hfToken`；`secrets.bin` 旧文件缺少该字段时按 null 处理，保存后补上。

本地状态走独立 IPC 推送，不塞进 `AppState`，避免下载进度高频广播整个应用状态。

## 10. IPC 与界面

### 10.1 API（`window.tokenhub.local.*`）

```
getState(): LocalSnapshot
detectHardware(): LocalSnapshot
installRuntime(backend?): LocalSnapshot        removeRuntime(backend): LocalSnapshot
importRuntimeZip(): LocalSnapshot
searchHf(query): HfSearchResult[]              getHfModel(repo): HfModelDetail
download(repo, files: string[]): LocalSnapshot
pauseDownload(id) / resumeDownload(id) / cancelDownload(id)
loadModel(id, contextSize?) / stopModel() / deleteModel(id)
refreshModels()
updateSettings(patch: Partial<LocalSettings>)
setHfToken(token: string | null)
revealModelsDir()
onState(cb): () => void   // 频道 tokenhub:localState
```

`LocalSnapshot`：`{ hardware, install, runtime, models, downloads, settings, hfTokenSet }`；不含 Token 明文。

### 10.2 「本地模型」页面

导航新增 `本地模型`（`Cpu` 图标），页面分五块：

1. **硬件卡**：显卡名/厂商/显存/推荐后端；运行时状态（未安装/版本/后端/`--list-devices` 结果）；安装、更新、卸载、导入 ZIP；模型目录与端口设置。
2. **已安装模型**：名称、量化、大小、加载状态；加载（可选上下文）、停止、删除、打开目录、重新扫描。
3. **运行状态**：运行中模型、端口、实际上下文、速度、最近日志（可展开）；错误时显示原因与建议。
4. **HuggingFace**：搜索框、按下载量排序的结果列表（license、gated 标记）；详情抽屉展示 GGUF 文件、量化、大小、分片、磁盘空间提示与下载按钮。
5. **下载队列**：进度、速度、暂停/继续/取消、错误信息。

视觉沿用现有 `surface/canvas/meter-*` 令牌；计量条必须复用 `meter-*` 色板。

## 11. 错误处理

| 场景 | 行为 |
|---|---|
| 无网络 / HF 不可达 | 搜索区显示错误 + 「切换镜像」快捷入口 |
| Gated / 401 | 提示设置 HF Token |
| 运行时下载失败 | 显示失败阶段（API/资产/下载/解压/校验）+ 镜像提示 + 导入 ZIP |
| 驱动缺 Vulkan | `--list-devices` 无显卡时提示更新驱动 |
| 端口占用 | 提示改 `localPort`，主网关不受影响 |
| 模型加载 OOM | 展示日志尾部，建议降上下文、减 `-ngl`（P3 提供界面项）或换更小量化 |
| llama-server 崩溃 | 状态 `error`、本地模型退出 catalog；其他候选按现有规则继续 |
| modelsDir 不可写/空间不足 | 开始前拦截并提示 |

## 12. 测试与验证

**单测（`tests/unit`）**

- 硬件报告解析（PowerShell/注册表 JSON fixture）、厂商判定、显存 >4GB、核显/独显排序。
- 后端选择矩阵（NVIDIA/AMD/Intel/无卡 × auto/手动覆盖）。
- 运行时资产选择：从多 release 中挑同时含 cuda+udart 的版本。
- HF URL 构造（官方/镜像/custom、编码、Token 头）、文件过滤与分片识别、量化解析。
- 模型 ID 规范化与冲突去重。
- 下载断点续传：206/200、`.part` 清理、磁盘空间拦截（注入 fetch/fs）。
- llama-server 参数构造；进程崩溃解析。

**集成（`tests/integration`）**

- 注入 `spawnFn` 启动假 llama-server（Node HTTP：`/health`、`/props`、`/v1/models`、`/v1/chat/completions`），验证加载→同步 catalog→网关转发→流式回传→停止清空。
- 无 Key 本地供应商转发不被 401 拦截；云端供应商缺 Key 仍 401（回归）。
- 崩溃：状态转 error、模型退出 catalog、其他候选可路由。
- 下载器：临时目录中分片下载、重启续传。

**E2E（Playwright Electron）**

- 无运行时/无 GPU 的干净数据目录：页面可打开，硬件卡与空状态正常，安装按钮可用（不真的下载）。
- 本地供应商在供应商页可见、不可删除、可排序。

**真机验收（7900 XTX）**

1. 硬件卡显示「AMD Radeon RX 7900 XTX · 24GB · 推荐 Vulkan」，核显 780M 被识别且不在推荐位。
2. 安装 Vulkan 运行时后 `--list-devices` 列出 7900 XTX。
3. 下载并加载一个 Q4_K_M 模型，`/health` 通过，网关 `/v1/models` 出现该模型。
4. OpenAI 与 Anthropic 客户端均可流式调用，历史与用量有记录。
5. 切换模型、停止、崩溃恢复状态正确；退出应用后无残留 `llama-server` 进程。
6. 打包版（`npm run dist`）同样可用，运行时与模型不进入安装包。

**验证门**：`npm run typecheck && npm test && npm run build && npx playwright test`；涉及打包时 `npm run dist` 并核对安装包不含运行时/模型。

## 13. 实施分期

- **P1 运行时与路由**：硬件识别、运行时安装、模型库扫描、加载/停止、本地供应商接入、无 Key 转发、供应商页适配、页面骨架与运行状态。
- **P2 HF 与下载**：搜索/详情、镜像与 Token、下载队列与续传、设置项。
- **P3 增强**：ROCm 后端、`mmproj` 视觉、空闲自动卸载、VRAM/上下文估算、GGUF 元数据预解析、`-ngl` 界面调节。

## 14. 交付同步

- 实现完成后更新根 `AGENTS.md`：本地运行时目录与文件、`localPort`、无 Key 转发契约、只有已加载模型参与路由、运行时按需下载与镜像设置、7900 XTX 验证路径。
- 新模块注释只写 WHY 与契约（例如 `qwMemorySize` 的必要性、`releases?per_page=10` 的选取规则），不写变更史。
