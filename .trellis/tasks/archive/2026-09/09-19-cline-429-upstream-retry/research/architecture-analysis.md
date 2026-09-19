# Provider 外层重试与渠道健康路由分析

## 1. 当前链路

请求路径是：

```text
handleChat
  -> acquireAccountLease（先固定账号）
  -> resolveModelConfig（账号级整项覆盖全局路由）
  -> buildAttempts / applyMaxRetries
  -> runChatChain
  -> attemptOnce / clineRequest
```

代码证据：

- `runChatChain()` 的一次调用绑定一个显式 account，所有 provider attempt 使用相同 Authorization。
- 普通错误继续 provider 循环；命中 `accountErrorRules` 的 `cooldown/ban` 会中断循环。
- `handleChat()` 最多更换一次账号；替代账号从自己的 provider 链首项重新开始。
- `X-Cline-Attempts` 是合并后的真实 HTTP attempt 数，不是 provider 数或账号数。

## 2. 当前实现与目标的差距

### 2.1 preferred 会把多个 provider 放进一次请求

`injectPrefs()` 对 `pinMode=preferred` 注入：

```js
order = [current, ...rest]
```

这允许 Cline/Vercel/OpenRouter 在一个 HTTP attempt 内自行回退。switcher 无法知道网关内部尝试了哪些 provider，也无法将失败准确归因到 `模型 × provider`。

目标语义是保留“优先+回退”名称和人工顺序，但每次仅注入：

```js
only = [currentProvider]
```

provider 回退完全由 switcher 外层循环执行。

### 2.2 状态码规则把未知 429 当作账号错误

`accountActionFor()` 目前只按规范化状态码查 `accountErrorRules`。因此任意 429 都可能触发账号冷却，即使它来自 provider、Cline 边缘网关或无法归属的 HTML 响应。

目标是先产生错误分类，再决定是否运行账号规则：

```text
429 + 明确账号证据 -> account -> 可运行账号 cooldown/ban
429 + 明确 provider 证据 -> provider -> 同账号下一 provider
429 + 无法归属       -> unknown -> 按非账号错误执行，同账号下一 provider
```

未知仍保留 `unknown` 诊断值，不能伪称已确定为 provider。

### 2.3 upstreamStatus 不参与运行时路由

当前 `META.models[modelId].upstreamStatus[provider]` 已是 `模型 × provider` 维度，并由校验/部分错误学习更新，但：

- 主要供控制台排序和展示；
- `buildAttempts()` 不读取它；
- 成功不会一致地恢复状态；
- 没有连续失败、冷却到期、半开或全不健康 fail-open 契约；
- 5xx、网络和超时通常不会形成可用于路由的状态。

因此适合在原结构上扩展，而不是新增第二套重复健康映射。

## 3. 429 归属证据

### 3.1 账号级（高置信）

只使用保守证据：

- 结构化错误明确包含账号/套餐/订阅额度窗口耗尽语义；
- 或该账号有不超过现有新鲜窗口的完整额度快照，且至少一个 `five_hour/weekly/monthly` 达到 100%。

泛化的 `rate limited`、单独的 `quota`、HTTP 状态 429 本身均不足以判为账号级。

### 3.2 provider 级（高置信）

- 结构化错误明确标识当前 provider；
- 或响应 routing 元数据给出 `finalProvider`，并与当前单 provider attempt 对应。

### 3.3 unknown

- 非 JSON HTML 429；
- 无 routing/provider/account quota 证据；
- 模糊的 rate-limit 文本。

行为按用户确认：不冷却账号，继续同账号下一 provider。诊断仍写 `scope=unknown` 与安全的证据枚举，不写原始 HTML。

## 4. 健康状态模型

复用并扩展：

```js
META.models[modelId].upstreamStatus[provider] = {
  status,                 // ok | limited | degraded | bad | unknown
  checkedAt,
  lastSuccessAt,
  lastFailureAt,
  consecutiveFailures,
  cooldownUntil,
  failureClass,           // rate_limit | server | network | timeout | unsupported | null
  note                    // 现有安全、截断展示文本；不得存 raw body
}
```

路由只依赖枚举、时间和计数；`note` 不参与决策。

### 4.1 更新规则

| 结果 | provider 状态 |
|---|---|
| 成功 | `ok`，失败计数与冷却清零 |
| provider/unknown 429 | `limited`，使用合法 Retry-After；缺失/非法时 60 秒为首个基数，指数退避，上限 30 分钟 |
| 5xx | `degraded`，15 秒起有界退避，上限 2 分钟 |
| 网络/超时 | `degraded`，15 秒起有界退避，上限 2 分钟 |
| 明确不支持/不可钉住 | `bad`，冷却 1 小时后允许重新探测 |
| 账号级 401/403/429 | 不更新 provider 健康度 |
| 客户端断开 | 不更新 provider 健康度 |

`Retry-After` 支持 delta-seconds 和 HTTP-date，并限制在 1 秒到 30 分钟。合法显式值优先于本地退避计算。

### 4.2 排序与恢复

1. 构造来源列表：显式配置的 `upstreams`；为空时使用已探测的 `META.models[model].upstreams` 稳定顺序。
2. 应用 exclude。
3. 冷却未到期的 provider 暂时移出候选。
4. 其余候选严格保持来源顺序，不因状态标签重排；冷却到期的 provider 恢复到原人工/探测位置，下一次命中即为半开探测。
5. 再应用 `maxRetries`，避免健康排序后意外尝试超过配置上限。
6. 如果全部 provider 都在冷却，fail-open 选择 `cooldownUntil` 最早者；并列按人工优先级。该请求只开放该候选，避免同时击穿全部冷却渠道。
7. 若无显式配置但有已探测 provider，仍按上述方式选单个/外层重试。
8. 若完全没有已知 provider，保留单次 `auto/unattributed` 兼容 attempt；其结果不得归因到具体 provider。

健康状态跨账号共享，因为用户要求键为 `模型 × provider`，不包含 account。账号级错误不写该共享状态。

## 5. 请求与诊断数据流

```text
HTTP response
  -> normalize status + safe envelope metadata
  -> classify failure scope/class/evidence
  -> account action（仅满足账号证据时处理 429）
  -> provider health update（仅 provider/unknown 的可归因 attempt）
  -> trace
  -> bounded request/error log projection
```

建议 trace/error projection 增加安全字段：

```js
{
  errorScope,          // account | provider | unknown | request
  scopeEvidence,       // 受控枚举
  failureClass,
  healthAction,        // success | cooldown | recover | none
  retryAfterMs,
  responseContentType,
  responseBytes
}
```

`responseContentType` 只保留规范化媒体类型并限制长度；`responseBytes` 是安全整数。不得持久化原始 HTML/JSON body。

## 6. 流式边界

- 首个合法 SSE 事件出现前：与非流式相同，可执行 provider failover 或账号替换。
- 响应已经开始后：绝不重放请求；最终成功才恢复 provider 健康，后续 SSE 错误可降低该 provider 健康并影响未来请求。
- 客户端断开不算 provider 失败。

## 7. 兼容性

- `pinMode` 字段和控制台“优先+回退”选项保留，避免破坏配置/API round-trip；仅删除网关内 `order` 语义。
- `strict` 的单 provider 外层尝试保持不变；`preferred` 改为同样可观测的外层逐次尝试。
- 旧 `upstreamStatus` 记录可惰性补齐缺失字段；缺失/非法动态字段按 unknown/无冷却处理，不覆盖已有 provider 清单。
- `auto/unattributed` 只在没有任何已知 provider 时存在。
- 不改变账号选择模式、账号并发、粘性、额度池或账号健康调度。

## 8. 主要风险

- 账号额度错误文本可能演进：分类必须保守，未知默认不冷却账号。
- 全局 `模型 × provider` 状态会让一个账号观测到的 provider 故障影响其他账号；这是用户指定维度，但账号错误必须严格排除。
- 持久化写频率：当前每个已完成聊天本来就会通过 `record()` 保存 metadata，健康更新不应再增加一次同步磁盘写。
- preferred 行为变化：同一请求不再由 Cline 内部回退，可能增加 HTTP attempt 数，但每次可观测并受 `maxRetries` 限制。
