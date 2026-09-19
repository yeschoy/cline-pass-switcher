# Cline 单渠道重试与模型渠道健康路由设计

## 1. Scope and boundaries

本任务修改同一条后端关键路径及其静态控制台投影：

```text
route config / metadata
  -> provider attempt planning
  -> one-provider request injection
  -> failure classification
  -> provider health / account action
  -> trace and bounded diagnostics
  -> console projection
```

实现仍保持“两级路由”边界：先租用一个账号，再在该账号内执行 provider chain。只有明确账号级错误且命中账号规则时，才结束 provider chain 并最多替换一次账号。

不修改六种账号调度模式、账号流水线、配额抓取调度、会话粘性或并发租约语义。后端、持久化、日志和控制台必须作为一个原子变更交付，因此不拆子任务。

## 2. Provider attempt contract

引入单一 provider 计划入口（函数名可在实现中调整）：

```js
buildProviderAttempts(modelId, routeConfig, now = Date.now())
  -> {
    attempts: [{ upstream, attribution, sort }],
    configuredOrder,
    plannedOrder,
    failOpen,
    source // configured | discovered | auto
  }
```

规则：

1. 显式 `routeConfig.upstreams` 非空时以其为人工优先级；否则使用 `META.models[modelId].upstreams` 的稳定探测顺序。
2. 排除 `routeConfig.exclude`。
3. 根据 `META.models[modelId].upstreamStatus[provider].cooldownUntil` 临时过滤仍在冷却的渠道。
4. 非冷却 provider 严格保持来源顺序，不按 `ok/degraded/unknown` 标签二次重排；冷却到期即回到原位置，形成半开探测。
5. 全部冷却时只 fail-open 一个 provider：最早恢复者优先，同时间按人工顺序。
6. 在健康排序之后应用 `maxRetries + 1` 上限。
7. 完全没有已知 provider 时生成一个 `{ upstream: null, attribution: "auto" }` 兼容 attempt；已知 provider 被全部 exclude 时不得回退 auto 绕过排除，应返回无可用 provider 的安全错误。

`pinMode` 继续合法并完整 round-trip。`strict` 和 `preferred` 都由 switcher 外层执行单 provider attempt；`preferred` 不再向网关注入多 provider `order`。

`injectPrefs()` 对具名 attempt 只注入当前 provider：

```js
providerOptions.gateway.only = [provider] // planner 或未知管道
provider.only = [provider]                // direct 或未知管道
```

未知管道可以同时注入两种形状，但两处必须是同一个 provider。不得出现多元素 `only` 或 `order`。`sort` 可保留，用于该 provider 内部可排序端点。

## 3. Failure classification

增加统一的 attempt 分类结果：

```js
{
  scope: "account" | "provider" | "unknown" | "request",
  evidence: <bounded enum>,
  failureClass: "rate_limit" | "auth" | "server" |
                "network" | "timeout" | "unsupported" | "other",
  retryAfterMs: number | null
}
```

分类输入仅来自 HTTP 状态、响应头、结构化错误字段、routing 元数据、当前 provider、terminal origin 和新鲜额度投影。原始正文只在请求内用于解析，不持久化。

### 3.1 429

优先级从高到低：

1. 新鲜、完整账号额度快照中任一窗口达到 100%，或结构化错误明确说明账号/套餐/订阅额度窗口耗尽：`scope=account`。
2. routing 给出 `finalProvider`，或结构化错误明确标识当前 provider：`scope=provider`。
3. 其他情况，包括非 JSON HTML 429：`scope=unknown`。

`unknown` 的执行策略与 provider 错误相同，但诊断仍保留 unknown，不伪造归属。

### 3.2 Other failures

- 401/403 与明确账号鉴权错误：account/auth，不降低 provider 健康度。
- 5xx、网络、代理和超时：provider 维度的瞬时失败；现有非 429 自定义账号规则保持兼容，但 provider 健康更新必须记录真实 attempt。
- 明确模型/provider 不支持或不可钉住：provider/unsupported。
- 普通参数 4xx：request/other；不降低 provider 健康度，是否继续 provider chain 保持现有行为，避免额外改变协议语义。
- 客户端断开：无分类写入、无健康惩罚。

### 3.3 Account action gate

`accountActionFor()` 接收分类结果。对于 429，只有 `scope=account` 才可应用 `accountErrorRules[429]`；provider/unknown 429 无账号动作并继续同账号 provider chain。账号规则仍决定明确账号错误是 ignore、cooldown 还是 ban，不增加隐藏的强制冷却。

## 4. Provider health state

复用 `META.models[modelId].upstreamStatus[provider]`，扩展为：

```js
{
  status: "ok" | "limited" | "degraded" | "bad" | "unknown",
  checkedAt,
  lastSuccessAt,
  lastFailureAt,
  consecutiveFailures,
  cooldownUntil,
  failureClass,
  note
}
```

所有时间为非负安全整数；计数有上界；provider/model key 继续受现有路由 slug/model 长度边界约束。旧记录缺失新字段时惰性规范化，保留原 status/note/checkedAt。

更新矩阵：

| Attempt result | State update |
|---|---|
| 成功 | `ok`；清零失败计数、failureClass 和 cooldown |
| provider/unknown 429 | `limited`；合法 Retry-After 优先，否则 `60s * 2^(n-1)`，上限 30m |
| 5xx/network/proxy/timeout | `degraded`；`15s * 2^(n-1)`，上限 2m |
| unsupported | `bad`；1h 冷却 |
| account/auth/request/client disconnect | 不更新 |

合法 `Retry-After` 支持 delta-seconds 与 HTTP-date，统一限制到 1s–30m。显式 Retry-After 不再叠加本地指数倍数。

健康更新不单独同步写盘；沿用请求最终 `record()/commitStatistics()` 的 metadata 保存。流式请求在 finalize 时更新：完整成功恢复，响应开始后的 SSE 错误只影响未来路由而绝不重放当前请求。

## 5. Diagnostics and API projection

内部 trace 增加受控字段：

```js
errorScope, scopeEvidence, failureClass,
healthAction, retryAfterMs,
responseContentType, responseBytes
```

请求日志的 `attempts[]` 和错误日志只投影受控枚举、数字、provider/account 名称以及规范化媒体类型；不得保存 raw response body。错误日志增加 `errorScope/scopeEvidence/failureClass/healthAction`，用于判断某次 429 为什么没有冷却账号。

`/api/models` 继续通过 `meta.upstreamStatus` 暴露渠道状态。控制台：

- 保留“严格钉住 / 优先+回退”配置值；
- 更新 tooltip/说明，明确优先+回退由 switcher 外层逐次执行且每次 only 一个 provider；
- 展示 `degraded`、冷却剩余/到期状态；
- 人工选择列表继续明确显示人工序号；健康标签不得暗示它会重排未冷却的人工顺序，服务端始终是实际路由权威。

响应头继续使用 `X-Cline-Target-Upstream` 表示本账号本次规划顺序、`X-Cline-Attempts` 表示真实 HTTP attempt 总数、`X-Cline-Actual-Upstream` 表示可解析的成功/终态 provider。真实逐次路径以请求/错误日志为权威，不新增可能过长的 trace header。

## 6. Data flow examples

### 6.1 Unknown HTML 429

```text
account A / deepseek only
  -> HTTP 429 text/html, no account/provider evidence
  -> scope unknown
  -> deepseek(model M) limited 60s
  -> account A / fireworks only
  -> success
  -> account A retained; no account cooldown
```

下一请求在 deepseek 冷却期间从 fireworks 开始。60 秒后 deepseek 回到人工首位并接受半开尝试。

### 6.2 Explicit account quota 429

```text
account A / deepseek only
  -> account quota exhausted evidence
  -> scope account
  -> accountErrorRules[429] = cooldown
  -> stop A provider chain; do not penalize deepseek
  -> account B / B's healthiest first provider only
```

### 6.3 All providers cooling

```text
deepseek cooldownUntil=100, fireworks=200
  -> fail-open only deepseek
  -> success resets deepseek
```

### 6.4 No configured providers

- 已探测 provider：使用健康排序后的具名 provider attempts。
- 无探测数据：一次 auto/unattributed；不写任何具名 provider 健康状态。

## 7. Compatibility, rollout, rollback

- 无配置迁移删除；`pinMode=preferred` 保留，运行语义改为外层单 provider。
- 旧 metadata 可启动并惰性补齐状态；新字段持久化后旧版本可能忽略它们，不影响账号密钥/路由配置。
- 发布后观察错误日志中的 scope 分布、provider attempt 数和账号切换率。
- 若错误分类异常，可回滚代码；静态 route config 无需回滚。新增 metadata 字段必须由旧代码容忍。
- 不启用原始响应正文日志；需要人工取证时继续使用短期请求捕获工具。
