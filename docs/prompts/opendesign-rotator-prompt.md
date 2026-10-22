# 新会话提示词：OpenDesign 账号轮询器（opendesign-switcher）

> 用法：把「---」以下全部内容粘贴到新会话。先把「0. 上游信息」里的占位填好；填不了的保留原样，新会话会先探测或向你提问。

---

你要从零实现一个 **OpenDesign 上游账号轮询代理**（暂名 `opendesign-switcher`）。它对下游提供 OpenAI 兼容接口，把请求分发到一个 OpenDesign 上游账号池，负责号池调度、会话粘性、账号状态处理、并发与 RPM 控制，以及请求日志、错误日志和详情日志。

架构**参考同机已有的成熟项目** `/home/ubuntu/project/cline-pass-switcher`（下称「参考项目」）。它是 Cline Pass 的同类代理，下面的设计都从它提炼而来。遇到细节不确定时，先读参考项目对应的代码和规范，**照它的契约做精简版，不要自创新机制**。但不要整体复制它：参考项目的 server.js 有 545KB，大量功能是 Cline 特有的。

## 0. 上游信息（使用前填写；未知项先实测或问我，不得臆造）

- 上游 Base URL：`<填写，例如 https://api.open-design.ai/v1>`
- 鉴权方式：`<填写，例如 Authorization: Bearer <账号 key>>`
- 对话接口与协议：`<填写，例如 POST /chat/completions，OpenAI 兼容，支持 stream>`
- 模型列表接口：`<填写或"无">`
- 额度/余额查询接口：`<填写或"无">`。字段含义：`<剩余额度 / 已用百分比 / 重置时间>`
- 典型错误形态：`<401 key 失效 / 402 或 429 额度用尽 / 429 限流 / 5xx 的状态码和正文样例>`
- 是否有"渠道 / provider"这一层：`<有/无>`。没有就去掉参考项目里所有 model×provider 维度，错误规则只保留"账号"和"模型"两个维度。

开工前先确认以上信息。缺失的项用一个真实账号做最小探测（一次小请求、一次额度查询），把实测结果写进 `docs/upstream-findings.md`。探测会消耗真实额度，执行前先问我。

## 1. 技术约束（与参考项目一致）

- Node.js ≥18，ESM（`"type":"module"`），**不用框架、不用 ORM、不加构建步骤**。依赖只允许 `https-proxy-agent` 和 `socks-proxy-agent`，用于账号出站代理。
- 结构：`server.js` 负责协调 HTTP 路由、选号/租约、上游传输、配置和统计；`lib/` 只放边界清晰、可单测的模块（选号排序纯函数、JSONL 日志存储、详情捕获/存储）。
- 运行数据全部放在 `DATA_DIR`（gitignore）：`config.json`（含密钥）、`metadata.json`（运行状态和统计）、`selection-counters.json`、`logs/`、`detailed-logs/`。
- 写盘一律原子化：同目录写 tmp 再 rename，新文件权限 0600。JSON 损坏时启动失败，并保留原文件不动。配置变更先落盘成功，再改内存。
- 测试用 `node:test`。集成测试使用临时 `DATA_DIR` 和本地 mock 上游，**绝不使用真实凭据或生产数据**。
- 单进程。内存中的并发、RPM、绑定状态不跨进程共享，要在 README 里写明。

## 2. 账号模型与状态

参考 `server.js` 的 `normalizeAccount()`（约 813 行）和 `normalizeAccountStates()`（约 329 行）。

- 配置字段：`id`（稳定，`[A-Za-z0-9_-]{1,100}`，缺省生成 `acc_`+24hex，之后不可变）、`clientKeyId`（所属下游密钥，默认 `legacy`）、`name`（≤50 字符）、`note`（≤500 字符，不发上游、不进日志）、`key`（上游凭据，为空则丢弃该账号）、`enabled`、`maxConcurrent`（0=不限）、`maxRpm`（0=不限，上限 100000）、`weight`（1–100）、`priority`（1–100，越小越优先）、`proxyUrl`（http/https/socks5/socks5h；代理失败**绝不回退直连**）、`headers`（自定义头，禁止 authorization/cookie/host/session/api-key 等）。
- 运行状态，存于 `metadata.json` 的 `accountStates[id]`：`cooldownUntil`、`hardQuarantined`、`statusCode`、`reason`、`ruleId`、`updatedAt`，以及额度相关的 `quotaDisposition`（waiting-refresh / quota-exhausted）和保护字段。
- 可调度判定集中在一个函数里（参考 `enabledAccounts()`）。条件：有 key、enabled、属于当前下游密钥、未硬隔离、不在冷却中、没有额度保护 hold。过期的冷却惰性清除。
- 多下游密钥：每个下游密钥只调度自己名下的账号池，**绝不跨池借号**。密钥有账号但全部不可用返回 503，全部忙返回 429。
- 额度（如果上游有额度接口）：后台队列刷新，全局并发 2，成功缓存约 5 分钟，失败按 60s×2ⁿ 退避（上限 15 分钟）。快照超过 15 分钟算过期，按 unknown 处理。**聊天请求不等待额度刷新**。按已用比例分池：<80% 为 hot，<95% 为 warm，其余为 reserve（不参与调度），无快照为 unknown。
- 健康分：最近 24h 分钟桶内 `successes/(successes+degrades)`，样本少于 20 视为未知（参考 `lib/account-workflow.js` 的 `routingHealthRate`）。客户端取消不计样本。

## 3. 选号逻辑

参考 `lib/account-workflow.js` 全文（107 行，可以直接借鉴）和 `server.js` 的 `acquireWorkflowAccountLease()`（约 2569 行）。

固定流程：硬资格过滤 → 会话绑定命中门 → 未命中时依次做额度过滤、健康过滤（顺序可配置）→ 选号器排序 → 并发/RPM 准入 → 取得租约。

- 选号器（`selector`）：
  - `least-selections`（默认）：选号计数少者优先，平局按当前在途数少者，再按游标旋转打散；
  - `roundrobin`：最久未被选中者优先（比较 `lastSelected`）；
  - `least-connections`：在途数最少；
  - `health`：健康分降序，平局按在途数；
  - `reset-soonest`（有额度重置时间时才有意义）：距重置的整天数小者优先，同档内最久未选者优先，仍平局时剩余额度少者优先；无新鲜快照的排最后。
  - 所有选号器最终都用稳定 id 兜底。
- 选号计数 `{version:1, sequence, accounts:{id:{count,lastSelected}}}` 持久化到 `selection-counters.json`，每次新选号同步写入。计数只在**真正取得新账号租约**时 +1，包括溢出和换号；命中已有绑定时不计。删除账号时清掉它的计数。快照损坏时拒绝启动。
- **原子性**：排序、准入、预留、计数更新之间不能有 `await`，同进程内天然原子。
- 一个请求全程使用同一份配置快照（`structuredClone`），避免中途热加载导致策略不一致。
- 健康过滤：阈值 `minimumHealth`（默认 0.2），低于阈值排除，等于阈值允许。未知健康分按 `optimistic`（当作 100%）处理。过滤后无候选时返回明确的 503 筛选错误，**不绕过阈值**。
- 可选的活动缓存池（`cachePoolSize`/`cachePoolMaxSize`）放到 P2 再做，先不实现。
- 提供只读预览接口 `POST /api/account-workflow/preview`：只模拟，不占槽、不改计数、不改绑定。

## 4. 会话粘性

参考 `server.js` 的 `extractSessionIdentity()`（约 4154 行）、`prepareChatAffinity()`（约 4200 行）、sessionBindings 相关函数（约 1565–1720 行）。

- **身份提取**，按优先级取第一个有效值（去空白后 ≤512 字符、不含控制字符）：
  1. 父级标识优先于子级，使父子 agent 落到同一账号：`X-Parent-Session-ID`、Codex `X-Codex-Parent-Thread-Id`、Claude Code `X-Claude-Code-Parent-Agent-Id`。
  2. body 中的 `prompt_cache_key`、`session_id`/`conversation_id`/`thread_id`（含 `metadata.` 下的同名字段）、Claude `metadata.user_id`。
  3. 请求头 `Session-Id` / `X-Session-ID` / `X-Session-Affinity` / `Thread-Id` / `X-Conversation-Id`。
  4. 都没有时回退：取首条 system/developer 消息和首条 user 消息的文本（各截 4096 字符）生成 `message_hmac`，置信度记为 `fallback`。
  5. 仍没有：置信度 `none`，按普通选号处理。
- **指纹**：`HMAC-SHA256(routingSecret, "session\0"+value)`。`routingSecret` 首次启动时随机生成 32 字节，存进 metadata。非默认下游密钥要再按 `clientKeyId` 做一层 HMAC 命名空间隔离。**原始会话值和指纹都不得写入日志或 metadata。**
- **绑定表**：内存 `Map`，利用插入顺序实现 LRU。条目为 `{accountId, source, expiresAt, state, generation, ownerRequestId}`。
  - TTL：显式会话 2h 滑动，fallback 15min 滑动。上限 50000 条，按 LRU 淘汰。重启清空。
  - **两阶段提交**：未命中选号后先写 `provisional`；请求真正发往上游（`req.end()` 之后）才改为 `confirmed`。失败或未发出时，只由本请求删除自己那条 provisional（校验 generation 和 owner）。同会话的并发请求可以命中 provisional。
  - 未命中时，在拿租约前重新查一次绑定表，防止并发竞争下同一会话被绑到两个号。
- **绑定账号忙**（`onBindingBusy`）：
  - `overflow`（默认）：临时用其他账号，**不改写绑定**；
  - `wait-overflow`：先在等待预算内等待，再溢出；
  - `reject`：直接返回 429。
- **绑定失效时机**：账号被删除、禁用、换 key 或换代理，进入 cooldown/硬隔离，跌出可调度集合，或健康分低于阈值。普通失败、成功率波动、额度分档变化都**不改绑**。
- 上游如果支持类似 prompt cache key 的字段：调用方自带就原样透传；只有显式会话头时，用 `HMAC("upstream-prompt-cache\0"+fp)` 派生一个不可反推的值注入。
- 日志只记枚举：`sessionSource`、`affinityKeyType`、`affinityConfidence`（explicit/fallback/none）、`bindingSource`、`bindingResult`（hit/miss/provisional/invalidated/temporary-overflow/not-applicable）。

## 5. 并发控制

参考 `tryLeaseResult()`（约 1795 行）、`createLease()`（约 1775 行）、`reserveRpmPermit()`（约 749 行）、`waitForLease()`（约 1815 行）。

- 数据结构：`activeCounts: Map<id, n>`；`rpmWindows: Map<id, {timestamps[], head, reservations}>`，60 秒精确滚动窗口；`waiters: Set<resolve>`，容量释放时全部唤醒，各自重新评估。
- **准入顺序固定**：硬资格 → `maxConcurrent` → RPM。并发已满时**不预留也不消耗** RPM。
- **租约（lease）**：
  - 准入时 `activeCounts++`，同时原子预留第一个 RPM permit；
  - 之后每个真实上游 attempt 都要单独 `takeRpmPermit()`；
  - permit 在 `req.end()` 之后 `commit()`，进入窗口，之后无论成功、失败、超时还是取消都不退还；未发出就失败时 `release()` 退还并唤醒等待者；
  - `lease.release()` 必须幂等（用 released 标志）。非流式在请求链结束时释放；流式在 `finalize()` 中释放，`finalize` 也要幂等，触发源包括上游结束/错误、下游错误、下游 close；换号前先释放旧租约；异常路径在 catch 中释放。
- **等待**：
  - `concurrencyWaitMs`：0–30000，默认 2000；
  - `poolFullWaitMs`：null 时继承前者，仅用于"全池有限并发都满载且 RPM 有余"的情况；
  - 等待时长取剩余预算与最早 RPM 窗口恢复时刻中较小的那个；
  - 溢出探测一律 0 等待。
- 等待超时返回本地 **429 + 精确 `Retry-After`**，日志记 `errorCategory:"capacity"`，`blockedBy` 取 concurrency/rpm/mixed/unavailable。本地 RPM 不足不得伪装成上游 429，也不计入健康样本。
- **客户端断开**：拿到租约后监听 socket close，中止上游请求，记 499 `client_cancelled`；不评估错误规则，不写健康样本，租约只释放一次。
- 出站连接池：直连 Agent 的 maxSockets 默认 512，代理 Agent 默认 32，可用环境变量覆盖。

## 6. 账号处理与错误处理

参考 `classifyAttemptFailure()`（约 5699 行）、`matchErrorRule()`（约 5779 行）、`handleChat()`（约 6235 行），以及 `.trellis/spec/backend/error-handling.md`。

- **状态归一**：同时保留 `upstreamStatus`（上游真实状态）、`normalizedStatus`（返回下游的状态）和 `terminalOrigin`（success/upstream_http/upstream_envelope/timeout/proxy/network）。仅网络失败或无有效状态时用 502。
- **失败归因**（scope）：401/403 → account；带账号额度证据的 429/402 → account；代理失败 → account/network；超时或 5xx → upstream；其余 4xx → request。
- **errorRules**：有序数组，首条命中即生效（包括 ignore）。每条规则包含：
  - `id`；
  - `scope`：account 或 model；
  - `action`：ignore / degrade / cooldown / hard-quarantine；
  - `when`：`statuses[]`（OR）、`body_contains[]`（ANY，大小写不敏感的普通文本，不支持正则）、header 条件，各类条件之间 AND；
  - cooldown 必须带 `reset{header, format: retry-after|unix-seconds|unix-milliseconds|duration, fallback, max}`，时长写成 `1d2h3m4s` 形式。
  - 匹配对象是已脱敏、最长 16KiB 的失败文本。
  - **未命中时只记 degrade 样本，永远不自动冷却**。冷却和隔离只能由显式规则产生。
- **retryRules**：`{id, decision:"stop", when:{statuses, body_contains}}`。命中后立即停止本请求的剩余重试和换号，原样返回。用于确定性的请求错误，避免把一个用户的坏参数扩散成全池失败。
- **换号循环**：每个请求最多 2 个账号（最多换号 1 次），用 `excluded` 集合保证不重选同一个号。只在**首包之前**、且满足以下任一条件时换号：
  - 账号动作为 cooldown/hard-quarantine；
  - 额度移除；
  - **上游 401**。
  - 普通 5xx、429、超时不换号（如果有 provider 层，就在同一账号内换 provider）。**首包之后绝不重放**。
- **对下游的保护**（参考提交 `f0a4898`）：
  - 上游 401 换号后仍失败时，对下游返回 **502**（`upstream account authentication failed`），**不原样透传 401**，否则 new-api 之类的中转站会把整个渠道判为失效而禁用；日志里仍记录真实的 `upstreamStatus:401`。
  - 上游把确定性的 400/422 包装成 5xx 时，还原成 400/422 返回，按请求错误处理，**不触发**账号或模型冷却。
- **额度耗尽保护**（如果上游有额度接口）：首包前收到 429/402，且正文明确表示账号额度用尽时，先加约 30s 临时 hold，并强制刷新该账号额度；刷新确认耗尽后才持久封禁，并提供管理员解除接口。刷新失败或结果未知时，不形成永久封禁。
- **流式**：等到首个完整 SSE 事件、并确认它不是错误包，才开始向下游转发；首事件超时 120s，空闲超时 360s。开始转发后每 25s 在 SSE 事件边界注入 `: PING` 心跳。
- 返回给下游的响应头：`X-Request-Id`、`X-Attempts`、`Retry-After`（有值时）。不要把账号名或 key 放进响应头。

## 7. 日志（三层，互相独立）

参考 `lib/jsonl-log-store.js`、`lib/detailed-log-capture.js`、`lib/detailed-log-store.js`，以及 `.trellis/spec/backend/logging-guidelines.md`。P0 先做请求日志和错误日志，详情日志放到 P1，但要按参考项目的契约实现，不要简化掉安全约束。

**请求日志** `DATA_DIR/logs/requests-*.jsonl`
- 每个请求结束时写**一行**终态记录。`requestId` 同时通过响应头返回给下游。
- 字段：
  - 标识：`ts, requestId, requestedModel, resolvedModel, stream, inboundProtocol`
  - 账号与调度：`accountId, accountName, selectionReason, selector, overflow, switched`
  - 会话：`bindingSource, bindingResult, affinityKeyType, affinityConfidence`
  - 结果：`status, result(success/failed/client_cancelled), upstreamStatus, errorCategory(capacity/upstream/proxy/network), blockedBy, retryAfter`
  - 耗时：`durationMs, ttftMs`（参考项目没有 TTFT，这里要新增）
  - 用量：`inputTokens, outputTokens, cachedTokens, cacheHit`。缺失记 null，**不填 0**；`cacheHit` 是三态（true/false/null）。
  - 尝试路径：`attempts[]`，每项包含 `account, status, upstreamStatus, ms, action, ruleId, egress`
  - 工作流轨迹：`workflow.decisions`，有界，最多 4 条，每条最多 8 个节点。

**错误日志** `DATA_DIR/logs/errors-*.jsonl`
- 每次真实失败的上游 attempt 写一行，通过 `requestId + attemptIndex` 与请求日志关联。客户端取消不写。
- 字段：`ts, requestId, attemptIndex, accountId, accountName, model, status, upstreamStatus, category, reason, reasonTruncated, ruleId, ruleScope, ruleAction, matchedBy, retryRuleId, retryDecision, healthAction, retryAfterMs, responseContentType, responseBytes, detailCallId`。
- `reason` 先脱敏，再按 UTF-8 边界截断到 16KiB。非 JSON 的错误正文只记一句通用原因和字节数。

**存储规则**（两类日志共用一个 `JsonlLogGroup`）
- 按 5MiB 分段滚动；单条记录 ≤64KiB；保留 30 天；请求 50000 条、错误 10000 条，两类合计 ≤100MiB，超出按时间删最旧。
- 写入走串行异步队列，**写失败 fail-open**：丢弃记录并计数，不影响模型流量。
- 启动时后台恢复已有日志，恢复期间查询返回 503，写入照常。
- 查询 API：
  - `GET /api/logs/{requests|errors}?limit=1..200&cursor=&<白名单过滤字段>`，游标分页，结果从新到旧；未知参数返回 400；
  - `DELETE` 只清空指定的那一类。

**详情日志**（P1）
- 两个开关：`errorDetailLogging`（默认开，只捕获失败调用）和 `detailedLogging`（默认关，完整捕获）。
- 每段正文最多捕获 5MiB，不截断实际转发的流量。SSE 失败时只保留触发失败的完整事件。
- 存储：`DATA_DIR/detailed-logs/<requestId>/{manifest.json, <bodyId>.txt}`，目录 0700、文件 0600，先写 tmp 目录再原子发布，保留 7 天、总量 ≤1GiB。
- 脱敏器先从所有 Header 和正文里"学习"已知凭据（Bearer/Basic、Cookie、URL 认证信息、凭据类字段名、当前请求涉及的账号 key），再统一替换。凭据过多或片段无法安全解释时，整组省略（fail-closed）。
- 详情只能通过管理员会话访问，管理员未初始化时完全不捕获。

**安全不变量**
- 普通日志必须先构造严格的字段投影再写入，**禁止 `JSON.stringify(req / account / upstreamError)`**。
- 以下内容永不写入普通日志或 metadata：账号 key、代理 URL 及其认证信息、任何 Header 值、请求或响应正文、消息文本、原始会话值、会话指纹、账号备注。
- 统一用 `redactSecrets()` 处理所有对外文本：替换全部已知密钥、代理 URL、`Bearer xxx`。

**统计**：不从日志推导。请求结束时写入 metadata 的分钟桶（1440 个，即 24h），记录请求数、错误数、真实 usage、各账号成功/降级样本。`GET /api/statistics` 只返回聚合数据。

## 8. 管理 API 与控制台（P0 最小集）

- 管理员登录与下游密钥完全分离：
  - 密码用 scrypt 加盐存储；
  - 会话 Cookie 为 `HttpOnly; SameSite=Strict`，有效期 24h；
  - 所有非 GET 请求校验 CSRF token 和 Origin；
  - 登录失败限流：同一 IP 60s 内 5 次。
- 账号接口：
  - `GET /api/accounts`：返回账号列表，**key 只返回掩码**（参考项目返回明文，这里要改进），附带状态、在途数、RPM、健康分、额度；
  - `POST /api/accounts`：整表保存，带 `expectedConfigurationRevision` 乐观锁，版本冲突返回 409。按差异精确失效状态：换 key 或代理时清除绑定、RPM 窗口和额度快照；
  - **新增批量导入**（参考项目没有）：一行一个 key，可选附带名称和代理；
  - `POST /api/accounts/test`：用指定账号发一次真实小请求；
  - `/api/accounts/recover`：清除冷却或隔离；
  - `/api/accounts/reset-health`：清除健康样本。
- 其他接口：`GET/POST /api/logs/settings`、日志查询、`POST /api/account-workflow/reset-counts`、`POST /api/config/reload`（SIGHUP 热加载，不中断在途请求）。
- 控制台：单文件 `public/index.html`，内联脚本，严格 CSP，不引入构建工具。页面包括账号表、选号配置、错误规则编辑、请求日志、错误日志、详情日志、统计。

## 9. 明确不做

- 不做多进程或多副本共享状态，不引入 Redis 或数据库。
- 不伪造 User-Agent、设备指纹或 TLS 指纹，不绕过上游风控。
- 不实现参考项目中 Cline 特有的功能：provider 钉选、规划器/直连管道识别、定期渠道探测、参考价格估值、FloppyData。
- 出口代理池放到 P2；P0 只支持账号级 `proxyUrl`。

## 10. 交付阶段与验收

- **P0**：账号模型、可调度过滤、选号器、计数持久化、会话粘性两阶段绑定、并发/RPM 租约、等待与 429、换号循环与 401→502 保护、errorRules/retryRules、请求日志和错误日志、管理员鉴权、账号 API、最小控制台。
- **P1**：详情日志、额度查询与分池、额度耗尽保护、统计页、批量导入。
- **P2**：活动缓存池与 grow-one 扩容、出口代理池、Responses/Anthropic 入站适配（参考 `lib/responses-adapter.js`、`lib/anthropic-adapter.js`）。

每个阶段都必须满足：

1. `node --test` 覆盖关键不变量，并且这些测试在实现出错时能真正失败：
   - 租约只释放一次；
   - 并发满时不消耗 RPM；
   - permit 未发出时退还；
   - 换号不重选同一账号；
   - 首包后不重试；
   - provisional 绑定只由所属请求清理；
   - 临时溢出不改绑；
   - 上游 401 对下游返回 502；
   - 5xx 包着的 400 被还原且不冷却；
   - 客户端断开记 499 且不写样本；
   - 日志中不出现 key、会话值、正文。
2. 用本地 mock 上游跑通流式和非流式、多账号并发压测，确认在途数和 RPM 统计与预期一致。
3. 对每个修改过的文件执行 `node --check`，然后执行 `git diff --check`。
4. README 写明配置字段、默认值、单进程限制和回滚方式。

## 11. 工作方式

- 先读参考项目的 `README.md`、`.trellis/spec/backend/{quality,error-handling,logging,database,client-key}-guidelines.md` 和 `lib/account-workflow.js`。需要细节时再用 grep 定位 `server.js` 里上文提到的函数，**不要通读 server.js**。
- 先输出模块划分、数据结构和 P0 实施计划，等我确认后再写代码。
- 上游行为不确定时（状态码、额度字段、错误文本）先问我或做最小实测，不要猜。
