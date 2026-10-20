# Research: HTML-429 重试链路、规则、会话粘性、限速与日志（为动态代理池做准备）

- **Query**: HTML 429 处理与重试循环结构；errorRules/retryRules；会话粘性/缓存池是否假设"账号=固定出口"；maxRpm/maxConcurrent/poolFullWaitMs 可复用模式；请求日志 trace 结构与 META 持久化
- **Scope**: internal（`server.js` 6885 行、`.trellis/spec/backend/*`、README、`docs/upstream-ip-rate-limit-findings.md`、归档任务）
- **Date**: 2026-10-20
- 所有行号针对当前工作树 `server.js`（HEAD b336318 + 未提交改动）。

---

## 1. HTML 429 处理与首字节前重试链路

### 1.1 识别 / 分类

| 位置 | 内容 |
|---|---|
| `server.js:5297-5299` | 注释 + 常量 `GATEWAY_BACKOFF_BASE_MS=1000, GATEWAY_BACKOFF_MAX_MS=8000, GATEWAY_BACKOFF_JITTER_MS=250, GATEWAY_THROTTLE_RETRIES=1` |
| `server.js:5300` | `const gatewayThrottles = new Map()`（进程内，不持久化） |
| `server.js:5301-5303` | `isGatewayThrottle(result)`：`upstreamStatus===429 && terminalOrigin==='upstream_http' && responseContentType==='text/html' && !structuredError` |
| `server.js:5304-5306` | 注释 "Process-local HTML-429 backoff is per account id (not per proxyUrl)…"；`gatewayAccountKey = account.id` |
| `server.js:5307-5314` | `noteGatewayThrottle(account)`：streak 规则——距上次窗口结束 >30s 归零；窗口内的并发拒绝共享同一窗口（streak 不变）；窗口过后 30s 内再次拒绝 streak+1（上限 3）。`until = max(prev.until, now + min(8000, 1000*2^streak))`，返回 `until-now` |
| `server.js:5315` | `clearGatewayThrottle(account)`：成功时删除（`settleAttempt` 200 分支 `server.js:5490`） |
| `server.js:5316-5319` | `gatewayWaitMs(account)`：窗口内返回剩余时间 + `random(0..250)` 抖动 |
| `server.js:5320-5325` | `nonJsonUpstreamErrorBody`：HTML 429 → `{error:{message:'upstream gateway rate limited (HTML throttle)', type:'rate_limit_error'}}` |
| `server.js:5331-5335` | `classifyAttemptFailure`：429 依次判断 fresh quota 100% → structured account quota → **`isGatewayThrottle` → `{scope:'gateway', evidence:'gateway_html_throttle', failureClass:'rate_limit'}`** → routing finalProvider → structured provider → ambiguous |
| `server.js:5458-5461` | 非流式 `attemptOnce`：非 JSON 响应且 `429 + text/html` 时 `netError=null`、`terminalOrigin='upstream_http'`，body 用上面的 HTML-throttle 文案 |
| `server.js:5693-5721` | 流式路径：非 SSE 响应读全文 → 同样构造 result（`terminalOrigin: up.status>=400?'upstream_http'…`，`nonJsonUpstreamErrorBody`） |

### 1.2 `Retry-After` 如何被合成

- `settleAttempt` 网关分支 `server.js:5499-5505`：
  ```js
  if (classification.scope === 'gateway') {
    const backoffMs = noteGatewayThrottle(account);
    result.retryAfter = String(Math.ceil(backoffMs / 1000));
    ...
    return { classification, policy: { ruleId: null, scope: null, action: 'ignore', ... matchedBy: ['default'] },
      accountAction: null, quotaRemovalAction: null, healthAction: 'none', providerCircuitAction: null, retryDecision: null, gatewayThrottle: true };
  }
  ```
  即**直接短路**：不跑 `matchErrorRule`、不跑 `matchRetryRule`、不碰 provider circuit / 健康样本 / quota 信号；half-open 探针被复位（`5502`）。
- `result.retryAfter` 被 `last = {...result}` 带出（`5726`/`5759`），非流式/首字节前失败最终在 `server.js:6146` 写 `Retry-After` 响应头。
- "Retry-After: 2" 的来源：第一次 429 → streak 0 → 1000ms → `"1"`；循环等待过窗口后重试再 429 → `now >= prev.until` 且 30s 内 → streak 1 → 2000ms → `"2"`，这是最终返回给客户端的值。

### 1.3 "同账号同出口立即重试"的实际流程（`runChatChain`）

- `server.js:5618-5625` `gatewayStep`：
  ```js
  let gatewayRetries = 0;
  const gatewayStep = (diagnostic, attempt) => {
    if (!diagnostic.gatewayThrottle) return null;
    if (gatewayRetries >= GATEWAY_THROTTLE_RETRIES || clientClosed) return 'stop';
    gatewayRetries++;
    attempted.delete(attempt.upstream || 'auto');   // 允许同一 provider 再被选中
    return 'retry';
  };
  ```
- 调用点：流式 `server.js:5727-5729`、非流式 `server.js:5761-5763`：`if (gateway === 'retry') { index--; continue; }` —— 不消耗 `maxAttempts`。
- 循环顶部 `server.js:5629-5633`：每次 attempt 前 `await gatewayWaitMs(account)`（按 **account.id**），所以重试实际会等 ≈1s+抖动（测试 `test/workflow-integration.test.js:357-389` 断言 `>=900ms`、2 次调用、同账号同 provider）。
  - 注意：`docs/upstream-ip-rate-limit-findings.md:18` 写"约 140ms 后立即重试"，与代码（≥1s backoff）不一致；140ms 更像是 HTML 429 本身的响应耗时（trace `ms`）。代码层面重试仍走**同一 account 对象 → 同一 `account.proxyUrl` → 同一 agent → 同一出口**，所以"白试"的结论成立，只是间隔不是 140ms。
- 出口由 `clineRequest` 决定：`server.js:4228-4231` `effectiveProxy = proxyUrl || account?.proxyUrl || ''`；`runChatChain` 不传 `proxyUrl`，因此 attempt 级出口 = 账号固定 `proxyUrl`。
- 网关重试也会再取一个 RPM permit（`server.js:5646-5652`），无 permit 则以本地 RPM 429 结束（`localRpm`，`5772-5778`）。

### 1.4 现有首字节前重试约束（两级）

**外层（账号级，`handleChat`）** `server.js:5896-5937`：
- `for (let accountAttempt = 0; accountAttempt < 2; accountAttempt++)` —— **至多一次换号**。
- 换号条件 `server.js:5921`：`!chain.plan?.autoHeldExploration && (action ∈ {cooldown, hard-quarantine} || quotaRemovalAction ∈ {waiting-refresh, protection-pending}) && !chain.started && accountAttempt === 0 && !chain.retryStop`。
- 换号做法：`excluded.add(account.id)` → `lease.release()` → `acquireAccountLease(identity, {excludeIds: excluded})`，`selected.reason='replacement-after-account-action'`（`5930`），`completedTrace.push(...chain.trace)`；结束后 `chain.trace = [...completedTrace, ...chain.trace]`（`5937`）。
- 网关 HTML 429 的 `accountAction=null` → **永不触发换号**。README `:317` 与 spec `quality-guidelines.md:223` 明文："never rotates provider or account"。

**内层（provider 级，`runChatChain`，固定一个账号）** `server.js:5581-5782`：
- `maxAttempts`：`plan.maxAttempts = cfg.maxRetries==null ? Infinity : maxRetries+1`（`server.js:5060`）；auto 源=1（`5065`、`5599`）；gateway-owned pipeline（`META.models[m].pipeline !== 'direct'`，`5016`）强制 1（`5594-5598`），一次 HTTP 带 only+order 全列表。
- `nextAttempt()`（`5600-5604`）：auto / gatewayNamedAttempt / `selectProviderAttempt(modelId, plan, account, attempted)`。
- 每次 attempt 后的出口判断（非流式 `5760-5766`，流式 `5727-5732`、`5740-5742`）：成功 break → gatewayStep → `retryDecision==='stop'` → `retryStop=true; break` → 账号 cooldown/hard-quarantine/quotaRemoval → break（交给外层换号）→ 非流式 timeout 且 `!NON_STREAM_TIMEOUT_RETRY` → break → 否则继续下一个 provider。
- 流式 `!up`（传输失败，含代理失败）分支 `5734-5743` **没有** gatewayStep，直接走 retryRules/账号动作/继续。
- 首字节判定：流式只有 `readFirstSseEvent` 成功且首事件不是 error 时才 `return {started:true, streamUp…}`（`5744-5750`）；之前所有失败都在"首字节前"，可以安全重试。

### 1.5 数据结构

- `trace`（`runChatChain` 局部，`5585`）：每个真实 attempt 一条 `traceAttempt(...)`（形状见 §5）。
- `attempted`（`5585`）：已尝试 provider 集合，gatewayStep 会删回。
- `accountPath`（`handleChat` `5857`、`5904`）：账号名数组，`switched = accountPath.length > 1`（`3959`）。
- `accountActions`（`5898`，push 于 `5920`、`6027`、`6033`）：`{account, action, statusCode, ruleId, scope}`。
- `attemptOwner`（`5858`）：`{nextAttemptIndex, bindingSelection, lease, onAttemptCommit()}`；`clineRequest` 在 `req.end()` 后分配 `attemptToken {attemptIndex, callId}` 并调用 `onAttemptCommit → commitSessionBindingSelection`（`4264-4267`）。

### 1.6 "换出口重试"可插入的位置（仅描述现有结构的落点）

- 现成钩子是 `gatewayStep`（`5619-5625`）及其两个调用点（`5727`、`5761`），位于 `settleAttempt` + `trace.push` 之后、retryRules/账号动作判断之前；它返回 `'retry'` 时 `index--` 不占 provider 预算、不经过外层换号逻辑、不产生 accountAction，因此改变"下一次 attempt 用哪个出口"不会影响 `accountAttempt<2` 的换号语义或 provider retry 计数。
- 出口目前由 `account.proxyUrl` 隐式决定；`clineRequest`/`clineRequestJSON`/`attemptOnce` 已有 `proxyUrl` 参数（`4195`、`4198`），但 `attemptOnce`（`5446-5452`）和流式 `clineRequest` 调用（`5663`）都没有传它。
- 每轮循环顶部 `gatewayWaitMs(account)`（`5629`）是按账号阻塞的等待点；若换出口，此等待仍会按 account.id 阻塞（当前 key 为 account.id）。
- 流式首字节前传输失败（`!up` 分支，`5734`）与 HTML 429 分支是两个不同出口。

---

## 2. errorRules / retryRules

| 位置 | 内容 |
|---|---|
| `server.js:74-75` | 默认 `errorRules: []`, `retryRules: []` |
| `server.js:466-476` | `ERROR_RULE_SCOPES={account, provider-model}`；`ERROR_RULE_ACTIONS={ignore, degrade, cooldown, hard-quarantine}`；`RETRY_RULE_DECISIONS={stop}`（只有 stop） |
| `server.js:520-590` | `normalizeErrorRules`：`when.statuses/body_contains/header` AND，`reset{header,format,fallback,max}` 仅 cooldown |
| `server.js:593-620` | `normalizeRetryRules`：`{id, decision:'stop', when:{statuses, body_contains}}`，status 与 body 必须同时命中 |
| `server.js:5388-5400` | `matchRetryRule` 首条命中返回 `decision:'stop'`，否则 `'continue'` |
| `server.js:5401-5427` | `matchErrorRule`：显式规则首条命中（含 ignore）；无命中默认：`classification.scope==='account' && failureClass∈{auth,rate_limit,network}` → **account degrade**；具名 provider 的 rate_limit/server/network/timeout/unsupported → provider-model degrade；其余 ignore |
| `server.js:5428-5436` | `persistAccountAction`：仅 cooldown/hard-quarantine 写 `META.accountStates[id]`（`cooldownUntil`/`hardQuarantined`/`banned`…），并 `clearProviderCircuitForAccount` + `invalidateSessionBindingsForAccount` + `saveMeta()` |
| `server.js:5437-5442` | `persistProviderAction`：写 `META.models[m].upstreamStatus[provider]` |
| `server.js:5506-5524` | `settleAttempt` 非网关分支：policy → accountAction → quotaSignal → 持久化 → healthAction → provider circuit → retryDecision |

动作语义：
- `ignore`：不写样本、不处置。
- `degrade`：只记一个失败样本（account 或 provider-model 健康），不冷却；低额度池账号（`quotaRole==='low'`）上的 account degrade 会变成 `quotaRemovalAction='waiting-refresh'`（`5515`），触发首字节前换号。
- `cooldown`：账号/渠道临时冷却（`resetDelayForRule`，`5366-5382`，支持 `Retry-After` 头解析）；account 维度会在首字节前触发一次换号。
- `hard-quarantine`：持续封禁直到人工恢复。

"429 HTML 默认规则"：**不存在作为 errorRule 的定义**。HTML 429 在 `settleAttempt:5499` 被硬编码短路，绕过所有 errorRules（即使存在匹配 429 的 account cooldown 规则——测试 `workflow-integration.test.js:357-389` 正是配置了 `general-429` cooldown 规则来证明不生效）。`config.example.json:36-54` 的样例规则 `account-rate-limit` 只匹配 body `account quota exhausted`。spec：`.trellis/spec/backend/quality-guidelines.md:223`、`:341`；`.trellis/spec/backend/logging-guidelines.md:158`。

"同账号重试"概念：只有两处——(a) `gatewayStep` 的同账号同 provider 一次重试；(b) 内层 provider 循环本身就在同一账号内换 provider。retryRules 只能"停止"，不能"要求重试"。

代理失败的分类：`terminalOrigin==='proxy'`（账号有 `proxyUrl` 且传输错误，`5466`、`5689`、`5703`、`5735`）→ `{scope:'account', evidence:'transport_proxy', failureClass:'network'}`（`5342`）→ 无显式规则时默认 **account degrade**（`5424`）。provider circuit 会忽略代理失败（`server.js:5162`）。

---

## 3. 会话粘性、缓存池、上游 prompt cache

### 3.1 身份与键

- `extractSessionIdentity(req, body)` `server.js:4074-4119`：codex/claude/generic 显式键（parent thread/session、`prompt_cache_key`、Session-Id、Thread-Id…）→ `hmacIdentity` → `{source, keyType, confidence:'explicit', fingerprint}`；否则 `message_hmac`（首个 system+user 内容 HMAC，`confidence:'fallback'`）；都没有则 `fingerprint:null`。
- `handleChat` `server.js:5847`：非 legacy 客户端 `identity.fingerprint = hmacHex('client-owner\0'+clientKeyId+'\0'+fingerprint)`（按下游密钥命名空间化）。
- `prepareChatAffinity` `server.js:4120-4136`：caller 自带 `prompt_cache_key`/`session_id` 原样透传；显式 codex/claude 身份派生 `prompt_cache_key = hmacHex('upstream-prompt-cache\0'+fingerprint)` 注入上游 body。

### 3.2 绑定与 HRW

| 位置 | 内容 |
|---|---|
| `server.js:1554-1560` | `sessionBindings` Map（进程内 LRU），`SESSION_PROVIDER_TTL_MS=3_600_000` |
| `server.js:1598-1623` | `findSessionBinding` / `createProvisionalSessionBinding`：entry `{accountId, source, expiresAt, lastUsedAt, state:'provisional'|'confirmed', generation, ownerRequestId}`，key = `identity.fingerprint` |
| `server.js:1627-1641` | `commitSessionBindingSelection`（真实 attempt 提交后确认）/ `cleanupSessionBindingSelection` |
| `server.js:1642-1651` | `invalidateSessionBindingsForAccount(accountId, {credentialsChanged})`：删除该账号的账号绑定；provider hint 只在 `credentialsChanged` 时删 |
| `server.js:1677-1709` | provider hint：key `provider\0${fingerprint}\0${slot}`（16 槽），entry `{kind:'provider', accountId, modelId, provider, sequence, expiresAt}`；`sessionProviderHint` 需 `config.sessionProviderAffinityEnabled && confidence==='explicit'` |
| `server.js:1821-1823` | `hrwRank(accounts, fingerprint)`：按 `hmacHex(fingerprint\0account.id)` 排序——**只以账号 id 为桶** |
| `server.js:1885-1897` | legacy sticky：HRW 首选 → 等待 → overflow |
| `server.js:1865-1877` | `selectionResult` 设定 `lease.quotaRole`（low/high/unknown，基于 cache pool 的 warm/hot/drain） |
| `server.js:1922-1931` | cachePool / sessionBinding 开关：`cachePoolEnabled = cachePoolSize>0 && (workflow.enabled || sticky)`；`sessionBindingConfigured` |
| `server.js:2186-2197` | `attachBindingHit` / `attachBindingMiss` |
| `server.js:5862-5874` | `affinityFacts(usage)`：`sessionSource, affinityKeyType, affinityConfidence, upstreamPromptCacheKeySource, upstreamPromptCacheKeyApplied, providerOrderOverridesSticky, cacheHit, input/output/cachedTokens, bindingSource, bindingResult`（+ workflow decisions） |

### 3.3 "账号 == 固定出口"的隐含假设（代码中出现的位置）

- 出口选择：`clineRequest` `server.js:4228` 默认用 `account.proxyUrl`。
- 代理 agent 缓存/回收：`server.js:4192-4193` `pruneProxyAgents` 只保留 `config.accounts[].proxyUrl`；`server.js:4229-4230` 不在任一账号 `proxyUrl` 中的代理 URL 被视为 disposable（每请求新建并销毁 agent），`MAX_CACHED_PROXY_AGENTS=128`（`4181`）。
- 账号身份比较把 `proxyUrl` 当作凭据的一部分：`rememberSessionProvider` `1699`、quotaSignal `5513`、quota job `4374`、`4438`、`4449`、`4462`（额度查询走账号 `proxyUrl`）。
- 配置变更：`server.js:2906-2908` `proxyUrl` 改变 ⇒ 清 quota 快照、provider circuit、`invalidateSessionBindingsForAccount(id,{credentialsChanged:true})`、accountStates（保留月封禁）、`clearRpmState`；`2906` 还清 provider probe cells。
- 代理健康统计：`server.js:3709-3727` 以 `proxyEndpointKey(byAccount.get(segment.accountId)?.proxyUrl)` 归因——按**账号当前配置的 proxyUrl**而不是 attempt 实际出口；`proxyHealthProjection` `3836-3870` 也按账号→proxy 反查 `accounts` 列表。
- 日志 `proxyError: !!acc.proxyUrl && trace.some(t => t.upstreamStatus === 0)`（`6052`、`6142`）；传输错误 `terminalOrigin` 用 `account.proxyUrl ? 'proxy' : 'network'`（`5466`、`5689`、`5703`、`5735`、`6029`）。
- 网关 backoff 键 = account.id（`5306`），注释明确"not per proxyUrl"；spec `quality-guidelines.md:223` 规定"other accounts are not paused, even on the same proxyUrl"。
- HRW、session binding、provider hint、cache pool 成员、quotaRole：全部只以 accountId 为单位，**不含任何出口维度**；它们本身不依赖出口，但出口变化（改 proxyUrl）会通过 `2908` 使绑定失效。

### 3.4 上游 prompt cache 与出口 IP

- 代码中唯一的上游缓存杠杆是 `prompt_cache_key`（`4120-4136`）和账号粘性（HRW/binding）。没有任何代码、spec、README 或归档任务把缓存命中与出口 IP 关联。
- 检索 `.trellis/spec/**`、`.trellis/tasks/archive/**`、`docs/`、`README.md` 中 "cache/缓存" 与 "IP/出口/egress/proxyUrl" 同现：无结果（仅有代理 agent "缓存" 的无关命中）。
- 归档 `.trellis/tasks/archive/2026-09/09-17-improve-cache-hit-scheduling/research/current-cache-baseline.md` 把命中率因素归为：显式会话键缺失（全部 `message_hmac`）、流水线候选集变化导致重映射、上游 provider 漂移（未证实）——未提及出口。
- `docs/upstream-ip-rate-limit-findings.md:132` 的 10k 输入实验"缓存命中 0%"是随机生成输入导致，并非出口对缓存的证据。
- 结论：**"上游 prompt cache 是否与出口 IP 相关"在本仓库内未知/未记录**。

### 3.5 "同会话固定同代理"的自然键

- 现有会话键：`identity.fingerprint`（已按 clientKeyId 命名空间化，`5847`），用于 `sessionBindings` 账号绑定（key=fingerprint）与 provider hint（key=`provider\0fingerprint\0slot`）。provider hint 已示范在同一 LRU 中用不冲突前缀的派生 key 存附加维度（`1674-1677` 注释）。
- `identity.fingerprint` 可为 null（无会话信息时 roundrobin），`confidence` 区分 explicit / fallback(`message_hmac`) / none；TTL 分别 2h / 15min（`config.accountPipeline.sessionBinding*TtlMs`，默认见 `server.js:90-92`）。
- 无会话时可用的稳定替代：`hrwRank` 模式（`hmacHex(fingerprint\0id)`）可直接套到代理 id 上。

---

## 4. maxRpm / maxConcurrent / 等待机制

### 4.1 RPM（滚动窗口 + 预留）

| 位置 | 内容 |
|---|---|
| `server.js:700-706` | 注释：每账号进程内精确滚动窗口（默认 60s）+ 未提交预留；重启清空；`rpmWindows = new Map()` |
| `server.js:708-718` | `rpmLimit` / `normalizeMaxRpm`（0=不限，上限 100000） |
| `server.js:719-735` | `rpmWindowState`（`{timestamps:[], head, reservations}`）、`rpmLiveCount = timestamps.length-head+reservations`、`pruneRpmWindow`（head 指针 + 半数压缩，空状态自删） |
| `server.js:736-747` | `rpmBlockedRetryAt`：满时 `retryAt = oldest + RPM_WINDOW_MS` |
| `server.js:748` | `clearRpmState(accountId)` = `rpmWindows.delete` |
| `server.js:750-769` | `reserveRpmPermit`：`reservations++`，超限则回滚并返回 `{ok:false, retryAt}`；permit `{commit(): push(Date.now()), release(): notifyCapacityWaiters()}` |
| `server.js:4262-4264` | `req.end()` 之后 `permit.commit()`；`fail()` 中 `permit.release()`（`4213`）——"交给 transport 才计数" |
| `server.js:2930-2931` | 配置保存时清理 maxRpm=0 / 已删账号的窗口 |
| `server.js:5646-5652` | 每个真实 attempt `lease.takeRpmPermit()`；失败即 `localRpm`，不等待、不换号 |

### 4.2 并发（lease）

| 位置 | 内容 |
|---|---|
| `server.js:1759-1762` | `accountHasCapacity`：`activeCounts.get(id) < effectiveMaxConcurrent`（drain 档可压低，`1949-1954`） |
| `server.js:1764-1782` | `createLease(account, firstPermit)`：`takeRpmPermit()`、`release()`（`activeCounts--` + `notifyCapacityWaiters()`） |
| `server.js:1784-1792` | `tryLeaseResult`：硬资格 → 并发 → RPM（并发失败不消耗 RPM），成功 `activeCounts++` |
| `server.js:770-783` | `selectionBlockFacts` → `blockedBy ∈ {concurrency, rpm, mixed, unavailable}` + 最早 `retryAt` |

### 4.3 等待 / 排队

| 位置 | 内容 |
|---|---|
| `server.js:72-73` | `concurrencyWaitMs: 2000`，`poolFullWaitMs: null`（继承前者，0..30000） |
| `server.js:802-813` | `admissionWaitBudgets()`、`poolWaitBudget`（仅"全部候选有限并发满且 RPM 有余"用 pool 预算）、`poolWaitForBlock` |
| `server.js:796-801` | `waitDurationForBlock(deadline, facts)`：等待 = min(剩余预算, retryAt-now) |
| `server.js:1553`、`1561` | 全局 `waiters` Set + `notifyCapacityWaiters()`（广播唤醒） |
| `server.js:1794-1802` | `waitForCapacity(ms)`：`Promise.race([timeout, capacity])`，无 FIFO 队列，被唤醒后重新竞争 |
| `server.js:1804-1819` | `waitForLease(...)`：循环 tryLease → 计算等待 → `waitForCapacity` |
| `server.js:1906-1920`、`2540-2564` | legacy / workflow 选号中的同样循环 |
| README `:325` | "等待复用现有容量 waiter 与 `concurrencyWaitMs` 上限，不新增 refill 定时器或队列" |

要点：等待只发生在**选号准入阶段**（`acquireAccountLease`），`runChatChain` 内部唯一的等待是 `gatewayWaitMs`（`5629-5633`，`setTimeout`，客户端断开后检查 `clientClosed`）。

---

## 5. 请求日志与 META

### 5.1 `traceAttempt` 形状（`server.js:5526-5547`）

`{ upstream, healthProvider, actualProvider, status, upstreamStatus, normalizedStatus, providerSelection, [attemptIndex, callId], [detailProfile], terminalOrigin, ms, note, reasonTruncated, account, accountId, action, ruleId, ruleScope, ruleAction, matchedBy, providerCircuitAction, errorScope, scopeEvidence, failureClass, healthAction, quotaRemovalAction, retryAfterMs, retryRuleId, retryDecision, retryMatchedBy, responseContentType, responseBytes }`

无任何出口/代理字段。

### 5.2 `recordChat` → `record()`

- `recordChat = (info) => record(modelId, {inboundProtocol, ...info}, detail)`（`server.js:5841`）。
- 调用点：容量阻塞 `5890`；流式 finalize `6052`；非流式无 out `6129`；非流式常规 `6138-6143`。
- 传入字段（`6138-6143`）：`requestId, requestedModel, resolvedModel, provider, canonical, ms, stream, result, attempts, trace, error, account, accountId, accountPath, accountActions, accountAction, upstreamStatus, normalizedStatus, ...affinityFacts, strategy, preferredAccountId/Name, selectionReason, overflow, pipeline, targets, providerPlanSource, providerMode, appliedHeaderNames, proxyError, errorCategory, blockedBy, retryAfter, sensitiveValues`。
- `record()` `server.js:3893-3997`：
  - `recentHistory`（内存 100 条，legacy 形状，`3901-3909`）。
  - 请求行 `request`（`3910-3965`）：**白名单投影**；`attempts` 由 trace 逐字段白名单映射（`3943-3957`），未列出的 trace 字段不会进入 JSONL；`errorCategory` 由 `info.proxyError` 推导 `'proxy'|'upstream'`（`3963`）。
  - 错误行（`3968-3993`）：每个非成功或带 action 的 attempt 一条，`category: upstreamStatus===0 ? (info.proxyError?'proxy':'network') : 'upstream'`（`3981`）——请求级 `proxyError` 布尔决定全部 attempt 的 category。
  - 末尾 `saveMeta()`（`3995`）。
- 新增 per-attempt 字段需要同时改：`traceAttempt`（5526）、`record()` 请求行 attempts 映射（3943）、错误行（3975）；legacy history（3904）会自动带上（只剔除 attemptIndex/callId/detailProfile/reasonTruncated）。
- 脱敏边界：README `:347` "不保存…代理 URL/认证值"；`proxyEndpointKey`（`server.js:975-984`）已存在，产出无凭据的 `scheme://host[:port]`，当前用于统计与 `/api/statistics` 的 `proxyHealth.id`（`6456`）。详细日志 redactor 学习 `proxyUrl || account.proxyUrl`（`lib/detailed-log-capture.js:492`）；`sensitiveValues` 种子含账号 proxyUrl 及其用户名/密码（`server.js:271-272`、`5203-5204`、`5214`、`6216`）——都以账号 `proxyUrl` 为来源。

### 5.3 META 持久化

- `META_PATH = DATA_DIR/metadata.json`（`server.js:30`），`META = loadJson(...)`（`200`），`saveMeta()`（`217-223`，`atomicWriteJson`，同时 flush selectionCounters）。
- `META.accountStates[id]`（规范化 `server.js:319-362`）：`banned, hardQuarantined, cooldownUntil, statusCode, reason, ruleId, updatedAt, quotaDisposition, quotaDispositionAt, quotaRetryAt, quotaReason, protectionMonthlyAt, protectionShortAt, protectionShortWindows, protectionRetryAt`——严格字段校验，未知 quota*/protection* 前缀字段会抛错。
- `META.models[m].upstreamStatus[provider]`：provider-model 冷却/封禁（`5440`）。
- `META.statistics`：版本化分钟桶，`bucket.proxyHealth[proxyEndpointKey] = {requests, errors5xx, overflowFields}`（`967`、`974`、`3709-3727`），上限 `MAX_PROXY_HEALTH_MINUTE_CELLS=50000`（`1058`），校验在 `1012-1013`、`1139-1140`、`1176-1185`；投影 `proxyHealthProjection`（`3836-3870`）。代理健康只统计 requests 与 5xx，**不含 429/HTML 429、传输失败或延迟**。
- 进程内（不持久化）：`gatewayThrottles`（5300）、`rpmWindows`（706）、`activeCounts`、`sessionBindings`（1554）、`providerCircuitStates`、`proxyAgents`（4180）。

---

## 相关 Spec / 文档

- `.trellis/spec/backend/quality-guidelines.md:223` — HTML 429 合约（scope=gateway、绕过 errorRules、按账号 1s→8s backoff、只同 provider 重试一次、不换号）；`:341` 表格行；`:379` 例子。
- `.trellis/spec/backend/logging-guidelines.md:158` — HTML 429 日志字段合约（per account id, not per proxyUrl）。
- `.trellis/spec/backend/database-guidelines.md:406` — maxRpm 校验/持久化与"窗口状态不进 metadata"。
- `README.md:317`（规则/首包前最多换号一次）、`:325`（RPM/并发/等待）、`:327`（session binding 失效条件含"Key/代理变化"）、`:345`（代理不回退直连）、`:347`（日志不保存代理 URL）。
- 测试：`test/workflow-integration.test.js:357-389`（同账号同 provider 一次重试、≥900ms）及其后"per account, does not pause sibling accounts"；`test/proxy-health-stats.test.js`；`test/proxy-inflight-timeout.test.js`。

## Caveats / Not Found

- `docs/upstream-ip-rate-limit-findings.md` 中"约 140ms 后立即重试"与代码 ≥1s backoff 不符（见 §1.3）；未在生产日志中核对。
- 未找到任何把上游 prompt cache 命中与出口 IP 关联的记录。
- 未逐行审阅 `acquirePipelineAccountLease`（`2337`）与 `acquireStatefulBindingAccountLease`（`2198`）全部分支；它们同样只以 accountId 为单位。

---

## Implications for proxy pool design（基于上述事实的约束清单）

1. **出口当前是 account 的隐式属性**：要做 attempt 级出口选择，需要让 `attemptOnce`（5446）和流式 `clineRequest` 调用（5663）显式传 `proxyUrl`；`clineRequest` 已支持该参数。
2. **HTML 429 重试点已存在**：`gatewayStep`（5619）+ `index--` 不占 provider 预算、不触发外层换号；换出口重试可在此处实现而不改变"首包前最多换号一次"（5899/5921）与 provider retry 语义。但需注意循环顶部 `gatewayWaitMs(account)`（5629）以 account.id 为键，会让换出口的重试仍然等待账号窗口；以及 spec `quality-guidelines.md:223`/`logging-guidelines.md:158`、测试 `workflow-integration.test.js:357-389` 都把"同 provider、同账号、per-account backoff"写成合约，改动需同步更新 spec 与测试。
3. **代理 agent 生命周期绑定 `config.accounts[].proxyUrl`**（4192、4229）：池中代理若不出现在某个账号的 `proxyUrl` 上，会被当作 disposable，每请求新建/销毁 agent（失去 keep-alive）；`MAX_CACHED_PROXY_AGENTS=128`。
4. **代理凭据脱敏种子来自账号 `proxyUrl`**（271、5203、5214、6216、`lib/detailed-log-capture.js:492`）：池中代理 URL 需同样进入这些 sensitive 集合。
5. **代理失败目前降级账号**（`transport_proxy` → account degrade，5342/5424）且 `proxyError`/`terminalOrigin` 用 `account.proxyUrl` 判断（5466、6052、6142、3981）；按代理池化后这些归因需要看 attempt 实际出口。
6. **代理健康统计按账号配置的 proxyUrl 归因**（3713），且只有 requests/5xx；per-attempt 出口与 HTML 429 次数目前没有落点。`proxyEndpointKey`（976）可作为已存在的无凭据代理 id。
7. **限速可复用 RPM 模式**：`rpmWindows` 的 `{timestamps, head, reservations}` + reserve/commit/release（`req.end()` 后 commit）+ `notifyCapacityWaiters` 唤醒，可原样按代理 key 建一份；进程内、重启清空、不进 metadata（与 database spec `:406` 一致）。
8. **排队只有准入阶段的全局 waiter**（`waitForCapacity`，1794；预算 `concurrencyWaitMs`/`poolFullWaitMs` ≤30s）；`runChatChain` 内只有 `setTimeout` 式 backoff 等待（5631）。"所有代理都被限时短暂排队"可以复用 `waitForCapacity` 的 race 结构，但注意它是广播唤醒、无 FIFO。
9. **会话→代理固定**的自然键是 `identity.fingerprint`（已按 clientKeyId 命名空间化），可参照 provider hint 的派生 key 前缀（1677）存于同一 `sessionBindings` LRU，或直接用 `hmacHex(fingerprint\0proxyId)` 做 HRW（1821）。fingerprint 可能为 null，`confidence` 可为 fallback。
10. **改 `proxyUrl` 会清空账号的 quota 快照、circuit、session 绑定、accountStates、RPM 窗口**（2906-2908）；若引入"账号引用代理池"，池成员变化是否应触发同样的失效需要单独定义。额度查询（4462）与 proxy-test（6406-6423）也走账号 `proxyUrl`。
11. **日志新增字段需三处同步**：`traceAttempt`（5526）、`record()` 请求行 attempts 白名单（3943-3957）、错误行（3975-3992）；README `:347` 明确不得记录代理 URL/认证值。
12. **prompt cache 与出口的关系未知**：仓库内无证据表明换出口影响缓存命中；粘性与缓存逻辑全部以 accountId + `prompt_cache_key` 为单位。
