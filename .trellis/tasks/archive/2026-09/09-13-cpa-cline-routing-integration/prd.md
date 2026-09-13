# NewAPI 接入下的 Cline 账号池与供应商路由增强

## Goal

直接增强 `cline-pass-switcher`，使 NewAPI 能通过现有 OpenAI 兼容接口接入，由本项目统一负责 Cline Pass 账号池管理、账号调度策略及最终供应商选择；在提高账号与供应商路由稳定性的同时，完整保留账号、模型与上游绑定能力。

## Background and Confirmed Facts

- 本期不接入 CPA，也不修改 `cpa-strategy`；预期链路是 `NewAPI -> cline-pass-switcher -> Cline Pass -> 最终供应商`。
- `cline-pass-switcher` 已提供 `/chat/completions`、`/v1/chat/completions` 和 `/api/v1/chat/completions` 等 OpenAI 兼容聊天端点。
- 当前账号池配置为 `accounts: [{ name, key, enabled }]`，调度只有 `single` 与 `roundrobin` 两种模式；`server.js:111` 的 `pickAccount()` 在每次上游尝试时重新选择账号，没有会话粘性。
- 当前供应商配置存储在全局 `perModel[modelId]` 中，通过 `server.js:468` 的 `injectPrefs()` 注入 `provider.only/order` 或 `providerOptions.gateway.only/order`，支持严格钉住、优先回退、多供应商顺序故障转移、排除及排序。
- 现有代码没有独立的“账号 -> 模型 -> 上游”三级绑定；本期将在保留全局 `perModel` 的前提下增加账号级整项覆盖。
- 当前 `server.js:123` 发给 Cline 的请求只显式设置 `Content-Type` 与所选账号的 `Authorization`，不会透传 NewAPI 的客户端请求头；Node `fetch` 还会自动补出非客户端真实提供的 Header。
- 本机 `newapi-saas` 已有 Header 覆盖/字段同步能力，可处理 `Session-Id`、`Session_id`、`Thread-Id`、`X-Client-Request-Id`、`User-Agent` 等真实客户端字段，并支持将 Header 会话值同步到请求体 `prompt_cache_key`；因此本项目不需要要求 NewAPI 核心改造即可获得稳定会话标识。
- `newapi-saas` 与现有 `cpa-strategy` 代码确认 Codex 和 Claude 的身份规则不同：Codex 主要使用请求体 `prompt_cache_key`、`Session-Id`/`Session_id`、`Thread-Id`/`Thread_id`、`X-Codex-Turn-Metadata` 及父线程字段；Claude 主要使用 `X-Claude-Code-Session-Id`、Agent/Parent-Agent Header 以及请求体 `metadata.user_id` 中的会话信息。`X-Client-Request-Id` 是逐请求标识，不可单独作为会话粘性键。
- 当前没有每账号设备/浏览器/TLS 指纹、出口 IP、速率限制、并发限制、账号冷却或会话粘性机制。

## Requirements

1. NewAPI 必须能够通过本项目现有 OpenAI 兼容端点发起流式和非流式聊天请求。
2. 本项目继续作为 Cline Pass 账号池与账号调度的唯一所有者，本期不得依赖 CPA。
3. 现有账号管理能力以及模型供应商的严格钉住、优先回退、顺序故障转移、排除和排序能力必须保留。
4. 新增明确的账号级“模型 -> 上游”绑定：账号对某模型没有专属配置时完整继承现有全局 `perModel`；一旦存在专属配置，则整项替代该模型的全局路由，包括上游顺序、严格/优先模式、排除列表、排序策略与最大重试次数，不做逐字段合并。控制台支持复制全局配置为账号专属配置，以及删除专属配置恢复继承。
5. 一个逻辑请求被选中账号后，其全部供应商故障转移尝试必须使用同一个账号，不得因普通供应商错误在重试途中换号。全局规则的 `ignore` 动作不换号；只有 `cooldown`/`ban` 明确移除当前账号且尚未向客户端输出响应时，才允许最多换号一次。换号后按新账号自己的模型路由从头执行；流式响应已开始或第二个账号失败时不得继续换号。
6. 保留现有 `single`、`roundrobin` 策略并保持旧配置兼容；新增 `sticky` 策略，使用稳定会话标识和 HRW 在可用账号集合中选号，使同一会话稳定命中同一账号，并在账号退出可用集合后以最小扰动映射到其他账号。Codex/Claude 子会话存在可信父线程或父 Agent 标识时优先以父会话为路由键；并发满载时仍可按规则仅对当前请求临时溢出。若没有可识别的 Codex、Claude 或通用会话字段，则以首个 system/developer 消息和首个 user 消息生成仅用于路由的 HMAC 指纹；不持久化消息原文，无法提取消息时才回退 `roundrobin`。首期不加入权重、最少请求等额外策略。
7. 账号错误处置使用全账号统一的可配置规则，默认规则为空以保持旧行为；至少能按规范化状态码执行“忽略/保持可用”“冷却指定时长”“封禁”，例如 429 冷却 30 分钟、500 封禁。规则匹配前必须保留上游原始 HTTP 状态及可验证的脱敏错误信息，不能把所有错误统一折叠为 502。冷却状态需持久化 `cooldownUntil` 并到期自动恢复；封禁状态需持久排除且只能由管理员手动恢复；两者只记录必要原因、状态码和时间。首期不提供单账号规则覆盖。
8. 增加每账号可选的并发上限，`0` 表示不限制。全局 `concurrencyWaitMs` 默认 2000 ms，可配置范围为 0～30000 ms；`sticky` 先等待原账号释放容量，超时后仅为当前请求临时选择 HRW 排名中的下一个可用账号，不改变后续首选映射；`roundrobin` 跳过满载账号；`single` 或整个账号池在等待后仍无容量时返回 HTTP 429 和安全的 `Retry-After`。首期不增加自定义 RPM。
9. 请求头采用按客户端协议区分的明确允许列表，并将其中真实存在的客户端元数据全部透传，包括会话类 Header；会话字段同时用于账号粘性选号。Codex 允许列表覆盖真实的 session/thread/turn/parent、Originator、User-Agent 及相关 Codex 功能 Header；Claude 允许列表覆盖真实的 Claude session/agent/parent-agent、Stainless、Anthropic、X-App 与 User-Agent Header；通用 OpenAI 客户端支持标准会话、`HTTP-Referer`、`X-Title` 和 `X-Client-Request-Id`。Codex 与 Claude 必须采用各自的会话/父会话识别优先级。缺失值必须省略，不得伪造 Cline 版本、设备 ID、Cookie、Attestation 或其他官方客户端指纹；下游 `Authorization`、`Proxy-Authorization`、Cookie 与逐跳 Header 始终不透传。
10. 下游 `Authorization` 只用于访问本代理，不得被当作 Cline Pass Key 转发；账号密钥不得出现在日志、错误响应或诊断响应头中。
11. 保留账号、模型、目标供应商、实际供应商、故障转移路径及账号处置动作的可观测性，但不得记录原始会话值、消息原文或敏感响应内容。
12. 缓存改进必须通过实际响应中的 `usage.prompt_tokens_details.cached_tokens` 等字段验证，不能只根据配置推断。
13. 后端路由能力与现有 Web 控制台同步增强：控制台需支持调度模式、每账号并发上限、账号运行状态与手动解封、全局错误处置规则，以及全局/账号级模型供应商路由；同时保留 `config.json` 直接配置能力。

## Acceptance Criteria

- [ ] NewAPI 可通过现有 OpenAI 兼容地址完成流式和非流式请求。
- [ ] 现有账号管理与模型供应商选择功能没有被删除或降级。
- [ ] 账号级模型/上游绑定能够整项覆盖、持久化并影响实际路由；没有账号级配置时完整继承全局 `perModel`，删除专属配置可恢复继承。
- [ ] 同一逻辑请求的普通供应商尝试使用同一账号；只有规则明确移除当前账号且响应尚未开始时，才最多换号一次。
- [ ] 可配置 429 冷却 30 分钟、500 封禁等状态码动作，配置能够持久化并真实改变后续账号候选集合。
- [ ] 每账号并发上限可配置并生效；`sticky` 默认等待 2 秒后临时溢出且不改变首选映射，全部账号满载时返回 429。
- [ ] 错误判断可读取上游原始/规范化状态，不会因统一转成 502 而导致规则失效。
- [ ] `single`、`roundrobin` 旧配置继续工作，新增 `sticky` 可配置并持久化。
- [ ] 同一会话在可用账号集合不变时稳定命中同一账号；某账号退出可用集合后只对必要会话进行稳定重映射。
- [ ] Codex/Claude 子会话在提供可信父标识时继承父会话账号；缺少显式会话字段时，稳定开场消息生成的 HMAC 指纹可复现同一账号选择，且不记录对话原文。
- [ ] 单供应商严格钉住与多供应商优先回退在 direct、planner 两条已识别管道中继续生效。
- [ ] 允许列表中的真实请求头完整透传，会话类 Header 同时参与粘性选号；Codex 与 Claude 的识别规则分别验证。
- [ ] 不透传下游 `Authorization`、Cookie 或逐跳 Header，不生成虚假客户端指纹。
- [ ] 下游凭据、Cline Pass Key 与内部认证值不会泄漏到日志、错误或诊断响应头中。
- [ ] Web 控制台能够配置新增的调度、并发、账号处置和账号级供应商绑定能力，并能查看和手动恢复封禁账号。
- [ ] 有可运行验证覆盖账号稳定、供应商绑定、重试不换号、请求头策略及流式/非流式路径。
- [ ] 在支持缓存的真实模型上记录首次请求和重复前缀请求的缓存用量，明确区分路由稳定与实际缓存命中。

## Out of Scope

- CPA 或 `cpa-strategy` 集成及修改。
- 模拟或伪造官方 Cline 客户端、浏览器或设备指纹。
- TLS/JA3 指纹伪装、Cookie/设备认证绕过、出口 IP 轮换等规避平台检测的机制。
- NewAPI 核心代码修改，除非后续证据证明标准 OpenAI 接入无法满足需求并由用户另行批准。
- 首期自定义 RPM/每分钟请求数限制。
