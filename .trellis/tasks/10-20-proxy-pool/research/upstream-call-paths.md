# Research: 上游调用路径与代理出口选择（动态代理池前置调研）

- **Query**: 枚举所有上游 HTTP 调用路径及其出口（proxy）选择方式；剖析 clineRequest；proxyEndpointKey 统计；所有从 `account.proxyUrl` 推导 transport origin 的位置；proxyUrl 参与身份/陈旧校验与脱敏种子的位置；"代理失败不回退直连"的现有约束。
- **Scope**: internal（`server.js` 6885 行，`lib/detailed-log-capture.js`，测试与 spec）
- **Date**: 2026-10-20
- 行号均基于当前工作区 `server.js`（HEAD b336318 + 未提交改动无涉 server.js）。

---

## 1. 所有上游 HTTP 调用路径

### 1.1 传输层原语（只有三种）

| 原语 | 位置 | 出口 |
|---|---|---|
| `clineRequest()` | server.js:4198-4275 | Node `http/https.request` + 自管 agent；`proxyUrl \|\| account?.proxyUrl` 决定代理（4228） |
| `clineRequestJSON()` | server.js:4195-4197 | 包装 `clineRequest` + `streamToString` |
| `fetchJSON()` | server.js:3025-3041 | **全局 `fetch`（undici）直连**，无代理、无 agent；`account` 参数仅用于 detail-log `root.attempt`（3027） |
| 裸 `fetch()` | server.js:3468 | 全局 `fetch` 直连 docs.cline.bot |

另有 `accountFetchJSON()`（server.js:3012-3024）：给 header 叠加 `responseHeadersFor(account, …)`（3013），然后调用 `clineRequestJSON(url, { …, account, … })`（3017）——**不传 `proxyUrl`**，因此代理完全依赖 `clineRequest` 内 4228 的 `account?.proxyUrl` 回退。

全仓库 `grep fetch(|http.request|https.request`：server.js 仅 3031、3468 两处 `fetch`，`lib/*.js` 无任何出网调用（adapter 只做协议转换）。

### 1.2 调用点清单

| # | 路径 / 功能 | 函数 & 行号 | 原语 | proxy 传递方式 |
|---|---|---|---|---|
| A | 主聊天 **流式** attempt（`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 共用） | `runChatChain()` 5583；调用 5663 | `clineRequest` | **隐式**：只传 `account`，靠 4228 回退 `account.proxyUrl` |
| B | 主聊天 **非流式** attempt | `runChatChain()` 5752 → `attemptOnce()` 5446，调用 5449 | `clineRequestJSON` | **隐式**：`account`（5450） |
| C | Responses / Anthropic 入站 | 路由 6805/6806 → `handleChat(req,res,id,adapter)` 5800 → `runChatChain` 5908 | 同 A/B | 同 A/B（adapter 不发请求） |
| D | 管理 `/api/test` | 6331 → `runChatChain(..., stream:false)` | 同 B | 隐式 |
| E | 额度刷新 `GET /users/me/plan/usage-limits` | `runQuotaJob()` 4456；调用 4462 | `clineRequestJSON` | **显式** `proxyUrl: job.proxyUrl`（job 创建时快照 `account.proxyUrl \|\| ''`，4449），同时传 `account` |
| F | 周期渠道探测（provider probe schedule） | `runScheduledProbe()` 4680；调用 4701；由 `scheduleQuotaRefresh()` 4789 的定时器在 4816-4818 触发 `runScheduledProbeRound()` 4737 | `accountFetchJSON` → `clineRequestJSON` | 隐式（`account`） |
| G | `/api/probe` | 6302 → `probeModel()` 3283，调用 3288 | `accountFetchJSON` | 隐式 |
| G2 | probe 内负对照 pin 测试 | `harvestAvailableProviders()` 3242，调用 3258 | `accountFetchJSON` | 隐式 |
| G3 | probe 内 OpenRouter 端点 | `probeModel` 3306 → `orEndpoints()` 3057 → `orModelList()` 3044；`fetchJSON(OR_API/...)` 3046/3062 | **全局 fetch 直连** | 无代理（不带账号凭据） |
| H | `/api/validate-upstreams` | 6742 → `validateUpstreams()` 3396，调用 3414 | `accountFetchJSON` | 隐式 |
| I | `/api/accounts/test` | 6603-6624；调用 6621 | `accountFetchJSON` | 隐式，但 `account` 是临时对象 `{...saved, key:k, proxyUrl}`（6611），`proxyUrl` 可被请求体覆盖（6608-6609） |
| J | `/api/accounts/proxy-test` | 6402-6425；调用 6418 | `clineRequestJSON` | **显式** `proxyUrl` + `ephemeralProxy: true`（body 可覆盖，6407） |
| K | 模型目录 `GET {upstreamBase}/models`（`/api/models` 6282、`/v1/models` 等 6800 当 `exposeCatalog`） | `catalog()` 6174；调用 6181 | **`fetchJSON` = 全局 fetch 直连** | **绕过账号代理**：带 `Authorization: Bearer account.key`（`chatHeaders(account.key)`），但出口是本机直连 |
| L | 官方模型枚举 `/api/fetch-official-models` | `fetchOfficialModels()` 3439：`fetchJSON(api.cline.bot/.../recommended-models)` 3450、`fetchJSON(models.dev)` 3459、`fetch(docs.cline.bot)` 3468 | 全局 fetch 直连 | 无代理、无账号凭据 |

**绕过 `clineRequest` 的路径**：K（带账号 key 的 api.cline.bot/models，直连）、L（3 个公共源，直连）、G3（OpenRouter，直连）。其中只有 K 携带账号凭据并打到 `config.upstreamBase`。

spec 约束：`.trellis/spec/guides/code-reuse-thinking-guide.md:48`："Do not add a second direct `fetch()` path for chat, quota, probe, or account-test work that must honor an account proxy."

---

## 2. `clineRequest` / `clineRequestJSON` 详解（server.js:4160-4294）

### 2.1 Agent 配置与缓存
- 直连 agent：`directHttpAgent` / `directHttpsAgent`（4178-4179），`directAgentOptions`（4168）含 keepAlive、`maxSockets=CLINE_PASS_DIRECT_MAX_SOCKETS`（默认 512）、`timeout: 60_000`。
- 代理 agent 选项 `proxyAgentOptions`（4172）：keepAlive、`maxSockets=CLINE_PASS_PROXY_MAX_SOCKETS`（默认 32，4167）、`maxFreeSockets` 默认 2；**刻意不设 `timeout`**（注释 4169-4171：SocksProxyAgent/HttpsProxyAgent 会把它作用到隧道内 raw socket，约 60s 触发 socket hang up）。有测试 `test/proxy-inflight-timeout.test.js:96` 守护。
- `proxyAgents = new Map()`（4180），key 是**完整 proxyUrl 字符串（含凭据）**；`MAX_CACHED_PROXY_AGENTS = 128`（4181）。
- `proxyAgentFor(proxyUrl, {ephemeral})`（4182-4190）：非 ephemeral 命中缓存直接返回；按协议 `socks5:`/`socks5h:` → `SocksProxyAgent`，否则 `HttpsProxyAgent`（http/https 代理都走它）；非 ephemeral 才写入缓存。
- `pruneProxyAgents()`（4191-4194）：保留集合 = `config.accounts[].proxyUrl`；不在其中的缓存 agent `destroy()` 并删除。唯一调用点：`applyAccountConfig()` 末尾 2935。关停时 `destroyRuntimeConnections()` 6836-6842 销毁全部。

### 2.2 有效代理决定与 disposable 逻辑（4228-4231）
```js
const effectiveProxy = proxyUrl || account?.proxyUrl || '';
disposableAgent = !!effectiveProxy && (ephemeralProxy || !config.accounts.some((a) => a.proxyUrl === effectiveProxy) ||
  (!proxyAgents.has(effectiveProxy) && proxyAgents.size >= MAX_CACHED_PROXY_AGENTS));
agent = effectiveProxy ? proxyAgentFor(effectiveProxy, { ephemeral: disposableAgent }) : u.protocol === 'https:' ? directHttpsAgent : directHttpAgent;
```
- 一次性 agent 的三种情况：调用方 `ephemeralProxy:true`（仅 J）；代理 URL 不属于任何已保存账号（如 I 的草稿 proxy）；缓存已满且未命中。
- `dispose()`（4207）只在 `disposableAgent` 时 destroy；触发点：`res 'end'`/`'close'`（4235-4236）、`fail()`（4211）。
- 注意：缓存是否保留由 "是否等于某个 `config.accounts[].proxyUrl`" 判定——池化代理若不在 accounts 中，按现逻辑每次都会走一次性 agent。

### 2.3 超时
- `req.setTimeout(timeoutMs, onRequestTimeout)`（4253-4254），超时构造 `new Error('upstream timeout')` 并 destroy req/response。
- `applyNestedSocketTimeouts()`（4173-4177）沿 `_parent`/`socket` 链把超时设到嵌套 socket（隧道内外层），在 `'socket'` 事件和已有 socket 上都应用（4255-4256）。
- 返回对象的 `setIdleTimeout(ms)`（4240-4248）：流式首事件后由调用方切换为 `SSE_STREAM_IDLE_MS`（5744 `up.setIdleTimeout(SSE_STREAM_IDLE_MS)`）。
- 调用方另有外层 `AbortController` 定时器（runChatChain 5657：`SSE_FIRST_EVENT_MS` 或 `attemptTimeoutMs`；quota 4459 `QUOTA_TIMEOUT_MS`）。

### 2.4 错误分类
`clineRequest` **本身不做 proxy/network/timeout 分类**——只 reject 原始 Error（附 `attemptToken`、`detailAttempt`，4216-4217）。分类全部在调用方用正则 `/timeout/i` + `account.proxyUrl` 推导（见第 4 节）。

### 2.5 permit / attemptOwner / attemptMeta / detail-log
- `permit`：同步失败（URL/agent 构造、`req.end` 前）`fail()` 中 `permit?.release()`（4213）；`req.end()` 之后立即 `permit?.commit()`（4262-4264），此后任何 DNS/connect/proxy/TLS 失败都不退还 RPM（spec error-handling.md "An RPM permit is committed exactly when the native transport reaches `req.end()`"）。
- `nativeChat` = `POST` 且 url 恰为 `${config.upstreamBase}/chat/completions`（4200）。仅 nativeChat 时：
  - `attemptOwner` 分配 `attemptToken = { attemptIndex: attemptOwner.nextAttemptIndex++, callId: randomUUID() }`（4266），调用 `attemptOwner.onAttemptCommit?.()`（4267；F 用它判断 `committed`）。
  - detail-log hook（4269）：`root?.attempt({ token, url, method, headers: req.getHeaders(), body, account, proxyUrl, model: attemptMeta?.model, provider: attemptMeta?.provider ?? null })`。**这里传的是参数 `proxyUrl`（调用方显式值，隐式路径为 `''`），不是 `effectiveProxy`**；`lib/detailed-log-capture.js:492` 内部再做 `proxyUrl || account?.proxyUrl` 回退以学习脱敏值。
- resolve 值（4239-4249）：`{ status, headers, body, attemptToken, detailAttempt, setIdleTimeout }`——**不含所用代理信息**。`clineRequestJSON` 在其上加 `text`（4196）。

---

## 3. `proxyEndpointKey` 与代理健康统计

### 3.1 定义（server.js:975-984）
`proxyEndpointKey(proxyUrl)` → `scheme://host[:port]`，剥离用户名/密码；仅接受 http/https/socks5/socks5h，拒绝 path/query/hash/空 host/超长 host，失败返回 `null`。注释："Credential-free proxy endpoint id for statistics"。

### 3.2 统计内容
- 单元格结构 `emptyProxyHealth()` = `{ requests, errors5xx, overflowFields }`（974）；`proxyHealthCell()` 3543。
- 写入：`commitStatistics()`（3656 起）中 3709-3726：
  - 注释 3709："Proxy 5xx rate ignores error-rule healthAction: any attempt status 500–599 counts."
  - 对每个 segment（按 accountId 去重，一账号一次）用 **commit 时刻 `config.accounts` 中该账号的当前 `proxyUrl`**（`byAccount` 3711，key 3713）——不是 attempt 实际使用的代理。
  - `requests += 1`；若 segment.trace 内任一 attempt `status` 为 5xx（`attemptStatusIs5xx` 985-988）则 `errors5xx += 1`。
  - 容量：`MAX_PROXY_HEALTH_MINUTE_CELLS`（1058，默认 50000）；超限计 `droppedProxyHealthMinuteCells`、`proxyHealthIncompleteAt[key]`（3716-3721）；裁剪 3624-3630。
- 持久化校验：1139-1140、1176-1178、1185（id 必须等于 `proxyEndpointKey(id)`，即持久化中只允许无凭据形式）；迁移 1232-1233。
- 分钟桶存于 `META.statistics.minuteBuckets[].proxyHealth`（3660）。

### 3.3 API 暴露
- `proxyHealthProjection()`（3836-3875）：聚合最近 1440 分钟，`accountsByProxy` 同样用 `proxyEndpointKey(account.proxyUrl)`（3850）把账号挂到代理行；输出 `{ coverage:{complete,from}, proxies:[{id, requests, errors5xx, errorRate, accounts:[{id,name}]}] }`。
- 通过 `GET /api/statistics` 字段 `proxyHealth: proxyHealthProjection(generatedAt)`（6456）暴露；前端 `public/index.html:1882-1883` `renderStatisticsProxyHealth`。
- 脱敏：靠 key 本身无凭据（只有 scheme/host/port）；校验保证落盘 id 规范化。

### 3.4 测试
`test/proxy-health-stats.test.js:74`（代理账号 5xx 计入，即使 errorRule ignore；`row.accounts` = `['proxied']`）、`:114`（直连账号不出现在 proxyHealth）。

---

## 4. 从 `account.proxyUrl` 推导 transport origin / 错误类别的位置

| 行 | 上下文 | 表达式要点 |
|---|---|---|
| 3416 | `validateUpstreams` catch | `accountFault: acc.proxyUrl ? 'proxy' : 'network'` |
| 4305 | `quotaFailureCategory()`（runQuotaJob 4472 catch 使用） | `account.proxyUrl ? 'proxy' : 'network'` |
| 5162 | `providerCircuitFailure()` | `outcome.terminalOrigin === 'proxy' \|\| (account?.proxyUrl && outcome?.upstreamStatus === 0)` → 不计 provider 熔断 |
| 5466 | `attemptOnce()` catch | `terminalOrigin = timeout / account?.proxyUrl ? 'proxy' : 'network'` |
| 5689 | 流式首事件读取失败 | `transportOrigin = ... account.proxyUrl ? 'proxy' : 'network'` |
| 5703 | 流式非 SSE 正文读取失败 | 同上 |
| 5735 | 流式 `!up`（请求根本失败） | 同上 |
| 6029 | 流式已开始后传输错误（handleChat 流转发 finalize 段） | `terminalOrigin: ... acc.proxyUrl ? 'proxy' : 'network'` |
| 6052 | 流式 `recordChat(...)` | `proxyError: !!acc.proxyUrl && chain.trace.some(t => t.upstreamStatus === 0)` |
| 6142 | 非流式/终态 `recordChat(...)` | `proxyError: !!acc?.proxyUrl && ...`；同时 `errorCategory` |
| 6423 | proxy-test catch | 固定 `errorCategory: 'proxy'` |
| 6624 | accounts/test catch | `errorCategory: proxyUrl ? 'proxy' : 'network'`（本地变量 proxyUrl） |

下游消费者（读取已推导结果）：
- `classifyAttemptFailure()` 5342：`origin === 'proxy'` → `{scope:'account', evidence:'transport_proxy', failureClass:'network'}`；`matchErrorRule` 默认 5424 → account `degrade`（不换号，仅 cooldown/hard-quarantine 才换号，handleChat 5921）。
- `classifyHealth()` 3558：`proxy/network/timeout/upstreamStatus===0` → `networkProxy` penalty 6。
- `record()` 3893 起：3963 `errorCategory: info.proxyError ? 'proxy' : 'upstream'`；3981 error log `category: attempt.upstreamStatus === 0 ? (info.proxyError ? 'proxy' : 'network') : 'upstream'`（是请求级 `proxyError`，不是 attempt 级）。
- `traceAttempt()` 5531-5546 记录 `terminalOrigin`，但**不记录代理标识**。
- 持久化枚举 1289：`accountQuotas[].errorCategory` 允许 `'proxy'`。

---

## 5. proxyUrl 参与身份/陈旧校验与脱敏种子

### 5.1 身份/陈旧校验
| 行 | 函数 | 守护内容 |
|---|---|---|
| 1324-1327 | `probeIdentityDigest()` | 账号 `proxyUrl` 进入 HMAC 身份摘要；代理变更 → probe 证据表身份变化 |
| 1699 | `rememberSessionProvider()` | 写会话 provider 亲和前确认账号 key+proxyUrl 仍与 config 一致，防止旧凭据/旧出口的结果写入 |
| 2906 | `applyAccountConfig()` | key/proxyUrl/clientKeyId/enabled/headers 变化 → 删除该账号所有 `META.providerProbe.cells` |
| 2908 | `applyAccountConfig()` | key 或 proxyUrl 变化 → `invalidateQuotaAccount(clearSnapshot)`、清 provider 熔断、失效会话绑定（credentialsChanged）、重置 `accountStates`（保留 `protectionMonthlyAt`）、`clearRpmState` |
| 4374 | `quotaJobAccount()` | quota job 结果仅当账号当前 `proxyUrl` 仍等于 job 快照时生效 |
| 4438 | `requestQuota()` | 已有 job 的 key/proxyUrl 与当前不一致 → 等其结束再新建，不复用 |
| 4449 | `requestQuota()` | job 快照 `proxyUrl: account.proxyUrl \|\| ''`（E 显式传入） |
| 5513 | `settleAttempt()` quotaSignal | 结构化账号额度 429 只在账号 key+proxyUrl 未变时触发 `signalQuotaProtection` |
| 4192 | `pruneProxyAgents()` | 代理 agent 缓存保留集合 |
| 4229 | `clineRequest` | 是否缓存 agent |

### 5.2 脱敏种子
| 位置 | 用途 | 种子 |
|---|---|---|
| server.js:269-276 `boundedProviderNote()` | provider 健康 note | 账号 key、`proxyUrl`、URL 解码后 username/password、headers 值；再正则 `(https?\|socks5h?)://…` → `[REDACTED_PROXY]` |
| server.js:5201-5210 `redactSecrets()`（`safeReason` 1711 调用） | 通用原因脱敏 | 同上 + 同样正则 |
| server.js:5213-5219 `ordinaryFailureReason()` | DetailRedactor 种子 | `account.proxyUrl` 整串（不拆用户名/密码，依赖 DetailRedactor.url） |
| server.js:6216 | 每请求 `DetailRoot` secrets | `account.proxyUrl` 整串 |
| server.js:6422 | proxy-test 错误 | 对 body 提供的 proxyUrl 及其 user/pass 现场替换 |
| lib/detailed-log-capture.js:72-88 `DetailRedactor.url()` | 学习 URL 中 username/password 并替换；畸形 URL 提取 `user:pass@` | — |
| lib/detailed-log-capture.js:135-138 | 文本扫描时把 `https?/socks5h?://` URL token 交给 `url()` | — |
| lib/detailed-log-capture.js:487-492 `DetailRoot.attempt()` | `this.redactor.url(proxyUrl \|\| account?.proxyUrl \|\| '')` 学习当次代理凭据 | — |

要点：所有种子来源均是 `config.accounts[].proxyUrl` 或调用方显式 proxyUrl；池中代理若不在 accounts 中，不会自动进入这些种子列表（正则兜底 `[REDACTED_PROXY]` 仍覆盖 redactSecrets/boundedProviderNote 路径）。

---

## 6. "代理失败不回退直连" 的现有约束

- 代码层：`clineRequest` 中 `effectiveProxy` 非空即只用代理 agent（4231），失败直接 `fail()` reject（4209-4219），无任何 direct 重试分支；调用方把失败归类为 `'proxy'`。
- spec：`.trellis/spec/backend/error-handling.md:59` "A configured proxy failure never falls back to direct transport. Draft `/api/accounts/proxy-test` agents are disposable ... Neither case converts the attempt into a direct request."
- 测试：`test/integration.test.js:1222` "account HTTP proxy is used for chat and quota, and proxy failure never falls back to direct"——断言 `chatHits` 不增加（1236），error log `category==='proxy'` 且不含 `password`（1238），账号健康记一次 degrade（1239）。同测试 1231 断言 quota 与 chat 复用同一 CONNECT 隧道（`connects === 1`）。
- README:14、README:345 也声明"故障绝不回退直连"。
- 行为补充：proxy 失败后 runChatChain 不 break（仅 account cooldown/hard-quarantine/quota 移除或非流式 timeout 才 break，5731/5741/5765-5766），会以**同账号同代理**继续下一个 provider attempt；HTML-429 网关退避 `noteGatewayThrottle` 按 **account id** 而非代理键（5297-5313，注释明确"not per proxyUrl"），`gatewayStep` 最多重试 1 次（`GATEWAY_THROTTLE_RETRIES`，5299，5619-5625），重试仍用同账号同代理。

---

## Caveats / Not Found

- 未发现任何 `undici` 显式 import；`fetchJSON` 用 Node 全局 `fetch`，无 dispatcher 配置，因此 K/L/G3 无法走代理。
- 未发现 `/api/subscription` 等其他自行出网的管理端点；6282 处 `/api/models` 只走 `catalog()`（K）。
- 未在 `clineRequest` 外发现其他构造 `SocksProxyAgent/HttpsProxyAgent` 的位置。
- proxyHealth 统计是按 segment（账号）而非 attempt 计数，且使用 commit 时的账号当前 proxyUrl。

---

## 插入点建议（Insertion point recommendation）

1. **单一解析点**：`clineRequest()` 中 server.js:4228 `const effectiveProxy = proxyUrl || account?.proxyUrl || '';`。除 K/L/G3 外所有带账号的上游调用（A–J）都经过这一行；A/B/F/G/G2/H/I 都是靠这里的 `account?.proxyUrl` 回退拿到代理，E 与 J 显式传入。在此处把"账号固定代理"替换为"池选择结果"即可覆盖全部 clineRequest 路径；J（proxy-test，`ephemeralProxy`）与 I（草稿 proxyUrl）需保持显式值优先。
2. **回传所用代理**：在 resolve 对象（4239，`{status, headers, body, attemptToken, detailAttempt, setIdleTimeout}`）与 reject 的 Error（4216-4217 已附 `attemptToken`/`detailAttempt`）上同样附带 attempt 级的代理标识（例如 `proxyKey = proxyEndpointKey(effectiveProxy)` / `null` 表示直连）。`clineRequestJSON` 用 `...res` 展开（4196）会自动透传；第 4 节各处 `account.proxyUrl ? 'proxy' : 'network'` 可改读该字段；`traceAttempt()`（5531）可记录它，从而让 `commitStatistics` 3713 与 `record` 3963/3981 基于实际出口。
3. **detail-log hook**：4269 当前传参数 `proxyUrl`（隐式路径为空），应改传实际 `effectiveProxy`，以便 `DetailRedactor.url()` 学习池代理凭据；同时 6216/5214/5203/271 的种子列表需包含池中所有代理 URL。
4. **agent 缓存**：4229 的 "是否属于 `config.accounts[].proxyUrl`" 判定与 4192 `pruneProxyAgents` 保留集合需纳入池代理，否则池代理每次都是一次性 agent。
5. **绕过路径**：K（`catalog()` 6181，带账号 key 直连 `/models`）是唯一携带账号凭据却不走 `clineRequest` 的上游调用，若池要覆盖所有 api.cline.bot 出口，需单独处理。
