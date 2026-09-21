# pi-provider-status

官方 Pi 普通扩展：在状态栏显示当前 provider 的**订阅额度窗口**与**账户余额**，以及生成速度（tok/s）；同时是 `~/.pi/agent/usage-config.yaml` 的唯一所有者，负责用量查询运行时、缓存与定时刷新，以及与 models.json 的 provider 身份对账。

## 状态栏输出

按类型分键发布，同一时刻只有 `balance` / `quota` 其中一个有值：

| 键 | 内容 | 示例 |
|---|---|---|
| `balance` | 余额型文案：提取器输出（语义始终是剩余额度）+ ` left`，前缀 md-cash 图标（Nerd Fonts v3 `U+F0114`） | `󰄔 $6.53 left` |
| `quota` | 订阅型窗口文案：窗口 + 已用百分比；**窗口剩余低于其阈值**（默认 5h 80%、wk 40%、mo 30%，可用 `resetThresholds` 覆盖）时追加 `↺ 2h30m` 重置倒计时 | `5h 85% ↺ 2h30m · wk 20%` |
| `tps` | 生成速度：只统计生成区间（首个内容块 → 最后一个 delta），数字在前、单位在后，不带图标 | `42.7 tok/s` |

`tps` 是**生成区间速度**，不是整轮耗时平均：`message_update` 的 `text_start`/`thinking_start`/`toolcall_start` 开始计时，`text_delta`/`thinking_delta` 喂入时间滑动窗（默认 5s，带 provider 缓冲突发的跨度补偿），生成期间约 250ms 节流上屏；`message_end` 时用权威 `message.usage.output` 除以「首个内容块 → 最后一个 delta」的跨度定案——**TTFT/排队与工具执行时间不在分母里**（`turn_end` 口径会把两者都算进去，带工具的一轮会明颉偏低）。provider 累计上报 `usage.output` 时用其增量，否则按词法估算（英文按词、CJK 按字符）。超过 5 分钟没有新数据、或从未产生过速度时显示 `-- tok/s`。`session_shutdown` 时三个键都会被清除；`/usage status` 的提示里显示同一份 `tok/s` 文案。

两类数据分开建模：

- **余额型（balance）**：任意 HTTP 接口 + JSON 路径提取，适合 OpenRouter、Sub2API/NewAPI 中转、DeepSeek 等；
- **订阅型（subscription）**：内置适配器解析 5h/周/月 额度窗口，支持 Ollama、CommandCode、OpenCode Go、GLM、ChatGPT/Codex、Kimi。

## 相关文件

| 文件 | 角色 |
|---|---|
| `~/.pi/agent/usage-config.yaml` | 唯一的用户配置：刷新间隔、`templates` 模板、`balances`、`subscriptions` |
| `~/.pi/agent/usage-config.lock` | 写入互斥锁（容忍 30s 内的 stale lock），跨进程保护读-改-写 |
| `~/.pi/agent/provider-usage-map.json` | Provider 重命名时的 alias 记录（对账产物，无 secret） |
| `~/.pi/agent/provider-balance-map.json` | **旧文件**：alias 记录的旧名，作为读取兜底 |
| `~/.pi/agent/balance-config.yaml` | **旧文件**：首次启动自动迁移为 `usage-config.yaml`，旧文件保留不删 |
| `~/.pi/agent/models.json` | 只读引用：Provider 列表来自这里（pi 内置 provider 单独从内置 catalog 读取） |

## 命令

所有功能收敛在 `/usage` 一个命令下：

| 命令 | 行为 |
|---|---|
| `/usage`（或 `/usage status`） | 执行一次 Provider 身份对账、刷新并显示当前用量与 tok/s |
| `/usage config`（别名 `/usage edit`） | 打开 TUI 编辑面板（需要交互式 UI） |
| `/usage update` | 强制刷新当前 provider（忽略缓存间隔） |
| `/usage reconcile` | 只执行对账并显示报告，不刷新 |
| `/usage reconcile --prune` | 对 orphan 余额条目执行隔离前确认，确认后从 `balances` 移入 `orphans`（可恢复） |
| `/usage help` | 显示可用子命令 |

子命令风格与 `workspace-preset` 的 `/preset` 保持一致：`status` / `config` / `help` 是通用子命令（`edit` 保留为 `config` 的兼容别名），其余为各自领域扩展。

## 配置参考（usage-config.yaml）

```yaml
refreshInterval: 5

# 余额模板：公共请求/提取协议，provider 通过 template 引用继承。
templates:
  newapi: &newapi
    request: { ... }
    extractor: { ... }

# 余额型 provider。
balances:
  MyRelay:
    template: newapi
    request:   { baseUrl: https://example.com }
    extractor: { unit: $, scale: 0.5 }
    credentials: { apiKey: sk-... }
  openrouter:
    template: openrouter      # 内置模板，开箱即用

# 订阅型 provider：键必须与 provider ID 大小写完全一致。
subscriptions:
  ollama-cloud:
    adapter: ollama
  commandcode:
    adapter: commandcode
  opencode-go:
    adapter: opencode-go
  zai:              # GLM Coding Plan 全球区，默认 https://api.z.ai
    adapter: glm
  zai-coding-cn:    # GLM 编程套餐中国区，默认 https://open.bigmodel.cn
    adapter: glm
  openai-codex:
    adapter: chatgpt
  kimi-coding:
    adapter: kimi

# 隔离的孤儿余额条目。
orphans: {}
```

### 余额继承与合并语义

- provider 自身字段与 template 做**浅合并**：`request`、`extractor`、`credentials` 三段各自独立合并，provider 同名字段整体覆盖 template；
- 运行时 provider `credentials` 优先于 models.json 的 provider auth；
- 编辑面板会把合并后的有效值预填写出来，继承字段带（继承）标记；留空清除覆盖、恢复继承。

### 余额 request 字段

| 字段 | 说明 |
|---|---|
| `url` | 请求地址。可用插值变量；相对路径（如 `/api/v1/credits`）以 `baseUrl` 为根解析 |
| `baseUrl` | 可选。覆盖 provider 在 models.json 里的 baseUrl（会去掉末尾 `/v1`） |
| `method` | 默认 `GET` |
| `headers` | 请求头对象，值可插值 |
| `body` | 请求体对象（会 JSON 序列化），值可插值 |
| `timeoutSeconds` | 单次请求超时，默认 10 |

插值变量：`{{baseUrl}}`、`{{apiKey}}`、`{{accessToken}}`、`{{userId}}`。

### 余额 extractor 字段

| 字段 | 说明 |
|---|---|
| `remainingPath` | 剩余额度字段路径（`data.quota`，数组用 `items.0.remaining`）；未设置时由 `totalPath - usedPath` 计算 |
| `usedPath` / `totalPath` | 已用/总额路径 |
| `unit` / `unitPath` | 显示单位（如 `$`、`￥`）或从响应读取单位的路径 |
| `scale` | 余量缩放系数（默认 1） |
| `errorPath` / `errorFallback` | 查询无效时的错误信息来源与兜底文案 |

### extractor.validity（响应有效性判定）

`validity` 挂在 `extractor` 下（TUI 的「有效性」分节写入的正是 `extractor.validity.*`）：

| 字段 | 说明 |
|---|---|
| `path` | 该路径取值为真才继续 |
| `allTruthy` | 路径数组，全部为真才继续 |
| `firstDefined` | 按顺序取第一个存在的字段判断有效性 |
| `fallback` | 仅当 `firstDefined` 的字段都不存在时生效 |

## 订阅适配器

| adapter | provider ID（默认） | 端点 | 认证 | 窗口 |
|---|---|---|---|---|
| `ollama` | `ollama-cloud` | `GET ollama.com/api/usage` | models.json `apiKey` | `limits.session`(5h)/`limits.weekly`（0-1 小数；接口不返回 reset，按 5h/周一 UTC 网格推算） |
| `commandcode` | `commandcode` | `GET /alpha/whoami` → `/alpha/billing/credits` + `/alpha/usage/summary` | Bearer API key | `windowLimits.fiveHour`/`weekly` + 月度 `spent/total` |
| `opencode-go` | `opencode-go` | `GET opencode.ai/zen/go/v1/usage` | Bearer API key | `usage.rolling`(5h)/`weekly`/`monthly` + `resetsAt` |
| `glm` | `zai`（全球）/ `zai-coding-cn`、`bigmodel-cn`（中国） | `GET {api.z.ai\|open.bigmodel.cn}/api/monitor/usage/quota/limit` | API key（先裸 key，401 再 Bearer） | `data.limits[]` TOKENS_LIMIT：unit 3=小时/6=周 + `nextResetTime` |
| `chatgpt` | `openai-codex` | `GET chatgpt.com/backend-api/wham/usage` | pi 运行时解析的 OAuth access token + `chatgpt-account-id`（从 JWT claim 读取） | `rate_limit.primary/secondary` |
| `kimi` | `kimi-coding` | `GET api.kimi.com/coding/v1/usages` | Bearer（pi 解析的 kimi-coding 凭据） | 最短 rolling 窗口(300min=5h) + weekly 汇总 |

- `ollama-cloud` 与 `commandcode` **不是 pi 内置 provider**，需先安装对应 provider 包（`pi-ollama-cloud`/`pi-ollama-cloud-provider` 注册 `ollama-cloud`；`pi-commandcode-provider`/`@bacnh85/pi-commandcode` 注册 `commandcode`）；`opencode-go`/`zai`/`zai-coding-cn`/`openai-codex`/`kimi-coding` 是 pi 内置。
- 条目可覆盖 `label`（短标签，用于 TUI 与错误信息，不出现在状态栏文本）、`request.baseUrl`（区域端点）、`request.timeoutSeconds`（默认 15）、`request.headers`、`maxWidth`（状态栏宽度预算，默认 48）、`resetThresholds`（按窗口的倒计时阈值，见下）、`credentials`；余额与订阅统一使用 `request.*` / `credentials.*` 命名，TUI 表单与运行时字段一一对应（由 `tests/tui-coverage.test.ts` 守护）；
- 凭据默认由 pi 运行时解析（与聊天请求同一套 `models.json`/OAuth），条目内 `credentials` 只用于覆盖特殊情况；
- **不使用**浏览器 cookie、HTML 抓取、旁路凭据文件或自建 token refresh。

### API 能力与套餐要求

- **Ollama Cloud**：原生 API key 形式（`/login` 选 Ollama Cloud，或 `OLLAMA_API_KEY`），提供 OpenAI 兼容 API；`/api/usage` 用同一把 key，Free 档也可查询。
- **Command Code**：原生支持 API 调用，但其 **Provider API 仅 Pro 及以上套餐开放**（Go 档无 API，只有 CLI）。凭据可用 `/login commandcode`（OAuth，`pi-commandcode-provider` 的 `oauth.getApiKey` 会自动刷新）或 `COMMAND_CODE_API_KEY`；两者对 `/alpha/*` 用量接口都有效。返回 401/403 时状态栏会提示套餐/登录要求。
- 两者都**复用 pi 运行时解析的凭据**（与聊天请求同一套）。若未安装对应 provider 包（`pi-ollama-cloud`/`pi-commandcode-provider` 等），`getApiKeyAndHeaders` 拿不到 key，会显示 unavailable。

## 状态栏文本渲染

订阅型文本展示窗口与已用百分比（`5h 15% · wk 3% · mo 0%`），不带 provider 前缀；**窗口剩余低于其阈值**时才追加重置倒计时（`5h 85% ↺ 2h30m`，符号与倒计时间留一个空格，复合单位最多两位：`45m` / `2h30m` / `1d4h`），倒计时由每分钟的本地重渲染更新，不触发网络查询。阈值默认按窗口为 `5h: 80`、`wk: 40`、`mo: 30`（语义对齐 pi-cloud-quota：剩余低于该值就提示），未列出的标签（如 GLM 的 `1h`、Kimi 的 `150m`）用 30；可用 `subscriptions.<id>.resetThresholds` 按窗口覆盖（在默认表上合并，写成 `0` 即关闭该窗口的倒计时）：

```yaml
subscriptions:
  commandcode:
    adapter: commandcode
    resetThresholds: { '5h': 50, wk: 30 }   # 其余标签仍用默认值
```

文本中不出现逗号与尾部 `(...)`，超宽（默认 48 可见字符，可用 `maxWidth` 覆盖）时逐级降级：全窗口+倒计时 → 全窗口 → 5h+倒计时 → 5h 窗口。余额型文本是提取器的输出（可带 `unit`）加 ` left` 限定词，统一加 md-cash 前缀图标；生成速度文本为数字在前、单位在后且不带图标。未配置余额/订阅的 provider 不占位（两个键都清空）。

## TUI 编辑面板（/usage config）

两级导航，每屏只做一件事；行上只显示中文标签，按 **?** 在帮助浮层里查看对应的 YAML 键与字段说明：

- **主面板**：`余额配置` / `订阅配置` / `余额模板` / `隔离条目`（有隔离时才出现） / `刷新间隔` / `原始 YAML` / `退出`。`↑↓` 选择，**Enter** 进入，`q` / `Esc` 退出；
- **分类页**：首行 `＋ 新建…`，下面是已配置条目。`↑↓` 选择，**Enter** 打开，`n` 新建，`d` 删除，`Esc` 返回；
- **条目编辑器**：第一层按 `请求 / 提取 / 有效性 / 凭据 / 绑定模板 / 原始 JSON / 保存` 分节，**Enter** 进入分节后逐字段编辑；**Ctrl+S** 在任意一层保存，`Esc` 逐层返回；
- 列表顶部一行上下文，按 **?** 打开完整快捷键与字段说明浮层。

- `balances`：为每个 provider 绑定 template 或覆盖 `request.*` / `extractor.*` / `extractor.validity.*` / `credentials.*`；键与 provider ID 大小写完全一致；凭据掩码显示，输入 `-` 清除；
- `subscriptions`：选择 `adapter` 并覆盖 `label` / `request.baseUrl` / 超时 / `maxWidth` / `resetThresholds` / 附加请求头 / 凭据；
- `templates`：模板增删改；条目用 `template` 绑定；内置模板（`openrouter`）无需定义即可绑定，同名自定义优先；
- `orphans`：隔离条目的恢复（节点移动，保留原注释）与彻底删除；
- `refreshInterval`：刷新间隔（留空恢复默认 5）。

写入走 `usage-edit.ts` 的定向编辑层：在配置锁内从磁盘重新解析最新内容，只对被编辑的条目做 `setIn`/`deleteIn` 后原子写回，未触摸条目的注释/格式/键序原样保留。

## 对账（reconcile）

余额配置与 `models.json` 只通过 Provider ID 关联：

- 新增 Provider：只报告，不自动创建配置；
- 删除 Provider：默认保留为 orphan 并报告；`--prune` 且用户确认后才隔离进 `orphans`；
- pi 内置 provider（如 openrouter）不在 models.json 里，配置了也不算 orphan；
- Provider 重命名：消费 `pi-model-manager` 广播的 `pi-model-manager:models-changed`（`provider-rename`），在锁内迁移余额 key 并记录 alias 到 `provider-usage-map.json`；
- 订阅条目以 provider ID 为键、由内置适配器驱动，不参与隔离。

## 查询运行时

- **不阻塞 pi**：网络请求全部后台异步，命令 handler 与事件回调绝不 `await`；
- **缓存优先**：缓存新鲜时直接渲染，不解析认证、不发请求；
- **定时调度**：`unref` 的递归 `setTimeout` 按 `refreshInterval` 调度；
- **失败退避**：失败后 30s 内事件刷新不再击打端点（`/usage update` 不受限），失败不缓存为新鲜值；
- **在途中止**：切换 provider/session 时通过 generation + AbortController 立即中止旧请求；
- **有界读取**：响应体上限 64KB；`timeoutSeconds` 与外部中止共同生效。

## 迁移

启动时自动把旧键迁移到当前键名，注释与键序保留：

- `refreshIntervalMinutes → refreshInterval`；
- `profiles → templates`，条目字段 `profile → template`；
- `orphanBalances` / `orphanProviders → orphans`，`providers → balances`；
- 条目顶层的 `validity` 移入 `extractor.validity`（运行时只读这里；旧版 TUI 曾写在顶层）。

旧文件 `balance-config.yaml` 存在且无新文件时同样一次性迁移，旧文件保留不删；读取路径也兼容旧键，即使迁移写盘失败也能正常工作。

## 开发与测试

```
npm install
npm test   # node --test：extractor、request 构造、usage-store/edit、reconcile、订阅解析器与迁移
```
