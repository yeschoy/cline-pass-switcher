# Design — 全局出口代理池（手动 / FloppyData）

> 行号以当前 HEAD（b336318）为准；研究证据见 `research/*.md`。

## 1. 总体结构

```
账号选择（不变：HRW / session binding / 缓存池 / quotaRole 只按 accountId）
   │
   ▼
runChatChain 外层账号循环（不变：首包前最多换号 1 次）
   │
   ▼
provider attempt 循环（不变：maxRetries）── 新增 egressStep：池条目失败时换条目重试
   │
   ▼
clineRequest(url, { account, egressHint })   ← 唯一插入点：resolveEgress()
   │   ├─ 显式 proxyUrl（proxy-test）→ 原样
   │   ├─ proxyPool.enabled 且 pickEntry() 有条目 → 池条目（round-robin / random）
   │   ├─ account.proxyUrl → 原样（关闭模式，或池无可用 → poolFallback）
   │   └─ 都没有 → 直连 agent（同上）
   ▼
返回值 / Error 带 egress = { kind, entryId, endpointKey, connectPhase, poolFallback }

PoolSource（lib/proxy-pool.js）
   ├─ ManualSource：entries 来自 config.json
   └─ FloppyDataSource：定时调 API 生成一批 → 原子换批 → 旧批 retiring（引用计数归零后销毁 agent）
```

代码分布：
- `lib/proxy-pool.js`：纯逻辑，可单测。包括配置规范化、条目 id、运行时选择器、冷却与 RPM、状态投影、脱敏种子集。
- `lib/floppydata-source.js`：API 客户端与换批调度。网络请求和定时器都通过依赖注入传入，便于测试。
- `server.js`：只负责接线，包括 transport、聊天循环、配置、API、脱敏来源。

## 2. 配置契约

```jsonc
// config.json 顶层；缺省 = 关闭，且不写回
"proxyPool": {
  "enabled": false,
  "strategy": "round-robin",      // "round-robin" | "random"
  "source": "manual",             // "manual" | "floppydata"
  "egressRetries": 2,             // 0..5
  "throttleCooldownMs": 60000,    // 1000..600000
  "failureCooldownMs": 30000,     // 1000..600000
  "connectTimeoutMs": 10000,      // 1000..60000
  "maxRpmPerProxy": 0,            // 0 = 关；1..10000
  "entries": [                    // manual 来源用；≤ 2000，规范化去重
    "socks5h://<user>:<pass>@<host>:<port>"
  ],
  "floppydata": {                 // floppydata 来源用；source=manual 时也保留，不清空
    "apiKey": "<API_KEY>",        // source=floppydata 且 enabled 时必填；1..256 可见 ASCII
    "apiBase": "https://api.floppydata.net",   // http(s) URL，无 path/query/hash
    "type": "residential",        // residential | mobile | datacenter
    "country": "US",              // ^[A-Za-z]{2}$
    "state": "", "city": "",      // 可选，≤ 64
    "protocol": "socks5",         // socks5 | http | https
    "rotation": 0,                // -1 | 0 | 5 | 10 | 15 | 20 | 60
    "count": 100,                 // 1..500
    "refreshIntervalMs": 180000   // 60000..3600000
  }
}
```

- **规范化**：`normalizeProxyPool(value, { strict })`。
  - 启动、API、热加载三处一律 strict：配置非法时启动失败、API 返回 400、热加载拒绝。不能静默降级为关闭。
  - 缺省字段补默认值。整个对象缺省时不写入 config，以保证字节不变。
  - `normalizeProxyUrl` 迁到 lib 共享。
- **接入点**（四处都要接，漏一处就会丢配置）：
  1. `normalizeConfigAndMeta`（1434）
  2. `POST /api/accounts` 的严格校验与"省略即保留"（6494）
  3. `reloadConfigFromDisk` 的 `pick` 与 `next`（2942）
  4. `ACCOUNT_CONFIGURATION_FIELDS`（2389）
- **账号身份**：开关、来源、条目的任何变化，都不会让账号的 quota、binding、circuit、RPM、probe 状态失效。额度 job 的身份栅栏（4374/4438/4449）仍只比对账号自身的 `key`/`proxyUrl`；出口在每次调用时由 `resolveEgress` 决定。

## 3. 条目 id

- `entryId = HMAC-SHA256(META.routingSecret, normalizedUrl).hex.slice(0, 8)`，日志里记为 `pool:<entryId>`。它不可逆，所以不会泄露会话号。
- 手动来源中如果出现 id 碰撞，保存时返回 400。FloppyData 来源碰撞时直接丢弃后到的那条（概率极低）。
- `egress` 取值：`direct` | `account-proxy` | `pool:<8hex>`。另有布尔字段 `poolFallback`。

## 4. 运行时（`lib/proxy-pool.js`，进程内）

```js
runtime = {
  generation,                         // 每次换批 / 手动条目变更 +1
  active: EntryState[],               // 可被选择
  retiring: Map<url, EntryState>,     // 已换下、仍有在途请求
  cursor,                             // round-robin 游标，换批时归零
}
EntryState = { url, entryId, endpointKey, cooldownUntil, cooldownReason, inFlight,
               rpm: { committed: number[], reserved }, recent: 15 个分钟桶 }
```

- **`pickEntry({ exclude, now })`**：
  - 先过滤出可用条目：不在 `exclude` 中、`cooldownUntil <= now`，且 RPM 未满（`maxRpmPerProxy = 0` 时不检查 RPM）。
  - 按策略从可用条目中选一个：
    - round-robin：从 `cursor` 开始向后扫描，选中第一个可用条目，然后 `cursor = 选中位置 + 1`。
    - random：在可用条目中用 `crypto.randomInt` 随机选。
  - 选中后预留一次 RPM，并 `inFlight++`。
  - 一个可用条目都没有时，返回 `{ entry: null, retryAt }`。
- **`replaceEntries(urls)`**：手动条目变更和 FloppyData 换批都走这里，原子替换。
  - 手动来源：同一 URL 保留原有 EntryState。
  - FloppyData：每批 URL 全新，直接创建新的 EntryState。
  - 被移出的条目：`inFlight > 0` 的放进 `retiring`；其余立即销毁 agent。
- **`release(entry)`**：请求结束时调用（`res` 的 end/close 或 fail），执行 `inFlight--`。如果条目在 `retiring` 中且 `inFlight` 归零，销毁 agent 并移出。另设兜底：退役超过 `SSE_STREAM_IDLE_MS + 60s` 的条目强制销毁。
- **RPM**：沿用 `rpmWindows`（700-769）的预留 / 提交 / 退还模式。在 `req.end()` 时提交，请求没发出就失败时退还。

## 5. Transport（`clineRequest` 4198）

- **`resolveEgress(account, proxyUrl, egressHint)`**：同步执行，不排队。返回：
  ```js
  { kind: 'explicit' | 'pool' | 'account' | 'direct', url, entryId, endpointKey, poolFallback }
  ```
  依次判断：
  1. 传入了显式 `proxyUrl`：kind 为 explicit。
  2. 池开启，且 `pickEntry` 拿到条目：kind 为 pool。
  3. 池开启，但 `pickEntry` 拿不到条目：按账号原出口处理，并置 `poolFallback = true`。如果本请求已经用过池条目（`egressHint.exclude` 非空），同样回退到账号原出口。
  4. 池关闭：与旧逻辑逐字等价，即 `account.proxyUrl` 或直连。
- **Agent**：
  - 池条目的 agent 交给 runtime 管理，与 `proxyAgents` 分开存放；条目被销毁时 agent 随之销毁。
  - 账号自身的 `proxyAgents` 及其上限 128 保持原样。
  - 池 agent 的 free socket 超时设为 `CLINE_PASS_PROXY_FREE_SOCKET_TIMEOUT_MS`，默认 60000。
- **连接阶段**：
  - `req.on('socket')` 时：socket 已连接（复用的连接）就直接标记为已连接；否则等 `connect` 事件，https 目标等 `secureConnect`。
  - 池条目额外设置 `connectTimeoutMs` 定时器，超时则 `req.destroy(new Error('proxy connect timeout'))`。
  - 已连接之前发生的错误，记为 `egress.connectPhase = true`。
- **健康上报**：只对 kind 为 pool 的请求生效，在 `clineRequest` 内完成，因此所有调用路径都会经过。
  - 响应为 429 且 content-type 是 `text/html`：调用 `noteThrottle`。`Retry-After` 支持秒数和 HTTP 日期两种格式，限制在 1s～600s；缺省时取 `throttleCooldownMs`。
  - 连接阶段失败（不含 abort）：调用 `noteConnectFailure`。
  - `req.end()` 时：`recent.requests++`，并提交 RPM。
  - 请求结束时：`release`。
- **返回值**：resolve 和 reject 的结果都附带 `egress`。其中 `url` 设为不可枚举属性，只交给 detailAttempt 的脱敏器学习，不会被展开或序列化出去。`root.attempt({ proxyUrl })`（4269）改为传入实际使用的 URL。

## 6. 聊天链路：换代理重试

- `runChatChain` 每个账号段维护 `egressExclude = new Set()` 和 `egressRetries = 0`，并把 `egressHint` 透传给 `attemptOnce`（5449）和流式分支（5663）。
- 新增 `egressStep(result)`，插在两处 `gatewayStep`（5727/5761）之前，`!up` 分支也加：
  - 触发条件：`result.egress?.kind === 'pool'`，且满足其一：`isGatewayThrottle`，或 `egress.connectPhase` 为真。
  - 触发后先 `egressExclude.add(url)`。
    - 若 `egressRetries < cfg.egressRetries`、客户端未断开、池里还有其他可用条目（`runtime.hasAvailable(exclude)`）：`egressRetries++`，`attempted.delete(upstream)`，返回 `'retry'` 并 `index--`，不等待。
    - 否则返回 `'stop'`。这种情况下**不会**追加一次走账号出口的请求（PRD R5）。
  - 每次重试都重新领取账号的 RPM permit。
- 本次 attempt 是 pool 时，跳过 `gatewayWaitMs(account)` 和 `noteGatewayThrottle(account)`。kind 为 account 或 direct 时（包括 poolFallback），完全沿用现有逻辑。
- `settleAttempt`（5499 附近）：
  - pool 上的 HTML 429：维持现有网关短路，`healthAction=none`。
  - pool 上的连接阶段失败：`errorScope=proxy`、`scopeEvidence=proxy_pool_connect`、`healthAction=none`。既不降级账号（现状见 5342/5424），也不打开 provider circuit。
- 最终失败：最后一次是 HTML 429 时，返回 429 `rate_limit_error`，`Retry-After = ceil((最早恢复 - now)/1000)`，限制在 1～60，写法复用本地 RPM 终态（5781 附近）。最后一次是连接失败时，维持现有 502。

## 7. FloppyData 来源（`lib/floppydata-source.js`）

- **`createFloppyDataSource({ getConfig, fetchImpl, now, setTimer, onBatch, onStatus })`**
- **单批流程 `refresh()`**：
  1. 先建 `batchTag = base36(Date.now())`。
  2. 发起 `count` 个任务，并发上限 8，每个任务单独设 15s 超时。
  3. 每个任务调用 `POST {apiBase}/v2/proxy/rotating/connections`，请求头 `X-Api-Key`，请求体：
     ```js
     { type, country, state?, city?, protocol, rotation, session: `cps${batchTag}${i}` }
     ```
  4. 从响应的 `connection.connectionString` 取连接串，同时校验：协议与请求一致；URL 能通过 `normalizeProxyUrl` strict；host 非空。响应不合格，或连接串协议非法，记为 `invalid_response`。
  5. 成功数 ≥ `ceil(count/2)` 时调用 `onBatch(urls)`，即 `replaceEntries`，并记录 `lastSuccessAt`；否则保留旧批。
- **错误枚举**：

  | 情况 | 枚举 |
  |---|---|
  | 401 / 403 | `unauthorized` |
  | 402 | `insufficient_balance` |
  | 429 | `rate_limited` |
  | 其他 4xx / 5xx | `upstream_error` |
  | 网络错误或超时 | `network` |
  | 解析失败 | `invalid_response` |

  401 和 402 一出现就停止本批剩余调用，因为再调也没有意义。
- **调度**：
  - 成功后，在 `refreshIntervalMs` 后安排下一次。
  - 失败后，按 `min(30s × 2^n, refreshIntervalMs)` 退避。
  - 同一时间只允许一个 refresh 在跑。手动刷新时，若已有一批在跑，直接返回那一批的 Promise。
- **生命周期**：
  - `start()`：在 `enabled && source === 'floppydata'` 时调用，立即刷新一次。
  - `stop()`：关闭模式或切走来源时调用，取消定时器并 abort 在途调用，然后用 `replaceEntries([])` 让现有条目退役。
  - 以下 FloppyData 参数变化时，需要 stop 后再 start：apiKey、apiBase、type、country、state、city、protocol、rotation、count。只改 `refreshIntervalMs` 时，只重排定时器。
- **出口**：对 FloppyData API 本身的请求由服务器直连发出（管理流量），不走池，也不走账号代理。
- **余额**：`balance()` 调用 `GET {apiBase}/v2/account/balances`，只返回 `availableBytes`、`availableGb` 和 `expiringAt`，由 API 层按需调用。
- **状态**：
  ```js
  { state: 'idle' | 'refreshing' | 'ok' | 'error',
    lastAttemptAt, lastSuccessAt, nextRefreshAt,
    lastBatch: { requested, succeeded },
    lastError: 枚举 | null }
  ```
- **关闭**：`shutdown()` 时调用 `stop()`，并销毁 runtime 的全部 agent。

## 8. 其他调用路径

| 路径 | 改动 |
|---|---|
| 额度刷新 4462 | 不再传 `job.proxyUrl`，出口由 `resolveEgress` 决定 |
| `/api/test`、`/api/probe`、validate、周期探测、`/api/accounts/test` | 已经走 account 回退，自动获得池选择；单次调用不做换代理重试，但会上报健康状态 |
| `/api/accounts/proxy-test` | 不变 |
| `catalog()` 6181（D7） | 改用 `clineRequestJSON(GET /models, { account })` |
| `fetchOfficialModels`、OpenRouter 列表 | 不变 |

传输失败归因有 11 处写成 `account.proxyUrl ? 'proxy' : 'network'`，统一改为 `egressOrigin(egress)`。

## 9. 日志与统计

- `traceAttempt`（5526）增加 `egress`、`poolFallback` 两个字段。`record()` 中请求行（3943）和错误行（3975）的白名单投影同步加入，请求行取最后一次 attempt 的值。`proxyError` 改为根据实际出口判断。
- `proxyHealth`（3713）改为按实际出口的 `endpointKey` 归属，键格式不变。FloppyData 的条目全部聚合到网关键下。
- 前端日志的 trace 中显示 `egress` 短 id，回退的请求加标记。

## 10. 脱敏

- 新增 `configuredEgressSecrets()`，返回以下内容并去重：
  - 账号的 `proxyUrl`；
  - 手动条目的 URL；
  - 所有在用（active）和退役中（retiring）条目解码后的用户名、密码；
  - FloppyData 的 apiKey。

  它替换现有的 6 处种子来源：271、5203、5214、6216、详细日志 learn、诊断头。FloppyData 换批后种子集随之变化，每次请求开始时取当时的快照。
- `DetailRedactor`：
  - 池条目只登记用户名和密码。完整 URL 已由通用正则 `(https?|socks5h?)://\S+` 覆盖。FloppyData 的所有条目共用一个密码，所以实际种子约为 100 个用户名加 1 个密码。
  - 上限提高到 4096 个、512 KiB，正则改为按长度降序的 alternation。补一个单测：2000 条目时 p99 < 5ms/KiB。超过上限时沿用现有的 `markLimited`。
- 调 FloppyData 出错时，原因只记枚举值，不记响应体；如需记录，先过一遍 `redactSecrets`。

## 11. 管理 API

- `GET /api/accounts`：加入 `proxyPool` 字段，含手动条目和 apiKey 的明文，仅管理员可见。
- `POST /api/accounts`：
  - `proxyPool` 可以省略，省略时保留现值。
  - 严格校验，任一项不通过就返回 400，且不写文件：
    - 类型和取值范围、URL 格式；
    - 去重和 id 碰撞；
    - 条目数上限；
    - 手动来源开启时至少 1 条；
    - floppydata 来源开启时必须有 apiKey，rotation 和 country 合法。
- `GET /api/proxy-pool/status`：
  ```js
  { enabled, source, strategy, total, available, retiring, floppydata: 状态 | null,
    entries: [{ entryId, scheme, endpointKey, state, cooldownUntil, reason, rpmUsed, recent }] }
  ```
- `POST /api/proxy-pool/refresh`：立即刷新一次，返回刷新后的 FloppyData 状态。非 floppydata 来源返回 409。
- `GET /api/proxy-pool/balance`：返回 FloppyData 余额投影。失败时返回错误枚举。
- `POST /api/proxy-pool/test`：
  - 请求体 `{ sample?: 1..50 }`，并发 8。
  - 每个条目用一次性 agent 发一次空探测，不计 RPM，也不写冷却状态。
  - 返回 `[{ entryId, ok, ms, status?, errorCategory? }]`。
- 所有新路由都走现有的管理员 Cookie/CSRF 边界。

## 12. 控制台（`public/index.html`）

- 账号页新增"代理池"卡片，内容如下：
  - **基本设置**：开关、策略（轮询 / 随机）、来源（手动 / FloppyData），以及通用参数：重试次数、两个冷却时长、连接超时、每代理 RPM。
  - **手动来源**：默认显示掩码列表，每行为 `entryId · 协议 · host:port · u*** · 状态`。点"显示并编辑"后切换为每行一个 URL 的 textarea，参照 `parseAliases` 逐行严格解析，出错时给出行号。
  - **FloppyData 来源**：
    - apiKey 用密码框，默认掩码；
    - 类型、国家、州 / 城市、协议用下拉框；rotation 下拉只列允许的取值；数量、刷新间隔用数字框；
    - "立即刷新"按钮；
    - "查询余额"按钮，显示剩余 GB 和到期时间；
    - 刷新状态行：上次成功时间、成功数/请求数、下次刷新时间、错误。
  - **状态表**：列出可用、冷却、退役中的条目数量和明细，手动点击刷新。
- 模式开启后：
  - 账号列表的出口徽标显示"代理池"；
  - 账号抽屉里提示"代理池有可用代理时，不使用此固定代理"。
- `collectAccounts()`（1790）的返回值增加 `proxyPool`。

## 13. 兼容与回滚

- **关闭或缺省**：`resolveEgress` 与旧逻辑逐字等价，gateway 的退避、重试和归因都走原分支。由 AC1 回归验证。
- **metadata**：不新增键，键格式不变（AC12）。
- **回滚旧镜像**：旧镜像保留但忽略 `proxyPool`，账号回到各自的 `proxyUrl`，也就是改动前的行为。不需要门禁。
- **运行期关闭**：控制台关掉开关，或修改配置后发 SIGHUP，立即生效。FloppyData 的定时器随之停止，不再产生 API 调用和代理流量。

## 14. 规模

| 项目 | 估算 |
|---|---|
| config.json | 手动来源最多 2000 条 × 约 120 B ≈ 240 KB；FloppyData 条目不落盘 |
| 内存 | 每条约 1 KB。退役批次最多与新批次并存一个 SSE 空闲周期，即最多约 2 批 |
| 文件描述符 | 每个 agent 最多 2 个空闲 socket，100～200 个 agent 约 400 个 fd；2000 条手动条目约 4000 个。部署说明中提示核对 `ulimit -n` |
| API 调用 | 默认每 3 分钟 100 次，约 2000 次/小时 |
| 日志 | 每个 attempt 增加约 20 字节 |

## 15. 取舍

- **在 transport 层选择出口**：不会漏掉任何调用路径，也不影响账号粘性。
- **池无可用时回退到账号出口（D10）**：可用性优先，退化后就是旧行为。代价是没有配置代理的账号在池不可用时会直连。
- **换代理次数用尽时直接返回 429**：如果再追加一次走账号出口的请求，会在单一出口上放大突发流量，与本任务的目标相悖。
- **FloppyData 条目只放内存**：避免每 3 分钟写一次 config，也避免和 `configurationRevision` 冲突。代价是重启后要重新导入，约 5 秒，期间按 D10 回退。
- **每批调用 count 次 API，而不是本地拼接用户名**：只依赖文档承诺的行为，不依赖未公开的用户名格式。代价是 API 调用较多。
