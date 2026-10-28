# TokenHUB 设计文档

- 日期：2026-10-28
- 状态：已确认架构方向（方案 A），待审阅
- 目标平台：Windows 11 x64（代码保持跨平台可行，首版只验收 Windows）

## 1. 背景与目标

本地有多个订阅制 / 按量计费的大模型入口，每个入口的额度和协议各不相同，Agent 工具需要反复改配置。TokenHUB 在用户电脑上提供一个统一的本地 API 网关，把多个上游合并成一组模型，按用户手动设定的优先级自动路由和故障切换，并在额度耗尽前完成切换。

首版接入三个供应商：

| 供应商 | 推理端点 | 额度类型 |
|---|---|---|
| OpenCode Go | `https://opencode.ai/zen/go/v1`（OpenAI 兼容） | 滚动 5 小时 / 周 / 月，按美元额度百分比 |
| CommandCode Goat | `https://api.commandcode.ai/provider/v1`（OpenAI 兼容） | 5 小时 / 周 / 月美元额度，无公开查询接口 |
| DeepSeek 官方 | `https://api.deepseek.com/v1`（OpenAI 兼容） | 账户余额（按量计费） |

核心目标：

1. 供应商增删改查、手动拖拽排序、启用/禁用。
2. 本地监听 `127.0.0.1`，对外提供 OpenAI 与 Anthropic 双协议接口，含流式。
3. 自动发现并合并各上游模型：同名模型在本地只出现一次，内部保留全部来源。
4. 同一个模型按供应商优先级逐个尝试；额度耗尽、限流、鉴权失败、5xx、网络错误时切换到下一个。
5. 额度可视化（可查询的用接口，不可查的靠错误码 + 冷却）和手动恢复。
6. API Key 使用 Windows DPAPI（Electron `safeStorage`）加密落盘，任何文件、日志、界面都不出现明文。
7. GUI 浅色主题，关闭窗口最小化到系统托盘。

## 2. 非目标（v1 不做）

- 一个供应商配置多个 Key / Key 池。
- 按模型单独排序（优先级只按供应商全局排序）。
- 抓取网页 Cookie 获取 CommandCode 额度。
- 入站 OpenAI Responses API（`/v1/responses`）。
- 局域网 / 公网访问、多用户、云端同步。
- 跨供应商模型 ID 自动归一（如 `glm-5.1` 与 `zai-org/glm-5.1` 合并）与费用估算图表。
- 自动更新。

## 3. 术语

- **供应商（Provider）**：一个上游入口，包含 baseURL、API Key、额度适配器和模型缓存。
- **合并模型（Merged Model）**：按模型 ID 精确合并后的本地模型名，可能对应多个供应商。
- **路由**：为一次请求选择候选供应商并按优先级尝试的过程。
- **额度适配器（Quota Adapter）**：查询供应商额度状态或依赖错误码判断耗尽的策略。
- **冷却（Cooldown）**：供应商临时不可路由的时间段，到期后允许试探请求。

## 4. 总体架构

```
┌──────────────────────────── Electron 主进程 ────────────────────────────┐
│                                                                          │
│  Agent ──HTTP──▶ Hono Server (127.0.0.1:8787)                            │
│                  │ 本地鉴权 → 协议解析 → 模型解析                         │
│                  ▼                                                       │
│              路由器（候选排序 / 过滤 / 故障切换 / 冷却）                   │
│                  │                                                       │
│      ┌───────────┼────────────┐                                          │
│      ▼           ▼            ▼                                          │
│  OpenCode Go  CommandCode   DeepSeek        ← 上游 OpenAI 兼容端点         │
│      │           │            │                                          │
│  额度适配器   错误码跟踪   余额适配器       ← 额度引擎                     │
│                                                                          │
│  配置存储（config.json）  密钥存储（safeStorage → secrets.bin）           │
│  模型目录缓存            历史记录（JSONL）   应用日志                      │
│  托盘 / 单实例 / 开机自启                                                 │
└──────────────────────────────▲───────────────────────────────────────────┘
                               │ IPC（contextBridge，类型化）
┌──────────────────────────────┴───────────────────────────────────────────┐
│ 渲染进程：React + Tailwind（浅色）                                         │
│ 概览 / 供应商 / 模型 / 设置                                               │
└──────────────────────────────────────────────────────────────────────────┘
```

采用单进程 Electron：代理服务与 UI 同在主进程，密钥只在主进程内解密和使用，渲染进程永远拿不到明文。核心代理按独立模块组织，未来可平移为独立 sidecar。

## 5. 技术栈与项目结构

- 运行时：Electron（含 Node 22+）、Vite、TypeScript（strict）
- 主进程 HTTP：Hono + `@hono/node-server`；上游请求使用 Node 内置 `fetch`（undici），流式透传用 `ReadableStream`
- 渲染进程：React + Tailwind CSS + lucide-react + dnd-kit（拖拽排序）
- 状态同步：IPC 直接调用 + 主进程事件推送（无额外状态库）
- 历史：按天 JSONL 分片（避免原生模块编译，打包稳定）
- 测试：Vitest（单元/集成）、Playwright Electron（冒烟）
- 打包：electron-builder，NSIS 安装包，`appId = com.tokenhub.app`

```
TokenHUB/
├─ electron/
│  ├─ main.ts            # 应用生命周期、单实例、托盘、开机自启
│  ├─ preload.ts         # contextBridge 暴露类型化 IPC
│  └─ ipc.ts             # IPC 路由（供应商/模型/额度/设置/历史）
├─ src/                  # 渲染进程 UI
│  ├─ pages/             # Overview / Providers / Models / Settings
│  ├─ components/
│  └─ lib/ipc.ts
├─ core/
│  ├─ server/            # Hono 应用、路由、鉴权、错误格式
│  ├─ protocol/
│  │  ├─ openai.ts       # OpenAI 入站处理与透传
│  │  ├─ anthropic.ts    # Anthropic 入站 → 内部表示
│  │  ├─ translate.ts    # OpenAI ↔ Anthropic 请求/响应/流式转译
│  │  └─ sse.ts          # SSE 解析与事件状态机
│  ├─ router/            # 候选生成、优先级、失败切换、冷却
│  ├─ providers/         # 预设、模型发现
│  ├─ quota/             # opencode-go / deepseek-balance / error-tracker
│  ├─ store/             # config / secrets / history / logger
│  └─ types.ts
├─ tests/
│  ├─ unit/
│  ├─ integration/       # 假上游服务器
│  └─ fixtures/          # 真实报文样例（脱敏）
└─ docs/superpowers/specs/
```

## 6. 核心模块设计

### 6.1 配置与密钥存储

存储位置：`%APPDATA%/TokenHUB/`

| 文件 | 内容 | 是否加密 |
|---|---|---|
| `config.json` | 供应商配置（不含 Key）、设置、模型缓存 | 否 |
| `secrets.bin` | 供应商 Key、本地访问 Key（JSON 整体加密） | 是，`safeStorage`（Windows DPAPI） |
| `quota-cache.json` | 最近一次额度快照，用于启动即显示 | 否（不含敏感数据） |
| `history/YYYY-MM-DD.jsonl` | 请求元数据 | 否 |
| `logs/app.log` | 应用日志（轮转，永不写 Key 与对话内容） | 否 |

密钥处理规则：

- 启动时 `safeStorage.isEncryptionAvailable()` 为假则禁止保存 Key，界面明确提示，不以明文兜底。
- 编辑供应商时界面只显示 `hasKey: true/false`，Key 输入框留空表示不修改。
- IPC 只返回掩码（如 `sk-****abcd` 由主进程生成），渲染进程不接触完整 Key。
- DPAPI 与当前 Windows 用户绑定：复制 `secrets.bin` 到其他机器/用户无法解密，属预期行为。

### 6.2 供应商接入与预设

供应商统一为 OpenAI 兼容类型，字段：

```ts
interface ProviderConfig {
  id: string;                 // nanoid
  name: string;               // 显示名
  preset: 'opencode-go' | 'commandcode' | 'deepseek' | 'custom';
  baseUrl: string;            // 不含 /chat/completions
  quotaAdapter: 'opencode-go' | 'deepseek-balance' | 'none';
  enabled: boolean;
  // 排序即数组顺序，数组下标即优先级（0 最高）
  models: {
    cached: string[];         // 最近一次发现结果
    manual: string[];         // 手动补充（接口不可用或漏报时）
    lastSyncedAt: string | null;
  };
  quota: {
    lowBalanceThreshold: number; // DeepSeek：余额低于此值视为耗尽，默认 0.5
    quotaCooldownMs: number;     // 无额度接口时（Goat）耗尽后的冷却，默认 5h
    injectStreamUsage: boolean;  // 流式时注入 stream_options.include_usage，默认 true
  };
}
```

添加供应商对话框提供三个预设，自动填好 baseURL、额度适配器与默认额度规则；`custom` 允许任意 OpenAI 兼容端点。

### 6.3 模型目录

- 触发发现：新增/编辑供应商保存后、点击「测试连接」、手动刷新、启动时缓存超过 24 小时、路由遇到 404。
- 发现方式：`GET {baseUrl}/models`，取 `data[].id`，与 `models.manual` 合并去重后缓存。
- 发现失败：保留旧缓存；界面提示；允许手动填写模型 ID 列表。
- 合并视图：按模型 ID 精确合并，生成 `{ id, providers: providerId[] }`。
- 对外 `/v1/models` 只列合并后的模型 ID，不列供应商前缀，避免 Agent 侧选择混乱。
- 请求中允许 `providerId/modelId` 的写法强制指定供应商（不在模型列表中出现，供调试和排障）。

### 6.4 路由引擎

一次请求的处理顺序：

1. 解析请求体，取出 `model`。
2. 解析模型：
   - `providerId/modelId` → 只路由到该供应商，校验其支持该模型；
   - 否则按合并模型查支持它的供应商集合。
3. 生成候选：过滤 `enabled=false`、状态为 `exhausted` 且未到恢复时间、`auth_error` 的供应商；按全局优先级（数组顺序）排序。
4. 逐个尝试，直到成功或候选耗尽。
5. 候选为空时返回 503，错误信息包含「没有可用供应商」及原因摘要。

**失败分类与动作**

| 上游结果 | 分类 | 动作 |
|---|---|---|
| 402 | 额度耗尽 | 标记 `exhausted`，冷却 = `quotaCooldownMs`（默认 5h），切换下一个 |
| 429 且报文匹配额度关键词（`quota/insufficient/balance/billing/payment/额度/余额/欠费/上限`） | 额度耗尽 | 同上 |
| 429 普通限流 | 限流 | 按 `Retry-After`，缺省 60s 短冷却，切换下一个 |
| 401 | 鉴权失败 | 标记 `auth_error`（不自动恢复，改 Key 或手动恢复后解除），切换下一个 |
| 403 且报文匹配额度关键词 | 额度耗尽 | 同 402 |
| 403 其他 | 鉴权失败 | 同 401 |
| 500/502/503/504 | 瞬时故障 | 60s 短冷却，切换下一个 |
| 网络错误 / 连接超时 | 瞬时故障 | 60s 短冷却，切换下一个 |
| 404 模型不存在 | 目录过期 | 触发该供应商模型刷新，切换下一个 |
| 400 / 422 | 请求错误 | **不切换**，原样返回给 Agent |

- 有额度探针的供应商命中额度类错误时，先触发一次探针刷新，耗尽截止时间以探针返回的 `resetsAt` 为准；探针不可用才用 `quotaCooldownMs` 兜底（默认 5h）。
- 连接超时 15s；首字节超时 120s；流式闲置超时 120s；均为常量，首版不做界面配置。
- 客户端断开连接时立即中止对应的上游请求（AbortController），释放连接。
- 冷却到期后允许一次试探请求：成功则恢复 `ok`，再次命中额度错误则重新计时。
- 同一请求对同一供应商不重试。
- 全部失败时返回最后一次的错误；若错误类型为请求错误（400/422）则立即返回，不继续尝试。
- 请求的模型在合并目录中不存在时返回 404（协议格式一致），并触发一次合并目录刷新（节流 60s）。
- 不做会话粘性：无状态转发，逐请求路由。

**运行时状态**（仅内存，与配置分离）：

```ts
interface ProviderRuntime {
  providerId: string;
  availability: 'ok' | 'exhausted' | 'rate_limited' | 'auth_error' | 'unknown';
  cooldownUntil: string | null;   // 短冷却到期时间
  lastErrorKind: string | null;
  consecutiveFailures: number;
  quota: QuotaSnapshot | null;    // 最近一次额度快照
}
```

过滤规则：`enabled=false`、`auth_error`、`exhausted` 且未到恢复时间、`cooldownUntil > now` 的供应商不参与路由。

**流式切换边界**：只有在尚未向 Agent 写出任何字节时允许切换。一旦开始输出，上游错误直接以 SSE 错误事件结束并记录。

### 6.5 额度引擎

接口：

```ts
type Availability = 'ok' | 'exhausted' | 'rate_limited' | 'auth_error' | 'unknown';

interface QuotaSnapshot {
  providerId: string;
  availability: Availability;
  windows?: {                    // OpenCode Go
    rolling?: { percent: number; resetsAt: string; status: string };
    weekly?:  { percent: number; resetsAt: string; status: string };
    monthly?: { percent: number; resetsAt: string; status: string };
  };
  balance?: { amount: number; currency: string };  // DeepSeek
  source: 'probe' | 'error' | 'manual' | 'initial';
  fetchedAt: string;
  note?: string;
}

interface QuotaAdapter {
  probe(provider: ProviderConfig, apiKey: string): Promise<QuotaSnapshot>;
}
```

**OpenCode Go**

- `GET https://opencode.ai/zen/go/v1/usage`，`Authorization: Bearer <key>`。
- 解析 `usage.rolling / weekly / monthly` 的 `percent`、`status`、`resetsAt`。
- 任一把额度窗口 `percent >= 100` 或 `status === 'rate-limited'` → `exhausted`；恢复时间取最晚的已耗尽窗口 `resetsAt`。
- 刷新周期 60s；路由到该供应商的请求完成后，下一轮刷新会反映最新额度。
- 该接口为官方控制台使用的非公开文档接口，存在变更风险：连续 3 次请求失败（非 401）则自动停用探针并降级为错误码模式，界面显示提示并提供「重新启用探针」按钮；应用重启后也会重新尝试。Key 无效（401）则标记 `auth_error`。

**DeepSeek 官方**

- `GET https://api.deepseek.com/user/balance`，`Authorization: Bearer <key>`。
- 取 `balance_infos[].total_balance`（可能多币种，取最大值比较），低于 `lowBalanceThreshold`（默认 0.5，单位同返回币种）→ `exhausted`。
- 刷新周期 5 分钟。
- 余额按量计费，无 5 小时/周窗口，界面只显示余额。

**CommandCode Goat（无公开额度接口）**

- 不做主动探测，按错误码判断：命中额度类错误 → `exhausted`，冷却 `quotaCooldownMs`（默认 5h）。
- 界面不显示百分比，显示「正常 / 冷却中（倒计时）/ 鉴权失败」，提供「恢复」按钮立即解除冷却。
- 冷却结束后允许试探请求，失败则重新冷却。
- 本地记录该供应商的请求数 / token 数，仅用于统计展示，不作为拦截依据。

**状态归属**：运行时状态保存在内存，变化时通过 IPC 推送到界面，并写回 `quota-cache.json` 以便启动秒显。

### 6.6 协议层

**对外端点**

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容，支持 SSE 流式 |
| `GET /v1/models` | 合并模型列表（OpenAI 格式） |
| `POST /v1/messages` | Anthropic 兼容，支持 SSE 事件流 |
| `POST /v1/messages/count_tokens` | 粗略估算（启发式），供 Claude Code 类客户端使用 |
| `GET /health` | 无需鉴权，返回运行状态与端口 |

`GET /v1/models` 同时服务两种协议：带 `anthropic-version` 请求头时返回 Anthropic 模型格式，否则返回 OpenAI 格式。

**OpenAI 入站**

- 请求体基本透传，`model` 替换为该供应商的实际模型 ID。
- 流式：默认注入 `stream_options: { include_usage: true }` 以便记录 token；若上游返回 400 且报文提及 `stream_options`，把该供应商配置的 `injectStreamUsage` 置为 false 并重试一次（仅限尚未输出内容时，界面可重新开启）。
- 响应：透传 SSE/JSON，仅在流中旁路解析 usage，不修改内容。
- 删除客户端带来的 `Authorization` / `x-api-key`，替换为供应商 Key。
- 错误格式保持 OpenAI：`{ "error": { "message", "type", "code" } }`。

**Anthropic 入站 → OpenAI 上游**

请求映射：

| Anthropic | OpenAI |
|---|---|
| `system`（字符串或 text 块数组） | 首部 `role: system` 消息 |
| `messages[].content` 文本块 | 文本内容 |
| `image`（base64/url） | `image_url`（data URL / 原 URL） |
| `tool_use` | assistant 消息的 `tool_calls` |
| `tool_result` | `role: tool` 消息（`tool_call_id`） |
| `thinking` / `redacted_thinking` | 丢弃 |
| `max_tokens` | `max_tokens` |
| `stop_sequences` | `stop` |
| `tools[]` | `tools[]`（function 格式，`input_schema` → `parameters`） |
| `tool_choice` | `auto` / `required` / 指定函数 |
| `metadata` / `top_k` / `thinking` 参数 | 丢弃 |
| `stream` | `stream` |

响应映射：

- `choices[0].message.content` → `content: [{type:'text'}]`
- `tool_calls` → `content: [{type:'tool_use', id, name, input}]`
- `finish_reason`：`stop → end_turn`（若响应或流中已出现 `tool_use` 块则映射为 `tool_use`），`length → max_tokens`，`tool_calls → tool_use`；上游在流中发送 `error` 帧时按失败处理。
- `usage.prompt_tokens → input_tokens`，`completion_tokens → output_tokens`；有 `prompt_tokens_details.cached_tokens` 时映射到 `cache_read_input_tokens`
- 生成 `id: msg_...`，`role: assistant`，`type: message`

流式事件状态机（OpenAI chunk → Anthropic SSE）：

1. 首个 chunk → `message_start`（`input_tokens` 使用本地启发式估算，因为 OpenAI 上游的 usage 在流末尾才返回且 Anthropic 协议不支持事后修正该字段；真实值写入历史记录）
2. 文本增量 → 延迟开启 `content_block_start(type:text)`，随后 `content_block_delta(text_delta)`
3. 工具调用增量（按 `tool_calls[].index` 聚合）→ `content_block_start(type:tool_use, id, name)` + `content_block_delta(input_json_delta, partial_json)`
4. 每个块结束 → `content_block_stop`
5. `finish_reason` + 最终 usage → `message_delta`（`stop_reason`、`output_tokens`）
6. 结束 → `message_stop`
7. 任何阶段上游出错且未输出内容 → 故障切换到下一供应商；已输出 → 发送 Anthropic `error` 事件结束

错误格式保持 Anthropic：`{ "type": "error", "error": { "type", "message" } }`，状态码沿用映射（429 → `rate_limit_error`，401 → `authentication_error`，其余 → `api_error`）。

`count_tokens`：按字符估算（ASCII 约 4 字符/token，CJK 约 1 字符/token），返回 `{ input_tokens }`，文档与界面注明为估算值。

### 6.7 本地 API 与鉴权

- 只绑定 `127.0.0.1`，端口默认 `8787`，可在设置中修改；端口占用时启动失败并提示改端口，不静默换端口。
- 本地访问 Key（可选）：
  - 关闭时：本机任意程序可直接访问。
  - 开启时：同时接受 `Authorization: Bearer <key>` 与 `x-api-key: <key>`，常量时间比较。
- `/health` 不鉴权；`/v1/*` 全部鉴权。
- 返回头补充 `x-tokenhub-provider`（命中的供应商 id），便于调试；不泄露上游 Key。

### 6.8 历史与日志

**历史记录（仅元数据）**：每行一条 JSON：

```json
{"ts":"2026-10-28T02:11:03.120Z","requestId":"req_x","protocol":"openai","model":"glm-5.1","providerId":"p1","upstreamModel":"glm-5.1","stream":true,"httpStatus":200,"outcome":"ok","promptTokens":1200,"completionTokens":345,"latencyMs":4200,"firstByteMs":380,"errorKind":null}
```

- 字段：时间、请求 ID、入站协议、请求模型、供应商、上游模型、是否流式、HTTP 状态、结果、prompt/completion token（拿不到为 null）、总耗时、首字节耗时、错误分类。
- 不记录 prompt、响应内容、请求头。
- 保留 30 天（可配 7/30/90/永久），启动时和每日凌晨清理过期文件。
- 界面按天查询最近记录，支持按供应商/模型/结果过滤。

**应用日志**：`logs/app.log` 轮转（单文件 5MB，保留 5 份），记录启动、端口、配置变更（不含 Key）、额度探针结果、路由决策（providerId、模型、分类），不记录请求体/响应体。

### 6.9 GUI 与系统托盘

浅色主题、统一配色、控件对齐到 8px 网格。

**页面**

1. 概览
   - 顶部：服务状态（监听地址、端口、运行中/已暂停）、今日请求数、今日 token、成功率。
   - 供应商额度卡片：按优先级排列，含状态色点、额度进度条（OpenCode 三窗口）、重置倒计时（每分钟刷新）、DeepSeek 余额、Goat 冷却倒计时。
   - 最近请求表：最近 50 条元数据，点击可看详情（不含内容）。
2. 供应商
   - 列表支持拖拽排序（dnd-kit），顺序即优先级。
   - 每行：拖拽手柄、序号、名称、baseURL、模型数、状态、启用开关、编辑/删除。
   - 添加/编辑对话框：预设选择、名称、baseURL、Key（留空不改）、额度适配器、额度参数、手动模型列表、测试连接、保存。
   - 测试连接：拉取 `/models` 与额度探针并展示结果，不写入缓存除非保存。
   - 删除供应商需二次确认，并提示其模型将从合并目录移除。
3. 模型
   - 合并模型列表：模型 ID、来源供应商徽标（含禁用/异常状态）、搜索、手动刷新全部。
4. 设置
   - 监听端口、本地访问 Key（开关 + 设置/清除）、开机自启、启动时最小化、关闭窗口行为（最小化到托盘/退出）、日志保留天数、额度探针刷新间隔（高级；OpenCode 默认 60s，DeepSeek 固定 5 分钟）。

**托盘**

- 图标三态：绿（全部正常）、黄（有供应商冷却/额度紧张）、红（无可用供应商或服务异常）。
- 菜单：打开主界面、暂停路由（暂停期间新请求返回 503，正在进行的请求不受影响）、复制 OpenAI 地址、复制 Anthropic 地址、退出。
- 关闭窗口默认最小化到托盘；`startMinimized` 开启时启动只显示托盘。
- 单实例锁：再次启动时聚焦已有窗口。

## 7. 关键时序

**正常请求（流式）**

```
Agent → POST /v1/chat/completions (model=glm-5.1)
  → 鉴权 → 合并模型解析 → 候选 [OpenCode(ok), Goat(ok), DeepSeek(无此模型)]
  → 选 OpenCode，替换 Key 与 model
  → 上游 200 SSE → 透传给 Agent（旁路解析 usage）
  → 写历史（provider=p1, tokens, latency）
```

**额度耗尽切换**

```
Agent → POST /v1/messages (claude 风格客户端, model=glm-5.1)
  → 候选 [p1, p2, p3]
  → p1 返回 429 "weekly quota exceeded"
  → 标记 p1 exhausted（默认冷却 5h/或按探针 resetsAt），刷新 p1 额度
  → p2 返回 200 → Anthropic 流式转译 → 返回
  → 历史记录 provider=p2, failoverFrom=p1
```

**额度探针恢复**

```
OpenCode 探针每 60s：usage.weekly.percent=100, resetsAt=...
  → availability=exhausted，界面倒计时
  → 到达 resetsAt 后探针返回 percent=0 → availability=ok → 恢复路由
```

## 8. 错误处理与降级

- 额度探针失败：保留上次快照并标 `unknown`，路由仍可用（不因探针故障阻塞），连续 3 次失败停用探针并提示。
- 模型发现失败：保留旧缓存，允许手动模型。
- 端口占用：启动报错，界面提示并跳转设置。
- `safeStorage` 不可用：禁止保存 Key 并提示；已有配置仍可运行（已解密内容只在内存）。
- 历史写入失败：记录应用日志，不影响请求。
- 所有错误响应的协议格式与入站协议一致。

## 9. 安全设计

- 仅监听回环地址，默认无局域网暴露。
- Key 加密存储；只在主进程内存中解密；渲染进程不可见。
- 日志与历史不记录请求体、响应体、请求头、Key。
- 上游 URL 仅允许 `https://`（自定义供应商同样限制；本机 `http://127.0.0.1` 例外，便于本地模型）。
- 防止请求头注入：只透传白名单头，重建 `Content-Type`、`Accept`、上游鉴权头。
- 请求体大小上限 20MB，超限返回 413（协议格式一致）。
- 本地 Key 比较使用 `crypto.timingSafeEqual`。
- 删除供应商时同步删除 `secrets.bin` 中对应条目。

## 10. 测试策略

**单元测试（Vitest）**

- 路由：候选过滤、优先级、冷却、试探恢复、全部失败返回最后错误、400 不切换。
- 错误分类：各状态码 + 报文关键词矩阵。
- 模型合并：多家同名模型、手动补充、缓存失效。
- 额度适配器：OpenCode usage 正常/耗尽/401/字段缺失；DeepSeek 余额多币种/阈值；错误码跟踪。
- 协议转译：Anthropic 请求 → OpenAI 请求的字段映射表逐项断言；OpenAI 响应 → Anthropic 消息；SSE 状态机（文本、工具调用、混合、空流、中途错误），使用脱敏固定报文。
- 密钥存储：加密/解密往返（mock safeStorage）、无明文断言。

**集成测试**

- 假上游 HTTP 服务器：可编程返回 200/429/402/401/5xx、SSE 分片。
- 端到端：OpenAI 流式/非流式透传；Anthropic 流式/非流式转译；额度耗尽切换；首字节后不切换；本地 Key 鉴权。
- 断言历史文件只含元数据。

**Electron 测试**

- Playwright Electron 冒烟：启动、添加假供应商、模型列表出现、发起请求成功、窗口关闭后进程仍在托盘运行（能断言主进程存活与窗口隐藏）。
- 托盘菜单行为、开机自启、最小化启动为手动验收清单。

**验收标准**

1. 三个预设供应商可添加并测试连接，`config.json`、日志、历史中搜索不到 Key 明文。
2. `/v1/models` 显示合并后的模型，同名模型只出现一次。
3. 模拟 p1 返回 429 后请求自动落到 p2，历史记录体现切换。
4. OpenCode 额度卡片显示三窗口进度与重置倒计时，耗尽后自动恢复。
5. Claude Code（或等价的 Anthropic 客户端）能通过 `/v1/messages` 正常对话并调用工具。
6. 关闭窗口后进程驻留托盘，托盘菜单可打开/暂停/退出。

## 11. 里程碑

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| M1 | 工程骨架、配置与加密存储、供应商 CRUD、模型发现与合并 | 可添加三家供应商并看到合并模型列表 |
| M2 | OpenAI 代理、路由与切换、冷却、历史记录 | 假上游集成测试通过，可被 OpenAI 客户端调用 |
| M3 | 额度引擎、概览页、托盘、设置页 | 额度可视化与托盘行为可用 |
| M4 | Anthropic 协议与流式转译、count_tokens | Claude Code 端到端可用，转译测试全绿 |
| M5 | 打包（NSIS）、验收、文档 | 安装包在干净的 Windows 环境跑通验收清单 |

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| OpenCode Go 额度接口未公开文档化，可能变更 | 额度显示/自动切换失效 | 适配器隔离；连续失败自动降级为错误码模式并提示 |
| CommandCode 无额度接口，只能靠错误码 | 可能多浪费一次请求，冷却时长不准 | 默认 5h 可配 + 手动恢复 + 冷却到期试探 |
| 不同供应商对同一模型命名不同 | 合并目录出现重复条目 | v1 按精确 ID 合并，界面可手动补模型；后续加别名表 |
| Anthropic ↔ OpenAI 转译边界多 | 工具调用/流式异常 | 固定报文样例测试；错误以 Anthropic 格式返回；保留调试日志（仅分类与头信息） |
| 端口固定被占用 | 启动失败 | 明确报错并引导改端口 |
| DPAPI 与用户绑定 | 换机/换用户无法解密 | 文档说明，重新录入 Key |

## 13. 已决策事项

1. 技术栈：Electron + TypeScript（方案 A，单进程）。
2. 三个供应商均为 OpenAI 兼容上游。
3. 对外提供 OpenAI + Anthropic 双协议。
4. 路由：按模型能力过滤 + 供应商全局优先级；模型目录自动发现并合并同名模型。
5. 额度：OpenCode Go 用官方控制台同款 usage 接口；DeepSeek 用余额接口；CommandCode 只用错误码。
6. 本地接口：`127.0.0.1:8787`，可选本地 Key。
7. 历史仅元数据，保留 30 天可配。
8. 密钥用 Windows DPAPI（Electron safeStorage）加密，禁止明文兜底。
