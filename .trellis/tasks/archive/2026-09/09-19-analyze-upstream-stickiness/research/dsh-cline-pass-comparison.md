# `dsh-cline-pass` 与当前项目的上游粘性策略对比

## 1. 范围与证据

调研时间：2026-09-18 UTC。

- 当前项目：`yeschoy/cline-pass-switcher`，本地 `HEAD=59bab7b4fdec3e6a7e738b58c113d9e7f1bbda96`。当前工作树存在其他任务的未提交修改；本报告只读分析实际工作树与已提交路由契约，没有修改业务代码。
- 参考项目：[`yhshzh/dsh-cline-pass`](https://github.com/yhshzh/dsh-cline-pass)，检出提交 `22f3a615e0a6406bd5b100c7aea02ba612792d16`。
- 当前项目永久契约：`.trellis/spec/backend/quality-guidelines.md`。
- 当前项目既有缓存调研：`.trellis/tasks/archive/2026-09/09-17-improve-cache-hit-scheduling/`。
- 当前缓存活跃池生产验证：`.trellis/tasks/09-17-deploy-cache-pool-validation/`；截至本报告可见任务状态，24 小时正式结论尚未勾选完成，不能声称已经达到 70%。
- 官方机制：
  - OpenRouter Prompt Caching / Provider Sticky Routing：<https://openrouter.ai/docs/guides/best-practices/prompt-caching>
  - OpenAI Prompt Caching：<https://developers.openai.com/api/docs/guides/prompt-caching>
  - Cline Chat Completions usage：<https://docs.cline.bot/api/chat-completions>

安全边界：没有读取生产配置、账号 Key、代理凭据、Header 值、原始消息、原始会话或 HMAC 指纹，也没有连接生产或发送付费请求。

## 2. 先给结论

1. **参考项目不是一套更先进的账号粘性实现。** 它的 README 明确说明上游渠道与故障转移行为参考了 `cline-pass-switcher`（`README.md:120`）。它主要把已有 provider pin/failover 能力包装成 dsh 插件。
2. **当前项目的账号层已经明显更强。** 当前项目具备 HRW 会话粘性、稳定 ID、容量租约、六种账号模式、额度/健康流水线、双活缓存池、账号级模型路由和严格的首包后不重放语义；参考项目的账号层只有 `single` / `roundrobin`（`lib/index.js:189-203`）。
3. **参考项目真正值得借鉴的是“一键配置”工作流，而不是路由核心。** 它串联 `probe → validate → 排序/排除 → pin → verify`（`lib/panel.js:299-363`）。当前项目虽已有所有单项能力，但需要人工逐步完成。
4. **若目标是缓存，不应原样复制参考项目的一键算法。** 参考项目最终保存 `pinMode=preferred` 并可能设置 `sort=ttft`。OpenRouter 官方文档明确：手工 `provider.order` 优先于 provider sticky routing，并会关闭后者。该算法偏“可用性/首字速度”，不等于“盯死 provider 以提高缓存”。
5. **当前最重要的瓶颈仍是稳定会话信号，而不是再增加账号算法。** 既有只读生产基线显示请求全部使用 `message_hmac`，没有显式 session/thread/prompt cache key。没有稳定会话键时，账号 HRW 和 OpenRouter provider sticky 都只能退回开场消息哈希。
6. 推荐目标是**双层亲和**：先固定“会话 → 账号”，再固定“会话 → provider”；只在首个可见输出前、满足明确故障条件时切换。不能把账号轮询与 provider 重试混在同一层。

## 3. 两个项目实际做了什么

### 3.1 当前项目

#### 账号层

- `extractSessionIdentity()` 优先读取 Codex/Claude parent 与 session/thread 标识，再读取通用 session 字段，最后退回首个 system/developer 与首个 user 内容的本机 HMAC；原值和指纹不记录（`server.js:1278-1343`）。
- `sticky` 使用稳定账号 ID 的 HRW 排名，无需持久化 session→account 表；同一候选集内结果稳定（`server.js:520-576`）。
- `cachePoolSize > 0` 时，正常流量仅在 priority/稳定 ID 选出的活跃账号中做 HRW；reserve/unhealthy 才触发硬替换，活跃池全满则等待后再溢出 standby（`server.js:600-740`）。
- provider 尝试发生在账号租约之后；`runChatChain()` 的全部 provider 候选使用同一个账号。只有匹配 cooldown/ban 且尚未开始输出时，`handleChat()` 才最多换一次账号（`server.js:1886-2053`）。

#### provider 层

- 全局或 `accounts[].perModel[model]` 可配置 `upstreams / exclude / pinMode / sort / maxRetries`；账号级对象是完整覆盖，不与全局字段合并（`server.js:114-131`、`server.js:1842-1849`）。
- `strict` 对每次尝试注入单一 `only=[provider]`；`preferred` 注入 `order=[当前,...]`，外层仍能按候选继续尝试（`server.js:1769-1826`）。
- 非流式错误、网络失败、超时以及首个有效 SSE 事件前的错误可切下一个 provider；一旦下游已看到有效流事件，不重放（`server.js:1886-1991`）。
- 普通请求日志记录 target provider、actual provider、尝试路径、账号选择原因、cache-pool tier 和切换事实，但不记录会话值/指纹（`server.js:1190-1220`）。
- probe / validate / test 能探测管道、收集 provider、逐个校验并验证实际命中（`server.js:898-1057`、`server.js:2200-2233`、`server.js:2456-2464`）。

### 3.2 `dsh-cline-pass`

#### 账号层

- 只有 `single` 与 `roundrobin`；没有 session affinity、并发租约、健康/额度、冷却/封禁或 cache active pool（`lib/index.js:189-205`、`lib/panel.js:118-120`）。
- 流式 adapter 在每个 provider candidate 内调用 `resolveAccount()`（`lib/adapter.js:481-499`）；非流式 engine 的每次 attempt 也独立调用（`lib/engine.js:95-103`）。因此 round-robin 模式下，provider failover 可能顺带换账号。

#### provider 层

- 与当前项目相同，按 pipeline 注入 `provider.only/order` 或 `providerOptions.gateway.only/order`，支持 strict/preferred/exclude/sort（`lib/protocol.js:91-168`）。
- 只在首个内容交付前切 provider；已经 yield 内容后不静默重放（`lib/adapter.js:468-570`）。
- `setupAuto()` 一次完成 probe、逐渠道 validate、按耗时排序可用项、把 bad/auth 排除、保存 preferred/ttft，再发真实请求验证（`lib/panel.js:299-363`）。
- provider 探测结果和 history 是进程内状态，重启清空（`lib/store.js:1-18`）；pin 配置由 dsh settings 持久化。

## 4. 关键差异矩阵

| 维度 | 当前项目 | `dsh-cline-pass` | 判断 |
|---|---|---|---|
| 会话→账号粘性 | HRW；显式身份优先，消息 HMAC 兜底 | 无，仅 single/roundrobin | 当前项目更强 |
| 缓存活跃账号池 | 有，active/standby、硬状态补位、容量等待 | 无 | 当前项目更强 |
| provider pin | strict/preferred/exclude/sort | 同类能力 | 基本同源 |
| provider failover 中账号是否固定 | 固定；普通 provider 失败不换账号 | round-robin 可随 candidate 换账号 | 当前项目更适合缓存与故障隔离 |
| 首包后重放 | 禁止 | 禁止 | 一致 |
| 账号错误动作 | 可配置 ignore/cooldown/ban，最多换号一次 | 无等价状态机 | 当前项目更强 |
| 账号级模型路由 | 有完整 override | 仅全局 per-model pin | 当前项目更强 |
| probe/validate/test | 有 | 有 | 一致 |
| 一键配置 | 无完整串联 | 有 `setupAuto()` | 参考项目更好 |
| 探测状态重启行为 | metadata 持久化 | 进程内，重启清空 | 当前项目更强 |
| 历史/统计 | 持久、安全投影、缓存统计、筛选 | 进程内最多 100 条 | 当前项目更强 |
| 插件集成 | 独立 OpenAI 兼容代理 | dsh 原生插件/工具 | 场景不同，不宜直接比较 |

## 5. 当前项目仍可改进的地方

### P0 — 先补稳定会话键；不要再先加账号调度算法

**证据：**既有生产基线中所有请求均为 `message_hmac`，未出现显式 session/thread/prompt cache key。OpenRouter 官方说明：显式 `session_id` 或 `x-session-id` 会直接成为 provider sticky key；否则依次退回 `prompt_cache_key` 与开场消息哈希。显式 session 还能在第一次成功后立即建立 sticky，而不必等到先观察到 cache hit。

**建议：**让入口层（现有证据指向 NewAPI）生成或透传稳定、无敏感正文的 session ID；Switcher 继续用该信号做本地 HMAC 路由。以 `sessionSource` 中显式来源占比作为上线门禁。

**为何优先：**同一键可以同时稳定当前项目的账号 HRW 和上游 provider sticky；新增第七种账号算法不能弥补身份信号缺失。

**边界：**不要在 Switcher 中猜测“相似会话”，也不要持久化原始 session 或 HMAC 指纹。

### P1 — 在自动 provider 模式下规范化上游 sticky key（需先做线协议验证）

当前 Switcher 能识别 Claude/Codex 专用 session/parent 字段用于本地账号 HRW，但 OpenRouter 官方识别的是 body `session_id`、`x-session-id`，再退回 `prompt_cache_key`。协议专用 Header 即使安全透传，也不能假设 Cline/OpenRouter 会把它当成同一 sticky key。

可验证的最小设计：

- 若请求已带合法 body `session_id` 或 `prompt_cache_key`，保持原值；
- 否则，在**自动 provider 模式**下，把已验证的客户端稳定身份域分离 HMAC 成新的上游 session key，而不是发送原始 session；
- strict pin 不需要该转换；preferred/order 会覆盖 OpenRouter sticky，因此不应伪装成生效；
- 默认关闭或只在已验证 pipeline 开启；先用本地 mock 和受控真实测试确认 Cline 接受并透传该字段；
- 任何派生 key 都不得进入普通日志、metadata 或错误响应。

这不能替代入口提供真实稳定会话键；生产当前只有 `message_hmac` 时，派生 key 仍继承开场消息变化/碰撞的局限。

### P1 — 增加“缓存优先”上游配置工作流，但不要照搬 preferred/ttft

参考 `setupAuto()` 的交互骨架，复用当前已有的 probe/validate/test：

1. 选择作用域：全局，或一个明确账号；缓存活跃池场景应按 active 账号逐一验证。
2. probe 并确认 direct/planner pipeline。
3. validate 每个 provider。
4. 给出**预览**，不立即持久化：
   - 缓存优先：一个已验证 primary，`strict`；可选多个 strict 外层 fallback。
   - 可用性优先：`preferred`，允许 gateway order/fallback。
   - 自动 sticky：不发送手工 provider order，透传稳定 session ID，让 OpenRouter sticky 生效。
5. 发一次测试，检查 actual provider 与预期。
6. 用户确认后，沿现有 `/api/config` 原子保存，并重新加载服务端接受状态。

**关键提示：**UI 必须明确说明 `preferred`/手工 `provider.order` 会覆盖 OpenRouter provider sticky；不能把“最快首字”包装成“缓存命中优先”。

### P1 — 把“钉死”定义成可执行的双层契约

推荐默认契约：

| 项目 | 推荐值 |
|---|---|
| 路由键 | 显式 parent/session/thread ID；无则 `prompt_cache_key`；再无才 message HMAC |
| 账号保持条件 | active pool、账号可用、未进入 cooldown/ban/reserve/unhealthy，且容量可等待 |
| provider 保持条件 | strict primary，或自动模式下由上游 session sticky 保持 |
| provider 切换 | 仅在首个客户端可见输出前发生明确 transport/5xx/rate-limit/不可用错误 |
| 账号切换 | 仅 cooldown/ban/disable/reserve/unhealthy，或活跃池容量等待超时 |
| 首包后失败 | 透传失败并更新未来状态；绝不重放 |
| 重启 | 账号 HRW 由持久 routingSecret 与稳定 ID 保持；上游自动 sticky 的远端 TTL 不由本地保证 |

### P2 — provider 健康事实应至少区分账号作用域与失败类别

当前 `META.models[model].upstreamStatus[provider]` 是全局状态；`validateUpstreams()` 选一个账号执行全部校验（`server.js:1010-1057`）。但 auth/proxy/账号额度失败不等于 provider 本身坏。

建议：

- validation/test 接受明确 `accountId`，并在 UI 标示测试账号；
- provider 事实至少区分 `provider unavailable` 与 `account auth/proxy/quota`；
- 若要驱动自动路由，状态应按 `(accountId, resolvedModel, provider)` 或证明可安全共享的更小维度存放；
- `auth` 不应进入全局 provider 排除集合；
- 所有状态需要 TTL/checkedAt，过期变 unknown，而不是永久坏。

参考项目同样没有解决这一点，不能复制它把 `auth` 放进 `broken` 并全局排除的做法。

### P2 — provider failover 需要 hold-down/circuit breaker，但必须先有指标

当前静态候选每个新请求都从第一个 provider 开始。primary 长时间故障时，每个请求都会先失败再回退；恢复边界又可能立即切回，既增加延迟，也可能让 backup 缓存难以升温。

候选改进：

- 仅对首包前确定性失败建立短 TTL provider cooldown；
- TTL 内从最后成功且仍合格的 provider 开始；
- half-open 单探测恢复，不让所有请求同时试 primary；
- 状态按账号/模型/provider 隔离；
- 不把普通参数 4xx、客户端取消或首包后失败当成切换依据。

这一步比一键配置风险高，应在 provider-switch 与缓存指标可观测后再做；不要先引入持久 session→provider 表。

### P2 — 补齐无需记录会话值的粘性指标

当前日志有 `actualProvider`、target path、账号切换、session source 和缓存 usage，但缺少可直接回答以下问题的聚合：

- 显式 session 来源占比；
- 每模型/账号/provider 的 cache token ratio 与请求命中率；
- provider fallback 率、首选失败率、重试增量延迟；
- active 内溢出与 standby overflow；
- 切换后若干请求的缓存恢复曲线。

`.trellis/tasks/09-18-account-metrics-content-error-rules/` 已规划每模型缓存统计和上游发现修正，应复用该统计所有者，避免新建第二套 store。跨请求 switch 指标只能保存聚合，不能持久化原始/HMAC session key。

### P3 — 修正文档和默认配置漂移

- `README.md` 已说明 `accountPipeline.cachePoolSize`，但 `config.example.json` 的 `accountPipeline` 示例当前未展示该字段。
- UI 应把三种语义分开：`strict=硬钉住`、`preferred=可用性优先的有序回退`、`auto+session=让上游 sticky`。
- 生产缓存池验证尚未完成时，不应在文档或界面宣称“开启即达到 70%”。

## 6. 不建议做的事

1. **不复制参考项目“每个 provider attempt 重新 round-robin 账号”。** 这会把 provider 故障转移变成账号切换，破坏账号缓存、代理隔离、统计归属和错误动作边界。
2. **不把 `preferred + ttft` 叫做缓存策略。** 它优化的是可用性/首字速度，并可能关闭 OpenRouter 自带 provider sticky。
3. **不新增持久 session→account/provider 映射表。** 当前 HRW 已能无状态稳定选号；新表增加隐私、清理、TTL、并发和重启一致性成本。
4. **不因软健康分数、hot/warm 波动频繁重排活跃池。** 当前 cache pool 的硬状态补位设计更符合缓存稳定性。
5. **不自动把 `auth` 失败解释为 provider 坏。** 这是账号维度错误。
6. **不在客户端看到有效 SSE 后重放。** 两个项目都正确地禁止这一点。

## 7. 推荐实施顺序

### 第一阶段：无核心算法变更

- 打通稳定 session ID；
- 在现有统计中展示 session source 占比；
- 完成当前缓存活跃池 24 小时验证；
- 对核心模型/active 账号人工使用 strict primary 做小范围 A/B，不自动改生产。

### 第二阶段：低风险产品化

- 先验证 Cline 对标准 `session_id`/`x-session-id` 的透传，再决定是否增加域分离的上游 sticky-key 规范化；
- 增加可预览的一键 `probe → validate → propose → test → confirm`；
- 明确提供“缓存优先 / 可用性优先 / 自动 sticky”三个策略，而不是一个模糊的一键配置；
- validation 状态按账号作用域展示；
- 补齐 `config.example.json` 与 UI 帮助。

### 第三阶段：有指标后再做自适应

- provider cooldown / half-open；
- 按模型/账号/provider 的安全聚合指标；
- 以缓存命中、失败率和 P95 进行开关式 A/B；
- 保留关闭开关和严格回滚路径。

## 8. 验收与观测建议

主指标：

- 缓存请求命中率；
- 缓存 Token 占比；
- 明确 usage/cache 字段覆盖率。

护栏：

- 最终失败率；
- P50/P95 首 token 或总延迟；
- provider attempt/request；
- provider fallback 与账号 switched 比例；
- cachePool standby overflow；
- active 账号 quota/health 状态。

必须分层观察：

- 新会话首请求 vs 后续请求；
- `message_hmac` vs 显式 session；
- model；
- account；
- actual provider；
- strict / preferred / automatic 三种策略。

没有这些分层前，不能把总体命中率变化归因给“钉死 provider”。
