# 当前缓存、账号池与调度基线（只读、脱敏）

## 范围与安全边界

- 采集时间：2026-09-16 20:48–20:56 UTC。
- 目标：既有生产主机上的 `cline-pass-console` 与 `cli-proxy-api`。
- 仅执行 SSH、容器状态、配置白名单投影、普通统计/JSONL 聚合及公开 Scheduler 状态读取。
- 未修改配置、账号池、容器、日志或服务；未重启、部署或发送推理请求。
- 未读取或输出账号名称、账号 ID、Key、代理地址、Header 值、请求/响应正文或原始会话值。报告中的 `account#...` 是本次报告专用哈希别名。

原始脱敏聚合：

- `switcher-production-baseline.json`
- `switcher-routing-timeline.json`
- `switcher-provider-routing.json`
- `switcher-provider-observations.json`
- `newapi-channel71-config.json`
- `newapi-channel71-routes.json`
- `newapi-channel71-traffic.json`
- `newapi-session-path.md`

## 结论摘要

1. **“命中率低”首先是指标口径问题。** 最近 24 小时：缓存命中请求率为 `1269 / 2176 = 58.32%`，但缓存 Token 占比为 `153,143,234 / 182,635,883 = 83.85%`。若目标是成本与前缀复用收益，83.85% 比 58.32% 更有代表性。
2. **当前并发调度没有造成账号溢出。** 最近 24 小时 2,394 条请求中，`overflow=0`、`capacityFallback=0`、首选/实际账号不一致为 0、换号为 0。7 个启用账号均为不限并发；估算全局峰值并发为 7，单账号峰值最高为 5。
3. **当前最明确的亲和风险是缺少显式会话键。** 最近 24 小时全部 2,394 条请求的 `sessionSource` 都是 `message_hmac`，没有一条使用 `prompt_cache_key`、Session/Thread Header 或 body session 字段。Switcher 只能依赖首个 system/developer 与首个 user 消息的哈希；一旦开场结构变化，同一业务会话可能被视为新会话。
4. **额度/健康流水线可能造成候选集变化后的会话重映射。** 当前顺序是 `excludeUnhealthy -> quotaPool -> healthSort -> sticky`，粘性只在前面筛选后的候选组内做无状态 HRW。当前 7 个启用账号中 6 个为 hot、1 个为 warm；最近 6 小时的 340 条请求全部落在 hot 池。账号跨 hot/warm、健康层或启停状态时，既有会话没有绑定表保护，会重新映射。
5. **NewAPI 链路已确认没有向 Switcher 提供显式会话键。** 渠道 71 没有 Session/Thread Header 透传或字段同步；`/v1/messages` 会转换为 `/v1/chat/completions`，当前转换器不保留原始 `metadata`。这解释了为何 Switcher 全部退回 `message_hmac`，但尚不能证明全部未命中都由此造成。
6. **上游供应商层仍是潜在变量，但当前证据不能证明同一会话发生供应商切换。** 最近 24 小时 `cline-pass/deepseek-v4.1-flash` 的已知观测结果分布在 Alibaba、Baseten、Fireworks、Novita、TogetherAI；普通日志不保存会话指纹，无法判断这是不同会话的正常分布还是同一会话漂移。

## Switcher 基线

### 账号池与当前策略

| 项目 | 当前值 |
|---|---:|
| 配置账号 | 9 |
| 启用且已配置 | 7 |
| 当前可用 | 7 |
| hot / warm | 6 / 1 |
| 模式 | `sticky` |
| 并发等待 | 2,000 ms |
| 启用账号并发上限 | 全部 `0`（不限） |
| 流水线 | 健康过滤 → 额度池 → 健康排序 → 粘性 |

最近 6 小时共有 340 条请求：338 成功、1 失败、1 客户端取消；没有溢出、容量回退或换号。最近 1 小时 55/55 成功，估算峰值并发 5。

### 缓存统计可信度

最近 24 小时：

| 指标 | 值 |
|---|---:|
| 总请求 | 2,393（统计分钟桶；普通日志边界内为 2,394） |
| 明确 usage | 2,176，覆盖率 90.93% |
| 明确 cache 字段 | 2,176，占明确 usage 的 100% |
| 缓存命中请求 | 1,269 |
| 缓存命中请求率 | 58.32% |
| 输入 Token | 182,635,883 |
| 缓存输入 Token | 153,143,234 |
| 缓存 Token 占比 | 83.85% |

因此 58.32% 不是“只有 58% 输入得到了缓存”；命中的请求承载了更大的上下文，实际 83.85% 的输入 Token 来自缓存。

### 账号间差异

当前启用账号最近 24 小时的缓存 Token 占比约为 63.86%–92.56%，缓存请求命中率约为 28.13%–70.95%。最低请求命中率的账号当前处于 warm 池，最近 6 小时已不再接收新请求。

这些差异不能直接解释为账号本身的缓存能力差异，因为 HRW 会把不同会话/模型分配给不同账号；当前没有“同一会话在多个账号上的对照实验”。

### 不能归因给并发的证据

- 当前没有任何账号容量上限，`concurrencyWaitMs` 实际不会触发容量等待。
- 最近 24 小时 `overflow=0`、`capacityFallback=0`、`preferredAccountMismatch=0`、`switched=0`。
- 估算最近 24 小时全局峰值并发 7，单账号最高 5。

所以现在直接调小 `maxConcurrent` 或改成 least-connections，反而可能让同一会话跨账号，降低缓存复用；没有证据支持将其作为首个动作。

## 会话与上游缓存机制证据

### 本项目行为

Switcher 会先寻找 Codex/Claude/通用显式会话字段，再退回开场消息 HMAC。当前生产全部走消息 HMAC，说明到达 Switcher 的请求没有可用的显式会话键。请求体后续会保留已有 `prompt_cache_key`/`session_id`，但当前入口没有提供它们。

### 官方机制

- OpenAI Prompt Caching 要求共享请求保持稳定前缀；旧模型可使用稳定 `prompt_cache_key` 改善缓存路由，但键只影响路由，不保证命中。官方还说明缓存驻留在具体机器上，过高的同键流量会发生容量溢出路由。
  - https://developers.openai.com/api/docs/guides/prompt-caching
- OpenRouter Prompt Caching 会做 provider sticky routing；可用 body `session_id` 或 `x-session-id` 明确会话，没有时才回退到 `prompt_cache_key` 或开场消息哈希。手工 `provider.order` 会优先于其 sticky routing。
  - https://openrouter.ai/docs/guides/best-practices/prompt-caching
- OpenRouter Response Caching 是另一套“完整请求响应缓存”，Key 包含 API Key、模型、端点、流式模式和规范化请求体，不能与 prompt caching 混为一谈。
  - https://openrouter.ai/docs/guides/features/response-caching
- Cline Chat Completions 通过 `usage.prompt_tokens_details.cached_tokens` 报告真实缓存读取，本项目现有统计口径与该字段一致。
  - https://docs.cline.bot/api/chat-completions

## 当前根因排序

### 已确认

1. 用户看到的“低命中率”是请求级 58.32%；Token 级实际为 83.85%。
2. 生产入口未提供显式会话键，全部退回开场消息 HMAC。
3. 当前没有容量溢出，调整并发选择算法不能解释或直接修复现有命中率。
4. 生产 NewAPI 渠道不生成或透传显式会话键，`/v1/messages` 转换还会丢失原始 `metadata`。

### 高概率

1. 开场消息结构变化会生成新的消息 HMAC，导致账号层和可能的上游 provider 层失去亲和。
2. 额度/健康/启停改变候选集时，无状态 HRW 会让受影响会话重映射并冷启动缓存。
3. 某些模型的上游 provider 漂移会降低 provider 本地缓存复用，但现有日志不足以按会话验证。

### 尚不可观测

1. 58.32% 中有多少是每个新会话的首请求正常冷启动。
2. 同一会话是否存在并发重叠，导致首次缓存写尚未完成就发出下一请求。
3. 同一会话是否跨 provider，以及每个模型/会话的缓存命中曲线。
4. 各类客户端中有多少原本携带稳定会话字段，以及补齐显式会话键能覆盖多少请求。

## 初步策略方向

按当前证据，建议优先级为：

1. **先统一目标指标：**以缓存 Token 占比为主指标，请求命中率为辅助指标，同时监控 usage 覆盖率。
2. **先修会话信号，再改调度算法：**让入口提供稳定且不含敏感正文的 `prompt_cache_key` 或 `session_id`，并验证 Switcher `sessionSource` 从 `message_hmac` 转为显式来源。
3. **不要先收紧并发：**保持当前不限并发，或仅在拿到供应商限制证据后设置高于观测峰值的上限；如必须限流，应优先等待原粘性账号，不要用 least-connections 分散同一会话。
4. **将额度与健康视为硬安全门，而不是频繁软排序：**既有会话应尽量保留原账号；只在禁用、封禁、冷却、额度硬阈值或明确故障时迁移。新会话再按额度/健康选择账号。
5. **补齐聚合可观测性后做 A/B：**不记录原始会话或正文，只统计显式/回退身份来源、匿名会话重复率、会话内账号/provider 切换、首请求/后续请求缓存率、会话并发重叠和迁移原因。

这些是规划方向，不代表已批准的生产改动。
