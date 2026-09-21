# 技术可行性与风险复核

## 结论

总体方案可行，现有 owner 也基本选对：chat transport/lease/quota/metadata 继续在 `server.js`，ordinary logs 继续由 `JsonlLogGroup` 管理，敏感错误正文继续进入 `DetailedLogStore`。但当前规划有若干处把“可实现”写成了“现有机制可直接复用”，实际还缺少关键 seam；其中 7 项应在实现前修订为明确合同，否则容易出现错误关联、RPM 误计数、额度状态不恢复、SSE 背压误判或退出时丢日志。

高优先级调整：

1. error detail 缺失时，现有数据模型无法逐条区分“已过期/已清空”和“publication 失败”；必须降低承诺，或改变 error-row 写入时序/增加可持久化结果事实。
2. `attemptIndex/callId` 必须由 request-local native-chat-attempt owner 分配，不能由 `DetailRoot` 单独分配；否则 full/off/error-only 三种模式及账号替换无法保持同一关联合同。
3. RPM `commit` 应定义为“已把请求交给 Node transport（`req.end()` 调用）”，不是创建 `ClientRequest` 前；并且 `/api/accounts/test`、proxy test、probe/validate 等调用不都持有 chat lease，不能只在 `runChatChain()` 接 permit。
4. 当前 account `degrade` 不会触发现有换号分支；low quota hold 不能仅“复用现有 accountAction”，必须新增显式的 request-local removal outcome。
5. “任一有效额度窗口 100%”与现有“完整 fresh 三窗口”不是同一个判定；耗尽状态必须独立评估最新成功 snapshot 的每个已知窗口，不能只复用 `quotaProjection().status === 'fresh'`。
6. `res.write()` 返回 `false` 是背压，不是写失败；heartbeat 必须等待 `drain`/暂停注入，不能据此按客户端断开 finalize。
7. graceful shutdown 不能在仍有 active request 时先关闭 log store；需要先停止接入并等待请求 finalizer，再 drain stores，deadline 后才销毁 sockets/agents 并退出。

---

## 1. Error-only 复用 DetailedLogStore

### 已验证事实

- full capture 只在 `config.detailedLogging === true` 时于 `http.createServer()` 入口创建 `DetailRoot`（`server.js` 的 server callback）。
- 当前 `DetailRoot` 不是轻量 root：构造时创建 ingress/downstream `BodyCapture`、包装 `res.write/writeHead/end`、异步 `store.open()`；`readBody()` 会复制 ingress，`root.attempt()` 会复制并再次解析 outbound JSON（`lib/detailed-log-capture.js`）。
- `DetailedLogStore.open()` 先发布 `state: open` manifest，最终 `publish(requireOpen: true)` 替换同一 request root；普通 `publish(requireOpen: false)` 已支持一次性发布，因此 store 本身能承载 error-only group（`lib/detailed-log-store.js`）。
- store 的根身份是 `requestId`，manifest 内已有 `attempts[]`、`bodies[]`，上限 256 attempts/514 bodies；无需第二个 store。
- 当前 full attempt 的 `callId` 在 `DetailRoot.attempt()` 中生成，但 `runChatChain()` trace 不携带它；ordinary `attemptIndex` 是最终 `trace` 数组下标，由 `record()` 在请求终态临时枚举。账号替换时旧 trace 会 prepend，当前二者只是碰巧同序，没有显式合同。

### 可行实现边界

建议把 `DetailRoot` 扩展为 profile，而不是另建 store：

- `full`：维持现有 ingress/outbound/downstream observation；
- `error`：只保留 request identity、attempt sequencer 和失败候选，不调用 `store.open()`，不包装 downstream，不在 `readBody()` 复制 ingress；终态存在失败 attempt 时用一次 `publish(requireOpen:false)`；
- `none`：不创建 capture owner。

error-only 非流式可复用 `attemptOnce()`/stream fallback 已经读出的 `res.text`，不会二次消费流。SSE 则必须让 `createSseObserver()`额外保留**触发错误的完整原始 event bytes**（有界）；当前 observer 只留下解析后的 `errorPayload` 和 redacted error string，不能还原“上游响应体”。

### 必须修正的规划点

#### 1.1 attempt 身份 owner 不能放在 full detail 内

应在“即将发起每个 native POST `/chat/completions`”的公共 seam 分配：

```text
requestId + monotonically increasing attemptIndex + UUID callId
```

该 token 同时传给：

- RPM permit commit；
- `clineRequest()`/full `DetailRoot.attempt()`；
- error-only collector；
- `traceAttempt()`；
- ordinary error row。

未实际进入 native transport 的 RPM block/provider planning failure不分配 token。这样 capture 开关变化不会改变 ordinary 关联事实。

#### 1.2 “capture failure 可与 expiry/clear 区分”目前过度承诺

ordinary error row 在 `record()` 中立即 append，而 detailed publication 异步、可能稍后因 pending fence、generation、retention、sanitize 或磁盘失败返回 false。现有 detail API 对 missing/expired/cleared/corrupt 都是安全 404，health 只有全局计数，无法证明某个 `requestId` 的缺失原因。

可诚实区分的只有：

- row 无 capture intent：当时开关关闭/legacy；
- group 存在且 body state 为 `resource-limited`/`omitted-for-safety`/`transport-failed`：捕获结果明确；
- row 有 intent 但 group 404：只能显示“已清空、已过期、被丢弃或发布失败”。

若必须逐条显示 publication failure，只能让 error rows 在 detailed promise settle 后再写入最终 capture outcome，或引入另一个持久 outcome；前者会改变错误日志时效/崩溃窗口，后者违反单 owner 约束。建议调整 AC，不宣称 missing 404 可精确归因。

#### 1.3 transport failure 需要区分“未收到响应”和“已起流后断流”

规划中的“transport failure 无 body/headers”只适用于 request 尚未收到 response headers 的失败。已开始 SSE 后 transport error 已有 HTTP 200 headers，也可能已有正常 data；error-only 应保留 headers 和 `response-started/stream-transport-failed` 事实，但仍不复制此前成功 chunks。不能把这类情况显示成“没有上游响应”。

#### 1.4 redaction 成本仍在主事件循环

`DetailedLogStore.publish()` 把 `produce()` 放入异步 serial queue，但 `produce()` 内 5 MiB group-wide learn/materialize 仍是同一 JS 线程上的同步 CPU 工作。它不延长当前响应的 await 链，但可能阻塞其他请求的 event loop。删除 `root.attempt()` 的重复 JSON.parse/learn 是有效优化，却不足以证明“非阻塞”。验收应表述为“有界、延后、fail-open，并有 event-loop benchmark”，不要承诺真正 non-blocking；若 benchmark 不达标，需 cooperative chunking 或 worker，而后者会显著扩大范围。

#### 1.5 ordinary pending fence 不能只在 stringify 后计数

`JsonlLogGroup.append()` 当前先同步 `JSON.stringify` + `Buffer.from`，再进入 promise queue。若唯一无界字段（主要是 structured error reason）很大，序列化本身已造成同步分配；在其后检查 16 MiB pending fence 不能满足“不做无界同步工作”。应先给 ordinary 单条记录/`reason` 建明确 byte/字符上限，再精确序列化并预留 pending records/bytes。错误正文已可进入 error detail，ordinary reason 不应继续承担无限正文保真。

#### 1.6 “off 时 API/schema 不变”需收窄

新增 settings 字段和 UI 开关必然改变管理 API/UI schema。可保证不变的是 model traffic、ordinary row（未启用时不新增 capture intent）、现有 full store 行为和敏感数据面；子任务 AC 中“off 模式 API/schema/UI 与现状一致”按字面不可同时满足。

---

## 2. stable attempt 关联与现有 chat lifecycle

当前真实 chat attempt 主要有三类终态：

- 非流式 `attemptOnce()` 返回 HTTP/error envelope；
- SSE 首 data 前读取失败，仍可 provider/account failover；
- SSE 已开始后在 `handleChat()` 的 idempotent `finalize()` 中回写最后一个 trace attempt。

因此 token 必须在 transport start 时生成，并允许 post-start finalizer更新同一 token，而不是新增 pseudo-attempt。现有 `record()` 已正确抑制 client cancellation 的 error rows，也会把账号替换前后的 trace 合并；新关联必须保留这两个行为。

full detailed group 的 attempts 顺序虽通常与 trace 一致，但不应靠数组位置推断。manifest attempt 应显式保存 `attemptIndex`，并严格校验 integer/UUID；UI优先按 `(attemptIndex, callId)` 双重匹配，发现不一致时显示安全 unavailable，而不是退回“第 N 项”。

---

## 3. maxRpm reserve/commit 与所有 caller

### 已验证事实

- 当前 `tryLease()` 只有 `maxConcurrent` 同步检查、active count increment 和幂等 release；所有 selection mode 最终都经过它（`server.js: accountHasCapacity/tryLease/acquire*Lease`）。
- `runChatChain()` 一个 lease 内可能有多个 Provider attempts；账号替换才取得第二个 lease。
- 并非每个真实 chat 管理调用都持有相同 lease/chain：
  - `/api/test` 使用 lease + `runChatChain()`；
  - probe/validate 使用 management lease，但下层 `probeModel()`/`validateUpstreams()` 直接走 `accountFetchJSON()`，validate 还会每批 `Promise.all` 5 个 chat；
  - `/api/accounts/test` 和 `/api/accounts/proxy-test` 直接发 `/chat/completions`，当前不通过 chat lease；
  - quota GET/models 不应计 RPM。
- `clineRequest()` 是所有 native account transport 的共同 owner，只有 exact POST chat path 才创建 detailed attempt。

### reserve/commit 建议

- 并发判定成功后才能 reserve 首 permit；concurrency block 路径不得 prune/占用 RPM reservation。
- `commit` 的可测试定义应是：`ClientRequest` 已成功创建，紧接着调用 `req.end(data)` 将请求交给 Node。若在创建 request 前 commit，`lib.request()` 同步抛错也会被错误计为真实 attempt。
- 调用 `req.end()` 后，无论 DNS/connect/proxy/TLS/timeout/cancel 均不退款；调用前异常或 provider plan/no-attempt/client already closed 则 release reservation。
- uncommitted reservation release 必须 `notifyCapacityWaiters()`，否则其它请求只能等 retry timer/deadline。

### 需要补齐的风险

#### 3.1 只把 permit 接到 runChatChain 不足以覆盖需求

必须枚举所有 exact POST chat caller，并为不持有 lease 的 account/proxy test 定义语义。尤其 draft key test 可能没有稳定 persisted account/`maxRpm`，不能声称它受“账号级 maxRpm”保护。建议：

- persisted accountId 的管理 chat 全部复用该账号的 lease/permit owner；
- 未绑定已保存账号的临时 credential test 明确不受账号 maxRpm，或直接拒绝/要求 accountId；二者需产品合同选一。

validate 的 5 路并发也要求 lease 暴露可并发调用的 permit broker：首 reservation 只能被其中一个调用原子 claim，其余各自 reserve/commit，不能把一次 management lease误算成一次 RPM。

#### 3.2 retry wait 需要一个明确的 request deadline

“后续 Provider attempt 使用当前请求剩余 bounded wait”目前没有 owner：`runChatChain()` 不知道 account selection 的原始 wait deadline。必须在 lease/selection result 中携带单一 deadline，或明确每次 retry 不等待并立即 local 429。不能给每个 retry 都重新分配完整 `concurrencyWaitMs`，否则最多 21 attempts 会线性放大延迟。

#### 3.3 dynamic growth 判定必须使用完整 blocked aggregate

合法 grow 条件应精确为：

```text
所有当前 active hard-eligible candidates 都有有限 maxConcurrent，
且全部 blockedBy=concurrency，等待 deadline 后仍成立，
且存在 eligible standby 且 target < max。
```

只要出现 `blockedBy=rpm`、unlimited-concurrency candidate、mixed concurrency/RPM，均不 grow。RPM local block也不创建 trace/error rule/account replacement。

#### 3.4 内存“有界”说法需更谨慎

每账号最多 100,000 timestamps 是 operator-bounded，但当前 accounts 数量没有显式条数上限；总窗口内存不是固定常数。实现至少应使用 compact numeric ring/head 索引、定期压缩，并在文档中称“由账号数 × maxRpm 配置界定”，不要声称仅由 active lease 数量界定。

---

## 4. quota hold/exhausted 与 resetsAt 恢复

### 已验证事实

- `quotaProjection()` 只有在最新成功、无后续失败、三窗口齐全且 15 分钟内时才返回 hot/warm/reserve；partial success 仍持久化，但 routing 为 unknown。
- quota scheduler、manual page和save trigger 已共享 `quotaJobs`/global two-slot pump；应继续复用。
- `META.accountStates` 当前是单一 rule disposition object：
  - `persistAccountAction()` 会覆盖整个 state；
  - `clearExpiredCooldowns()` 会删除整个 object；
  - `/api/accounts/recover` 会删除整个 object；
  - startup normalizer只保留现有 rule 字段。
- 当前 account policy `degrade` 只影响 health sample；`handleChat()` 仅在 `diagnostic.accountAction` 为 cooldown/hard-quarantine 时停止 chain并首包前换号。

### 必须调整

#### 4.1 low degrade 不能“直接复用现有换号”

需新增与 rule action 正交的结果，例如：

```text
diagnostic.quotaDispositionAction = waiting-refresh
chain.removeAccount = accountAction || quotaDispositionAction
```

只有 pre-stream 才允许现有的一次换号；post-start 只影响未来选择。否则 low账号命中默认 account degrade 后会继续同账号 Provider retry，不满足“立即退出调度”。

触发条件也必须冻结：推荐仅当 lease role snapshot=`low` 且 canonical policy 最终 action=`degrade`、scope=`account` 时进入 hold；explicit `ignore` 不进入。是否让显式 cooldown/hard-quarantine 同时创建 quota hold，目前 child design 前后不一致，应在实现前选定，避免人工 recover 后意外仍被 quota hold 排除。

#### 4.2 exhaustion 不能只复用 fresh-complete role

父需求是“任一有效窗口达到 100%”。因此：

- role/membership 仍可要求三窗口 complete+fresh；
- exhaustion evaluator 应查看最新成功 snapshot 中每个已知有效 window；即使 snapshot partial，只要某个明确为100%，也应设置 exhausted；
- 后续 refresh failure保留上次已确认 exhausted，不能因 `quotaProjection()` 变 unknown 而解除；
- known `0` 与 missing window继续不同。

当前 child PRD 的“复用 fresh complete snapshot”若也用于 exhaustion，会漏掉 partial-100%，与父 PRD 冲突。

#### 4.3 waiting-refresh 必须绕过 success cache，但仍遵守现有全局 admission/backoff

当前 `quotaDemandOutcome()` 会在最近成功5分钟内返回 cached。设置 hold 后若不加 disposition-aware override，“下一次刷新”可能只是 cached，不会产生恢复证据。应让 routing scheduler 的下一轮把 waiting-refresh 视为需要一次真实 fetch；失败后继续现有 bounded backoff，不能自旋。

exhausted 则应：

- 在未来 `quotaRetryAt` 前由自动 scheduler视为 cached/deferred；
- 到点后允许真实 refresh；
- manual `force:true` 是否可提前绕过 retryAt需明确（child design称可以，现有 force 仍不绕过 failure backoff）；
- 多个100%窗口可先取最早未来 reset 做一次重评，但只有全部已知窗口 <100 才恢复；若另一个窗口仍100%，再计算下一次。

没有有效未来 resetsAt、或上游返回已过期 reset 时，使用现有 success周期重试，避免 immediate loop。

#### 4.4 accountStates 所有 mutation 都要改为字段级 merge/clear

不仅 startup normalizer，还包括 `persistAccountAction()`、cooldown expiry、manual recover、key/proxy rotation、delete/prune和API projection。manual recover应只清 rule disposition，不能清 exhausted；quota refresh reconciliation只清 quota disposition，不能解除 hard quarantine。

另外规划中同时出现 `waiting-refresh` / `waiting-quota-refresh`、`exhausted` / `quota-exhausted`，必须选一个 canonical persisted enum，防止 migration/API/spec漂移。

#### 4.5 pool filler 顺序不应优先 unknown 于额外 known-low

child design 的补位顺序 `high -> unknown -> low` 会在已有可用 warm 账号时优先选择额度未知账号，降低可解释性和成功率。建议 unknown 永远最后补位；目标不足时投影真实 composition，不把 warm filler伪装成 high。动态 target新增槽“目标为 high”不等于在 high 不足时必须选 unknown。

---

## 5. Node 18 / proxy agent keep-alive

### 已验证事实

- direct请求未传 agent，依赖 `http/https.globalAgent`；项目声明 Node `>=18`，Docker却固定 Node 22，因此复用行为跨运行时不稳定。
- `proxyAgentFor()` 按完整 proxy URL缓存 `HttpsProxyAgent`/`SocksProxyAgent`，构造时未传 options。
- 锁定的 `https-proxy-agent@7.0.6` 与 `socks-proxy-agent@8.0.5` 都继承 `agent-base.Agent`，其构造参数进入 core `http.Agent`；显式 `{ keepAlive, maxSockets, maxFreeSockets, scheduling }` 可行。`HttpsProxyAgent` 还会依据 `this.keepAlive`发送 `Proxy-Connection: Keep-Alive`。
- 当前 config save 只 `proxyAgents.clear()`，没有 `agent.destroy()`。

### 风险与调整

1. direct HTTP/HTTPS各自使用一个显式 Agent是正确方向；不要依赖 Docker Node 22 globalAgent。
2. proxy agent enable keepAlive 后，config save 必须先 destroy stale agent再移除；仅 clear map会遗留 idle tunnels直到超时/GC。
3. `/api/accounts/proxy-test` 可提交不同 draft URL，当前每个 URL都会进入全局 cache。keepAlive 后认证用户可制造无界 agent/free-socket cardinality。应只缓存 persisted account proxy，draft override使用一次性 agent并在请求结束 destroy，或给现有 map加严格上限和淘汰 destroy。
4. proxy tunnel能否复用还依赖响应完整消费和代理/上游支持；验收应以 local TCP/CONNECT/SOCKS计数证明，不只检查 agent options。

入站显式 `server.keepAliveTimeout≈95s` 且 `headersTimeout>keepAliveTimeout` 在 Node 18可用，也不会限制正在进行的 SSE。不要使用较新版本才有的 `keepAliveTimeoutBuffer` 作为必需能力；`closeIdleConnections/closeAllConnections` 应 feature-detect以覆盖 Node 18小版本。

---

## 6. SSE heartbeat、backpressure 与 timeout

### 当前行为

- `runChatChain()` 有一个120秒 wall timer，覆盖 native request到首个SSE事件；成功返回 stream 后 finally清除此 timer。
- `clineRequest()` 同时对 `ClientRequest` 调用 `req.setTimeout(120000)`；成功起流后该 socket idle timeout仍存在。
- `readFirstSseEvent()` 当前把第一个完整 SSE block当首事件，并要求 trim 后以 `data:` 开头，因此前置 comment/event/id不兼容。
- started SSE 通过 observer + idempotent finalize维护usage/error/DONE、lease release和“不重放”。

### 可行设计及修正

- first-event scanner应在总计64KiB内跳过 comment-only/empty/meta blocks，直到首个含 `data:` 的完整 event；保留全部原始 prelude并一次向下游写出。comment不能重置120秒 wall deadline，否则上游可用注释无限阻止failover。
- 起流后需要把底层 request/socket timeout从first-event值切换为stream-idle值。当前 `clineRequest()` 不暴露 `req`，因此必须返回一个窄控制句柄（如 `setIdleTimeout(ms)`/`destroy()`）或在内部 response阶段切换；只新增函数参数但无法触达现存 req timeout listener并不够。
- heartbeat只保活 switcher→New API，下游 ping不得重置Cline上游 idle timer。
- `res.write(': PING\n\n') === false` 仅表示buffer达到highWaterMark。正确行为是停止额外heartbeat、等待 `drain` 后重新arm；只有 throw、socket close/error才是失败。把 false按client disconnect会制造错误499、提前释放lease。
- 最稳妥的是让一个唯一 stream-local heartbeat/forward owner串行写入 upstream chunks和comments；避免 pipe向`res`写数据时另一个timer同时直接写且没有统一背压状态。
- observer继续只观察upstream bytes，因而 heartbeat不会改变usage/error/DONE/responseBytes；full downstream capture可观察实际发送的comment，这是预期。

---

## 7. graceful shutdown

当前源码没有 SIGTERM/SIGINT coordinator；`DetailedLogStore.close()`只清timer且不等待queue/拒绝新publication，`JsonlLogGroup.close()`会无限等待queue，server也未关闭agents/quota jobs。

建议单一 coordinator，顺序必须是：

1. 幂等进入 shutting-down，停止 `listen`、quota schedule和新的管理批次；关闭idle inbound sockets。
2. 等待 active HTTP/chat finalizer（包括SSE）在总deadline内完成；此阶段log stores仍可接收终态append/publish。
3. active归零后，fence新日志 admission，await ordinary queue/handles与detailed queue；`DetailedLogStore.close()`需变为async并保证close后publication立即release reservation + drop。
4. 正常 drain后 destroy direct/proxy agents并退出。
5. deadline到达时 abort quota/active upstream、`closeAllConnections`（feature-detect）、destroy agents，并显式退出；不能继续await永久blocked filesystem promise。

若一开始就调用 store.close，会与仍在运行的stream finalizer竞态并丢最后一条记录。现有 integration `stop()` 1秒后SIGKILL，新增grace period后也需让测试使用可配置短deadline并明确区分graceful exit与强杀。

---

## 8. 建议的串行实施门禁

现有子任务顺序合理，但每步应增加以下门禁：

1. **error detail/log**：先冻结 profile、attempt token和missing-detail文案；不要承诺逐条区分disk publication failure。建立单条ordinary记录上限后再做pending fence。
2. **RPM**：在改 `tryLease()` 前列出所有 exact POST chat caller；冻结 management draft test语义和一个request级permit deadline。
3. **dynamic growth**：输出结构化 aggregate block reason，证明 mixed/RPM不grow。
4. **low quota**：先升级 accountStates 正交schema和所有mutation，再接选择；独立测试partial snapshot 100%、多个reset、refresh failure和manual recover。
5. **keep-alive**：先用Node18验证agent options与timeout切换，再实现heartbeat；背压测试必须让`res.write()`返回false且最终成功，不能只测socket close。
6. **最终集成**：覆盖“low lease→多个Provider permit→错误详情→waiting refresh→high fallback→quota refresh恢复→SSE heartbeat→SIGTERM drain”，并分别断言attempt数、RPM数、ordinary error数、detail attempt token和lease release均exactly once。

## 未执行项

本次为只读技术复核，未修改业务代码/规格/规划文件，未运行完整测试或性能基准；结论来自当前 `server.js`、`lib/*.js`、相关测试/spec及锁定依赖源码。