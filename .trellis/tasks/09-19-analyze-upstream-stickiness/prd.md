# 增强双层上游亲和与故障治理

## Goal

在已完成的 `dsh-cline-pass` 对比研究基础上，增强 Codex/Claude 会话到账号与实际 provider 的双层亲和，补齐账号作用域 provider 校验、受控 provider 故障治理、缓存相关可观测性和配置文档，同时保持首包后不重放、账号隔离与敏感数据边界。

## Background

- 参考项目的 provider pin/failover 逻辑来源于 `cline-pass-switcher`；当前项目的账号粘性、缓存活跃池和故障隔离更完整，可借鉴点主要是一键 `probe → validate → propose → test → confirm` 工作流。完整证据见 `research/dsh-cline-pass-comparison.md`。
- 当前 `extractSessionIdentity()` 已识别 Codex parent/thread/session/`prompt_cache_key` 与 Claude parent-agent/session/agent/`metadata.user_id`，并优先 parent 身份；集成测试已证明直接到达 Switcher 的 Codex/Claude parent-child 请求命中同一账号。
- 已有生产只读证据显示 NewAPI → Switcher 的请求全部退化为 `message_hmac`：生产渠道未透传 Session/Thread/Claude Code Header；`/v1/messages` → `/v1/chat/completions` 转换未保留 `metadata`，也未生成 `prompt_cache_key`/`session_id`。用户已明确本任务不修改 NewAPI，因此本任务只保证直接 Chat 请求和已经透传到 Switcher 的字段；不能承诺修复生产 `/v1/messages` 的入口丢失。
- Codex 当前源码默认用 session ID 生成 `prompt_cache_key`，并保留显式 override；Claude Code 2.1.x 流量可提供 `X-Claude-Code-Session-Id` 和 `metadata.user_id.session_id`。调用链应优先显式 session，不得使用 request ID、账号、IP 或 User-Agent 冒充会话。
- OpenRouter 支持 body `session_id`、`x-session-id`、`prompt_cache_key` 的 provider sticky；手工 `provider.order` 会覆盖其 sticky routing。缓存优先、可用性优先和自动 sticky 必须作为不同策略呈现。
- 正在执行的 `.trellis/tasks/09-19-model-cache-statistics-ui/` 已拥有每模型 24h 缓存统计、账号摘要和 provider 发现修正。本任务不得重复修改同一统计 schema/UI；相关指标应作为依赖或后续增量接入。

## Requirements

### R1 — Codex/Claude 显式会话身份

- Codex 优先使用可信 parent/session 身份；支持当前客户端的 `prompt_cache_key`、`session-id`、`thread-id`、`X-Codex-Parent-Thread-Id` 和 `X-Codex-Turn-Metadata`，保留 caller 明确提供的 `prompt_cache_key`。
- Claude 优先使用 `X-Claude-Code-Parent-Agent-Id` / 根 session，再回退 `X-Claude-Code-Session-Id` 与结构化 `metadata.user_id.session_id`；子 agent 不得因自己的 agent ID 与根会话拆分。
- 延续现有兼容契约：相同可信 parent/current 标识即使通过协议专用或通用载体到达，也应路由到同一账号；原值只在请求内使用，经域分离 HMAC 后参与本地路由，不得写入 metadata、普通日志、错误响应或浏览器投影。
- `X-Client-Request-Id`、IP、User-Agent、账号/token、bare user ID 和普通 SDK Header 不得建立会话亲和。
- 显式身份缺失时保留现有 `message_hmac` 兼容兜底，并把它明确标记为低置信来源；不得声称已经恢复真实会话。

### R2 — Chat 上游 prompt-cache sticky key

- 范围仅限现有三个 Chat Completions 入口；不修改 NewAPI，也不新增 Responses 转换。
- 若请求已有非空合法 `prompt_cache_key` 或 `session_id`，必须原样保留且不得覆盖。
- 对 Switcher 实际收到的 Codex/Claude 高置信显式会话，在缺少上述 body 字段时生成域分离、不含原始值的 `prompt_cache_key`，并随 Chat body 发往 Cline；`message_hmac` 仅继续用于本地账号 HRW，不自动伪装成显式上游会话键。
- `strict` provider pin 不依赖上游 sticky；`preferred/provider.order` 必须明确标注会覆盖 OpenRouter sticky。
- Cline 当前已接收原生 Codex `prompt_cache_key` 的同名透传；新增派生只复用该既有 Chat 字段，不注入未知 metadata 或原始 Claude session。

### R3 — 账号作用域 provider 校验与缓存优先工作流

- probe/validate/test 必须能明确选择账号并使用该账号的 Key、代理和模型路由；结果不得把账号 auth/proxy/quota 错误误判为全局 provider 不可用。
- provider 事实至少区分 provider unavailable 与 account auth/proxy/quota，并带 bounded `checkedAt`/TTL；过期事实回到 unknown。
- 增加可预览的 `probe → validate → propose → test → confirm` 工作流，分别提供“缓存优先 strict”“可用性优先 preferred”“自动 sticky”方案。
- 保存继续复用现有全局/账号 `perModel` 完整 route normalizer 与 `/api/config` 原子边界；预览/取消不得修改配置或发起未确认的保存。

### R4 — Provider cooldown / half-open

- 只有首个客户端可见输出前的确定性 provider transport、5xx、rate-limit 或明确 unavailable 才能进入短 TTL cooldown。
- 普通参数 4xx、客户端取消、账号 auth/proxy/quota、首包后失败不得错误熔断 provider。
- cooldown 状态按账号、resolved model、provider 隔离；不能新增第二套账号选择器、请求队列或持久 session 映射表。
- TTL 到期使用单一 half-open owner，避免并发请求同时探测；失败延长受限 cooldown，成功恢复并清除状态。
- 功能默认关闭或具备显式安全默认值，关闭后现有候选顺序、尝试数、状态码和日志语义保持兼容。

### R5 — 可观测性与现有任务边界

- 普通请求日志已记录粗粒度 `sessionSource`，但不显示实际键值。新增精确、安全的 `affinityKeyType`、`affinityConfidence`、`upstreamPromptCacheKeySource` 和 `upstreamPromptCacheKeyApplied` 等枚举/布尔提示，使操作员能判断最终采用了 Codex prompt key、Claude session、其他显式键、`message_hmac` 或无键。
- 结合最终规范化 usage，在同一请求日志中记录三态 `cacheHit`（明确 cached tokens > 0 为 true、明确 0 为 false、缺失/非法为 null），使操作员能判断“哪类亲和键对应了缓存命中”；不得记录原始 `prompt_cache_key`、session/thread 值、派生 key 或 HMAC fingerprint。
- 控制台请求日志主表直接显示“亲和键来源 / 上游 key 是否应用 / 缓存命中”，而不是要求操作员展开原始 JSON；旧记录缺字段时显示未知。
- 复用现有 statistics/request-log owner，后续增加 provider fallback/首选失败、cooldown/half-open 结果和增量延迟聚合；不得记录原始/HMAC session key。
- 每模型缓存与账号摘要由现有 `09-19-model-cache-statistics-ui` 任务提供；本任务只在其完成后追加确有必要、无重复 owner 的 provider 维度指标。
- 未知、已知零、覆盖不足和计数溢出必须保持可区分。

### R6 — 文档与兼容

- `config.example.json` 补充 `accountPipeline.cachePoolSize` 及本任务新增配置的安全默认值。
- README/UI 清楚区分 strict、preferred 与 automatic sticky，禁止承诺仅靠配置即可达到固定缓存命中率。
- 旧配置、旧客户端及未启用新功能的六种账号模式、provider 尝试、首包后不重放和代理失败不直连行为保持不变。

## Acceptance Criteria

### 已完成研究

- [x] 形成两个项目的实现对比、证据定位和分级建议。
- [x] 明确定义账号与 provider 双层亲和、切换条件和不应复制的参考行为。

### 待实现

- [x] 直接到达 Switcher 的 Codex/Claude 根会话、parent-child/subagent、body/header fallback 在多轮请求中保持同一账号；冲突时按文档优先级选择。
- [x] 直接 Chat 请求携带 Codex/Claude 显式会话时不再退化为 `message_hmac`；NewAPI 已丢字段的请求仍如实显示 fallback，不虚假标记为显式来源。
- [x] Caller 自带 `session_id`/`prompt_cache_key` 不被覆盖；缺少 body key 的 Codex/Claude 显式会话只注入域分离派生 `prompt_cache_key`，`message_hmac` 不注入。
- [x] 普通请求日志和控制台可直接区分最终亲和键类型、上游 prompt key 是否应用及三态缓存命中，但任何原始/派生会话键与 HMAC 指纹均不出现。
- [x] 账号作用域校验不会把 auth/proxy/quota 错误污染为全局 provider 故障；一键流程预览、取消、测试、确认和完整 route 保存均有覆盖。
- [x] Provider cooldown/half-open 只由允许的首包前错误触发；并发 half-open、TTL、恢复、首包后错误、取消和关闭兼容行为有确定性测试。
- [x] 新诊断只包含安全枚举/数值；复用 v3 statistics/request-log owner，无第二套 schema/store。
- [x] `node --check`、相关 UI/VM/integration 测试、完整 `npm test` 与 `git diff --check` 通过。
- [x] 验证只使用本地 mock；未连接生产、修改生产配置或发送付费请求。真实浏览器因缺失 `agent-browser` 二进制未验证，见 `research/verification.md`。

## Out of Scope

- 修改 NewAPI 或 CPA；未经额外批准部署生产 Switcher、账号池或 provider 路由。
- 持久化原始 session、HMAC fingerprint 或 session→账号/provider 映射表。
- 从消息相似度、IP、User-Agent 或 request ID 猜测高置信会话。
- 在当前模型缓存统计子任务完成前重复实现其统计 schema、账号摘要或模型 UI。
