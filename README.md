# pi-provider-status

在 pi 状态栏里显示当前 provider 的额度和生成速度。配置放在 `~/.pi/agent/usage-config.yaml`，由这个扩展读写，也可以直接在 TUI 里改。

## 状态栏

| 键 | 显示 |
|---|---|
| `balance` | 余额，如 `󰄔 $6.53 left`（前缀是 Nerd Fonts 的 md-cash 图标） |
| `quota` | 订阅额度窗口，如 `5h 85% ↺ 2h30m · wk 20%` |

balance 和 quota 不会同时出现，看这个 provider 配的是哪一种。

tps 单独一个键，如 `42.7 tok/s`。算的是生成那一段：从第一个内容块到最后一个 delta，排队、首字延迟和工具执行时间都不算。`message_end` 时拿 `message.usage.output` 除以这段时长；provider 没报 usage 就按词（英文）或字（中文）估。超过 5 分钟没有新数据，或者这一轮根本没生成过内容，显示 `-- tok/s`。

## 配置

配置分两类。键是 provider ID，大小写要和 pi 里完全一致。

余额型给一个 URL 和一个 JSON 路径就能用，适合 OpenRouter、Sub2API 这类中转。订阅型选一个内置适配器，支持 Ollama、CommandCode、OpenCode Go、GLM、ChatGPT/Codex、Kimi。

```yaml
refreshInterval: 5          # 自动刷新间隔，分钟，默认 5

balances:
  openrouter:
    template: openrouter    # 内置模板，开箱即用
  MyRelay:
    request:
      url: https://relay.example.com/api/v1/credits
      headers: { Authorization: 'Bearer {{apiKey}}' }
    extractor: { remainingPath: data.remaining, unit: $ }

subscriptions:
  ollama-cloud:
    adapter: ollama
  commandcode:
    adapter: commandcode
  openai-codex:
    adapter: chatgpt
```

几个 provider 请求、提取规则一样的话，把公共部分写进顶层 `templates`，条目用 `template: 名字` 引用，再按需覆盖 `request` / `extractor` / `credentials` 里的单个字段。

凭据默认用 pi 运行时解析的那份，和聊天请求同一套（models.json / OAuth）。要单独指定就写在条目里：

```yaml
subscriptions:
  commandcode:
    adapter: commandcode
    credentials: { apiKey: sk-... }
```

查额度不要求装第三方 provider 包：只要 pi 侧能解析出凭据（上面两种来源之一）就能查。provider 本身仍要定义在 models.json 或已安装的扩展里，才能被选中。CommandCode 的用量接口和它的 Provider API 同源，需要 Pro 及以上套餐的 key，接口返回 401/403 时状态栏会提示。

字段细节（`request.*`、`extractor.*`、`validity.*`，以及适配器可覆盖的 `baseUrl`、`maxWidth`、`resetThresholds`）在 `/usage config` 面板里按 `?` 看，标签和 YAML 键一一对应，这里不重复。

## 命令

所有功能都在 `/usage` 下面：

| 命令 | 做什么 |
|---|---|
| `/usage`（或 `status`） | 对账一次 provider，刷新并显示用量和 tok/s |
| `/usage config`（别名 `edit`） | 打开 TUI 编辑面板 |
| `/usage update` | 忽略缓存，强制刷当前 provider |
| `/usage reconcile` | 只对账并显示结果。加 `--prune` 时，确认后把没有对应 provider 的余额条目移进 `orphans` |
| `/usage help` | 显示子命令 |

TUI 保存时只改你动过的那一条，其余条目的注释、格式和键序都保持原样。

## 几个已知行为

- 网络请求全在后台，不挡 pi；切 provider 或会话时，旧请求立即中止。
- 缓存还新鲜就直接渲染，不发请求。失败后 30 秒内的自动刷新会跳过，`/usage update` 不受限。
- 订阅窗口已用比例到 `cacheWarmingStopPercent`（默认 95%）时，拒绝 pi 的缓存预热，免得快没额度了还在烧钱。余额型没有窗口数据，不拦。
- 重置倒计时只在窗口剩余低于阈值时显示，默认 5h 80%、wk 40%、mo 30%，按窗口用 `resetThresholds` 改，写 0 就是关掉。
- 旧的 `balance-config.yaml` 会在启动时迁移成 `usage-config.yaml`，旧文件保留不删。同目录下的 `usage-config.lock` 和 `provider-usage-map.json` 是自动维护的，不用管。

## 开发

```
npm install
npm test
```
