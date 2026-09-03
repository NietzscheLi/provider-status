# pi-provider-status

官方 Pi 普通扩展：在状态栏显示当前 provider 的余额与生成速度（TPS），是 `balance-config.yaml` 的唯一所有者。负责余额查询运行时、缓存与定时刷新、TPS 统计，以及 provider 身份对账。

支持 pi 内置 provider（如 `openrouter`，不出现在 models.json 里）：内置 provider 同样出现在 `/balance config` 面板中，按 `P` 从已知 provider 列表（models.json ∪ pi 内置目录）选择创建余额配置；providers 键必须与 provider ID **大小写完全一致**才生效，列表选择从源头避免拼写不一致。扩展内置了 OpenRouter 余额查询模板（`profile: openrouter`），配置后开箱即用；在 yaml 的 `profiles` 段自定义同名模板可覆盖内置模板。

启动时会检测 pi 配置目录（`~/.pi/agent`），缺少 `balance-config.yaml` 时自动初始化一份基础配置（`refreshIntervalMinutes: 5` + 空 `profiles`/`providers`）；已存在则不做任何改动。

## 相关文件

| 文件 | 角色 |
|---|---|
| `~/.pi/agent/balance-config.yaml` | 唯一的用户配置：刷新间隔、profiles 模板、providers 覆盖 |
| `~/.pi/agent/balance-config.lock` | 写入互斥锁（容忍 30s 内的 stale lock），跨进程保护读-改-写 |
| `~/.pi/agent/provider-balance-map.json` | Provider 重命名时的 alias 记录（对账产物，无 secret） |
| `~/.pi/agent/models.json` | 只读引用：Provider 列表来自这里（pi 内置 provider 不在此文件，单独从内置 catalog 读取），余额配置通过 Provider ID 关联 |

## 命令

所有功能收敛在 `/balance` 一个命令下：

| 命令 | 行为 |
|---|---|
| `/balance`（或 `/balance status`） | 执行一次 Provider 身份对账、刷新并显示当前余额/TPS |
| `/balance update` | 强制刷新当前 provider 的余额（忽略缓存间隔） |
| `/balance config` | 打开 TUI 编辑面板（需要交互式 UI）；按 `P` 从已知 provider 列表新建 providers 配置 |
| `/balance reconcile` | 只执行对账并显示报告，不刷新余额 |
| `/balance reconcile --prune` | 对 orphan provider 执行隔离前确认（需要交互式 UI），确认后条目从 `providers` 移入 `orphanProviders`（可恢复，不做物理删除） |

未知子命令会提示用法。状态栏常驻显示 `balance` 与 `tps` 两个条目。

## 配置参考（balance-config.yaml）

```yaml
# 余额自动刷新间隔（分钟）。扩展用递归 setTimeout 按计划时间精确调度；默认 5。
refreshIntervalMinutes: 5

# 公共协议模板。provider 通过 profile 引用继承，再用自身同名字段覆盖。
profiles:
  newapi: &newapi
    request: { ... }
    extractor: { ... }

providers:
  MyProvider:
    profile: newapi          # 字符串引用 / YAML 别名(*newapi) / 内联对象，三者等价
    request:   { baseUrl: https://example.com }
    extractor: { unit: $, scale: 0.5 }
    credentials: { apiKey: sk-... }
```

### 继承与合并语义

- provider 自身字段与 profile 做**浅合并**：`request`、`extractor`、`credentials` 三段各自独立合并，provider 同名字段整体覆盖 profile（例如 provider 的 `headers` 会完全替换 profile 的 `headers`，而不是逐键合并）；
- 凭据不继承到表单显示，但运行时 provider `credentials` 优先于 models.json 的 provider auth；
- 编辑面板会把合并后的有效值预填写出来，继承字段带（继承）标记；留空清除覆盖、恢复继承。

### request 字段

| 字段 | 说明 |
|---|---|
| `url` | 请求地址。可用插值变量；相对路径（如 `/api/v1/credits`）以 `baseUrl` 为根解析 |
| `baseUrl` | 可选。覆盖 provider 在 models.json 里的 baseUrl（会去掉末尾 `/v1`）；插值变量 `{{baseUrl}}` 的取值 |
| `method` | 默认 `GET` |
| `headers` | 请求头对象，值可插值 |
| `body` | 请求体对象（会 JSON 序列化），值可插值 |
| `timeoutSeconds` | 单次请求超时，默认 10 |

插值变量：`{{baseUrl}}`、`{{apiKey}}`、`{{accessToken}}`、`{{userId}}`（取自 credentials，缺失时回退 provider auth）。

### extractor 字段

| 字段 | 说明 |
|---|---|
| `remainingPath` | 响应里剩余额度的字段路径（`data.quota` 形式，数组用 `items.0.remaining`）；null/未设置时由 `totalPath - usedPath` 计算 |
| `usedPath` / `totalPath` | 已用/总额路径，配合计算 remaining |
| `unit` | 显示单位字符串（如 `$`、`￥`）；未设置时从 `unitPath` 指向的响应字段读取 |
| `unitPath` | 从响应读取单位的路径 |
| `scale` | 余量缩放系数，直接相乘（如接口单位是分则设 `0.01`；默认 1） |
| `errorPath` | 查询无效时优先从响应该字段读取错误信息 |
| `errorFallback` | 错误信息兜底文案，默认 `Balance query failed` |

### validity（响应有效性判定）

| 字段 | 说明 |
|---|---|
| `path` | 该路径取值为真才继续（如 `data`） |
| `allTruthy` | 路径数组，全部为真才继续（如 `[success, data]`） |
| `firstDefined` | 路径数组，按顺序取**第一个存在**的字段判断有效性（如 `[is_active, isValid]`） |
| `fallback` | 仅当 `firstDefined` 的字段都不存在时生效：为真视为有效继续提取，为假报错 |

任何判定失败都会抛错：错误信息优先取 `errorPath` 指向的响应字段，否则用 `errorFallback`。

## TUI 编辑面板（/balance config）

列表 + 单键快捷操作：**Enter** 编辑选中条目 / **n** 新建模板 / **d** 删除 / **y** 原始 YAML / **q** 退出。

- `providers`：为 models.json 中的每个 provider 绑定 profile 或覆盖 request/extractor/credentials/validity；按 `P` 可从已知 provider 列表（models.json ∪ pi 内置目录）新建条目，键与 provider ID 大小写完全一致；凭据掩码显示，留空保持原值，输入 `-` 清除；
- `profiles`：模板的增删改（`n` 新建），与 provider 条目共用同一个表单；内置模板（目前 `openrouter`）无需在 yaml 中定义即可绑定，同名自定义优先；
- `orphanProviders`：隔离条目的恢复（节点移动，保留原注释）与彻底删除；
- `refreshIntervalMinutes`：刷新间隔（留空恢复默认 5）；
- 表单覆盖全部已知字段：`request.url/baseUrl/method/headers/body/timeoutSeconds`、`extractor.remainingPath/totalPath/usedPath/unit/unitPath/scale/errorPath/errorFallback`、`validity.path/allTruthy/firstDefined/fallback`；未列出的字段走"原始 JSON"兜底。

### TUI 编辑的原子性

写入走 `config-edit.ts` 的定向编辑层：在配置锁内**从磁盘重新解析最新内容**，用 yaml Document API 只对被编辑的条目做 `setIn`/`deleteIn` 后原子写回（临时文件 + rename）。因此：

- 未触碰的条目连同注释、格式、键序字节级原样保留（被替换条目内部的注释随节点重建）；
- 面板打开期间的任何外部修改都不会导致保存失败，改动会在下一次保存时套用到最新内容上；
- 每次 delete/restore 后空段骨架会被顺手移除；
- 保存时把与具名模板完全一致的内联/别名展开 profile 归一化回字符串引用，避免别名被展开成内联副本而悄悄切断继承。

面板列表在每次动作后从磁盘重读，显示不会长期滞后。

## 对账（provider-reconcile）

余额配置与 `models.json` 只通过 Provider ID 关联：

- 新增 Provider：只报告，不自动创建余额配置；
- 已有 Provider：原样保留；
- 删除 Provider：默认保留为 orphan 并报告；`--prune` 且用户确认后才隔离进 `orphanProviders`；
- pi 内置 provider（如 openrouter）不在 models.json 里，配置了也不算 orphan；
- Provider 重命名：消费 `pi-model-manager` 在 `pi.events` 上广播的 `pi-model-manager:models-changed` 事件（`provider-rename`，无 secret），在配置锁内原子迁移 balance key，并把 alias 记入 `provider-balance-map.json`；
- 冲突（如 newId 已有余额配置）：停止自动写入，报告冲突，不覆盖任一配置。

## 安全

扩展源码不保存密钥。余额请求优先使用 models.json/provider auth 的凭据，仅当 balance 配置明确提供专用 `credentials` 时使用专用引用。所有通知/错误输出先经过 `redactSecrets` 脱敏；对账事件和映射文件不包含 secret。

## 开发与测试

```
npm test   # node --test 覆盖 extractor、request 构造、config-store、config-edit、reconcile 纯逻辑
```
