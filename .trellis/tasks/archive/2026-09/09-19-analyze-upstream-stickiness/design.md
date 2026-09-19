# 双层亲和与 Provider 故障治理设计

## 1. 范围与交付顺序

本任务只修改 `cline-pass-switcher`，不修改 NewAPI/CPA，也不操作生产。Chat 范围包括现有三个 Chat Completions 入口；`/v1/responses` 继续保持现有 501 行为。

由于 `09-19-model-cache-statistics-ui` 正在修改 `server.js`、`public/index.html`、integration/UI tests 和统计 specs，本任务按以下顺序执行，避免两个 owner 并发改同一契约：

1. 等待该任务合入当前分支，重新读取最终 statistics/log/UI 契约。
2. 先实现 Chat 显式会话身份、上游 `prompt_cache_key` 映射和安全请求日志。
3. 再实现账号作用域 provider 校验与缓存优先工作流。
4. 最后在已有指标上实现默认关闭的 provider cooldown/half-open。

每一阶段都必须独立通过测试；不得为了最后阶段一次性引入第二套路由或统计 owner。

## 2. Chat 会话身份模型

### 2.1 唯一 owner

继续由 `extractSessionIdentity(req, body)` 拥有身份选择，不新增 session store。返回值扩展为只含安全派生事实：

```js
{
  source,       // 现有兼容枚举：codex_parent / codex_body / ...
  keyType,      // 精确安全枚举，不含值
  confidence,   // explicit | fallback | none
  fingerprint,  // 请求内使用；不得记录/持久化
}
```

原始 session 值只在提取栈帧中存在。`hmacIdentity()` 继续使用持久 `META.routingSecret`，保证重启后 HRW 稳定。相同可信标识通过协议专用或通用载体到达时，保持现有“路由到同一账号”的兼容行为。

### 2.2 优先级

Codex：

1. `X-Codex-Parent-Thread-Id`；
2. `X-Codex-Turn-Metadata` 中 parent session/thread/conversation；
3. body `prompt_cache_key`；
4. `Session-Id` / `session-id`；
5. `Thread-Id` / `thread-id`；
6. turn metadata 当前 session/thread/conversation。

Claude：

1. `X-Claude-Code-Parent-Agent-Id`；
2. `metadata.user_id` 结构化 parent session/agent/thread/conversation；
3. `X-Claude-Code-Session-Id`；
4. `X-Claude-Code-Agent-Id`；
5. `metadata.user_id` 结构化当前 session/agent/thread/conversation。

随后才是通用 parent/body/header，再是 `message_hmac`，最后无键 round-robin。`X-Client-Request-Id` 继续不得建立亲和。

`keyType` 使用稳定枚举，例如：

```text
parent_session | prompt_cache_key | session_id | thread_id |
parent_agent | agent_id | conversation_id | message_hmac | none
```

`confidence=explicit` 只用于通过完整长度/控制字符验证的显式标识；`message_hmac` 为 `fallback`。

## 3. 上游 Chat prompt-cache key

### 3.1 注入规则

新增单一纯 helper，例如：

```js
prepareChatAffinity(body, identity)
// -> { body, diagnostics }
```

规则：

1. body 已有非空且合法 `prompt_cache_key`：不改 body，来源 `caller_prompt_cache_key`。
2. 否则 body 已有非空且合法 `session_id`：不改 body，来源 `caller_session_id`。
3. body 字段存在但非法：不覆盖、不删除，让上游保持原兼容/错误语义；日志只记安全枚举 `caller_invalid`。
4. 否则身份为 Codex/Claude `explicit`：注入固定 64 字符域分离 HMAC：

   ```text
   HMAC(routingSecret, "upstream-prompt-cache\0" + identity.fingerprint)
   ```

   来源 `derived_codex` 或 `derived_claude`。
5. `message_hmac`、generic fallback 或无身份：不注入，来源 `none`。

派生值不能进入日志、metadata、响应头/体或管理 API。它在本次请求 body 中生成一次，账号替换和 provider 重试复用同一值。

### 3.2 与 provider pin 的关系

- `strict`：provider 已硬钉住；prompt key 仍可帮助最终 provider 的内部缓存，但不参与本地 provider 选择。
- `preferred`：网关收到 `provider.order`；日志增加 `providerOrderOverridesSticky=true`，明确不能声称 OpenRouter sticky 生效。
- automatic：没有手工 order 时，`prompt_cache_key` 可被支持的上游用于会话路由；日志只描述“字段已提供”，不声称远端实际采用。

不新增新配置字段：用户已明确要求 Chat 适配，且当前 Chat 已透明接收原生 Codex `prompt_cache_key`。派生字段与现有 wire shape 同名；回滚为移除 helper 调用。

## 4. 普通请求日志与控制台提示

### 4.1 安全日志字段

扩展现有 request projection，而不是记录 key：

```js
{
  sessionSource,
  affinityKeyType,
  affinityConfidence,
  upstreamPromptCacheKeySource,
  upstreamPromptCacheKeyApplied,
  providerOrderOverridesSticky,
  cacheHit // true | false | null
}
```

语义：

- `upstreamPromptCacheKeyApplied=true` 只表示请求 body 已带可用 `prompt_cache_key` 或 `session_id`（caller 或派生），不证明远端命中或采用。
- `cacheHit=true`：最终规范化 usage 明确报告缓存字段且 `cachedTokens > 0`。
- `cacheHit=false`：最终规范化 usage 明确报告缓存字段且 `cachedTokens === 0`。
- `cacheHit=null`：无成功最终 usage、缓存字段缺失/非法或请求失败/取消。

不记录缓存 key、session/thread 值、fingerprint、消息内容或 body。普通 error log 不复制这些字段，避免每次 provider attempt 重复会话事实。

### 4.2 生命周期

`handleChat()` 在解析 body 后得到 `identity` 与 `affinity`，请求级 finalizer 在所有结局中传递同一安全 diagnostics：

- 容量拒绝：key 来源可记录，`cacheHit=null`，不产生上游 applied 假象；
- 非流式成功：从最终 `normalizeUsage()` 得到三态；
- 流式成功：从最后累计 usage 得到三态；
- provider/account failover：仍是一次最终 request record；
- 失败/取消：`cacheHit=null`；
- 日志写失败：保持流量 fail-open。

### 4.3 UI

请求日志主表的“策略/原因”或新增紧凑列直接显示：

```text
亲和：Codex prompt_cache_key（显式）
上游 key：caller / derived / none
缓存：命中 / 明确未命中 / 未知
```

旧行没有字段时显示“未知”，不迁移/改写历史 JSONL。所有文本从安全枚举映射，不渲染任意服务端值；详情 JSON 仍可查看完整安全投影。

请求日志 API 可增加严格 `cacheHit=true|false` 与安全 enum 过滤；若 UI 本轮不需要过滤，可以只投影/显示，避免扩大查询接口。

## 5. 账号作用域 provider 校验与一键流程

### 5.1 账号选择

抽取并复用现有 `/api/test` 的账号查找/可用性/lease 边界，不使用 `pickAccount()` 绕过容量与账号代理。`/api/probe`、`/api/validate-upstreams` 接受可选 `accountId`：

- 未提供：按现有调度安全选择一个账号；
- 提供未知账号：400；
- 提供不可用账号：409；
- 容量不足：429；
- 所有网络调用使用该账号的 Key、proxy、headers/route 适用边界；租约最终释放。

probe 的 harvest 以及同一 validation 批次必须固定在同一账号，不能 provider 候选间换号。

### 5.2 状态分类

现有全局 `upstreamStatus` 只接受可安全共享的 provider 结果：

- `ok`、明确 provider `limited`、明确 unsupported/bad 可带 TTL 更新；
- account auth、proxy/network、账号 quota 单独返回 `accountFault`，不得写成全局 provider bad/auth；
- 所有投影带 `checkedAt`；过期状态在排序/预览时视为 unknown，不删除历史字节也不伪装 fresh。

优先复用 `META.models` 当前 owner；不新增第二个 metadata 文件或 store。是否持久化账号作用域结果在实现前根据最终 model-stat task 的 metadata schema复核；最小方案可只在一次 setup 响应中使用账号故障事实。

### 5.3 一键流程

服务器提供只读 proposal endpoint 或现有端点组合，UI 拥有预览草稿：

1. probe；
2. validate；
3. 生成三个候选策略；
4. 用户选择并 test；
5. 用户确认后才调用现有 `/api/config` 完整 route 保存；
6. 重载服务器接受状态。

三个策略：

- 缓存优先：strict，已验证 primary 在前，其他 strict 外层 fallback；
- 可用性优先：preferred，有序 gateway fallback；
- 自动 sticky：无手工 upstream/order，依赖请求 prompt key 与上游能力。

preview/cancel 不持久化 route，不自动修改账号、错误规则或调度流水线。

## 6. Provider cooldown / half-open

### 6.1 Owner 与键

在 `server.js` provider routing owner 内增加一个有界运行时 Map；键为：

```text
accountId + resolvedModelId + provider
```

状态仅含安全运行事实：`cooldownUntil`、`failureClass`、`consecutiveFailures`、`halfOpenOwner`。不含 session、消息、Key 或响应 body；进程重启清空，避免新增迁移和持久状态 owner。

### 6.2 触发与恢复

允许触发：首包前 provider transport、明确 provider 5xx、rate limit、unsupported/unavailable。

禁止触发：参数 4xx、账号 auth/quota、账号 proxy 故障、客户端取消、首包后错误、管理测试流量（除显式 setup 校验）。

默认配置关闭（冷却时间 0）。启用后：

- build attempts 前跳过仍冷却的 provider；
- 若跳过后无候选，保持可用性：选最早到期候选进行受控 half-open，而不是直接伪造无 provider；
- TTL 到期只有一个请求取得 half-open owner；其他请求继续 fallback 或按现有错误语义返回；
- 成功清除；失败按有界退避更新；
- 任何路径都不在首包后重放。

配置采用 per-route `providerCooldownMs`，默认 0，并复用全局/账号完整 route normalizer；这样不同模型与账号可独立选择是否启用，账号 override 仍保持整项覆盖语义。

## 7. 统计与并行任务边界

- `META.statistics` 仍是唯一聚合 owner。
- 当前模型缓存任务合入后，本任务只增加缺失的 session-source/provider-fallback/circuit-breaker 聚合；不重写模型 minute bucket 或账号摘要。
- 普通 request JSONL 保留逐请求安全事实，统计存聚合计数；不得从 JSONL 临时反算长期统计。
- 未知与已知 0 均保留，溢出规则沿用固定 counter + `overflowFields`。

## 8. 兼容、风险与回滚

- 旧请求无显式键时，本地 HRW 行为不变；`message_hmac` 不新增上游 key。
- Caller 提供的 body 字段逐字保留；禁止覆盖。
- 新日志字段为追加式，旧行/API 客户端继续可读。
- Provider cooldown 默认关闭，关闭时尝试序列和错误语义必须字节级/序列级等价。
- Cline 是否实际利用派生 prompt key只能由真实 usage 与 provider 路由观测证明；本地 mock只能证明字段注入与不泄露。
- 回滚阶段 1：移除派生 helper/日志字段，旧 JSONL 追加字段被旧代码忽略。
- 回滚阶段 2：撤销新管理 endpoint/UI；现有 perModel route 数据仍兼容。
- 回滚阶段 3：将 cooldown 配置设为 0，再回滚代码；不删除日志或统计。
