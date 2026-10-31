# TokenHUB

把多个大模型供应商，变成一个本地端点。

TokenHUB 是运行在 Windows 桌面的本地 API 网关。它把 OpenCode Go、DeepSeek、CommandCode Goat 与任意 OpenAI / Anthropic 兼容服务合并到同一个地址（默认 `http://127.0.0.1:8787`），按供应商优先级路由、额度耗尽自动切换，并让 Claude Code 与 OpenAI 客户端共用同一套模型目录。Key 只保存在本机。

![TokenHUB 概览页](docs/readme/assets/overview.png)

## 特性

- **优先级路由**：供应商列表顺序就是路由顺序，拖动即调整，禁用即跳过。
- **自动故障转移**：额度耗尽、限流、5xx 与网络错误会切到下一个可用供应商，并按各自策略冷却。
- **双协议互转**：OpenAI Chat Completions 与 Anthropic Messages 双向转换，流式与非流式都支持。
- **统一模型 ID**：同一个模型在多家供应商的上游 ID 映射到一个本地 ID；原始 ID 仍可用 `providerId/原始ID` 强制访问。
- **额度探针**：OpenCode Go 三窗口、CommandCode 套餐用量、DeepSeek 余额，默认每 5 分钟刷新一次。
- **历史与诊断**：记录模型、供应商、Token、耗时、首字节、错误分类与切换来源，不保存提示词和回复正文。
- **密钥保险箱**：供应商 Key 与本地访问 Key 由 Windows DPAPI 加密保存，界面、日志与历史都不回显。
- **托盘常驻**：关闭窗口继续服务，托盘图标颜色表示健康度。

| 供应商 | 模型目录与协议 |
|---|---|
| ![供应商](docs/readme/assets/providers.png) | ![模型](docs/readme/assets/models-catalog.png) |

## 快速开始

仅支持 Windows 10 / 11。其他平台尚未打包与验证。

### 1. 安装并启动

从 [Releases](../../releases/latest) 下载 `TokenHUB Setup x.y.z.exe` 并安装。启动后服务监听 `127.0.0.1:8787`，关闭窗口默认最小化到托盘，服务继续运行。

### 2. 添加供应商

进入「供应商」→「添加供应商」，选择预设或自定义，填写 Base URL 与 API Key。建议先点「测试连接」，确认模型列表与额度可读后再保存；模型会自动发现，也可以到「模型」页手动刷新。

### 3. 把客户端指向本地

未启用本地访问 Key 时，API Key 填任意非空占位值即可；启用后请换成设置页保存的本地 Key。

```bash
# OpenAI SDK / 兼容客户端
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=sk-local-placeholder
```

```bash
# Claude Code / Anthropic 客户端
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_AUTH_TOKEN=sk-local-placeholder
ANTHROPIC_MODEL=claude-sonnet-4-5
```

### 4. 发一条请求验证

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-local-placeholder" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

概览页的今日请求、额度和最近请求会随调用更新；展开记录可以看到实际供应商、首字节耗时与是否发生过切换。

## 失败时会发生什么

- 路由严格按供应商顺序，不做轮询。
- 429 / 402 / 5xx / 网络错误：冷却当前供应商并切到下一个；瞬时故障按 10 / 20 / 40 / 60 秒退避。
- 401 / 403：标记鉴权失败并跳过，更新 Key 后自动恢复。
- 流式请求一旦返回首字节就不再切换，避免半截回答被重放；客户端主动断开不算供应商故障。
- 因冷却导致无候选时返回 503 并带 `Retry-After`，客户端据此等待而不是立即重试。

## 安全

- 服务只绑定 `127.0.0.1`，不接受局域网或公网连接。
- 供应商 Key 与本地访问 Key 保存在 `secrets.bin`，由 Windows DPAPI 加密；界面只显示「已保存 / 未配置」。
- 历史仅保留请求元数据，不保存提示词与回复正文。
- 请求体上限 20 MB；上游地址默认只允许 https，本机回环可用 http。
- 没有遥测上报，只有你主动发起的请求会到达对应供应商。

## 本地开发

```bash
npm install
npm run dev        # Electron 开发模式
npm run typecheck  # Node / Web 类型检查
npm test           # Vitest 单元 + 集成测试
npm run build      # 构建到 out/
npm run dist       # 打包 NSIS 安装包到 release/
```

E2E 测试需要先构建：`npm run build && npx playwright test`。

## 文档

- `README.html`：带截图的完整说明，可在浏览器直接打开。
- `docs/readme/`：HTML README 的模板、截图与生成脚本；产物是根目录 `README.html`。

## License

[MIT](LICENSE)
