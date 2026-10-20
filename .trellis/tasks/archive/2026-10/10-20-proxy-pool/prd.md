# 上游出口动态代理池

## Goal

Cline 上游边缘网关按**出口 IP** 限流：约 70 请求 / 约 60 秒窗口，超限返回 HTML 429，与 key 和账号无关（见 `docs/upstream-ip-rate-limit-findings.md`）。现在每个账号固定绑一个 `proxyUrl`，31 个账号共用本机一个出口，这个出口打满后整批账号一起 429；遇到 HTML 429 时还在同一账号、同一出口上重试，必然再次失败。

本任务新增一个**全局代理池模式**：

- **开启时**：每次上游调用都从池里**轮询**（可选随机）取一个代理，与账号无关。代理有健康状态，失败或被限流时短时冷却；命中 HTML 429 时换一个代理重试。
- **池的来源有两种**：
  - **手动导入**：自定义代理 URL 列表。
  - **FloppyData 自动导入**：通过 API 拉取一批（默认 100 个）住宅代理会话，每隔一段时间（默认 3 分钟）整批更新，换成新的出口 IP。
- **池中暂无可用代理时**：退回账号原来的出口。
- **关闭时**：行为完全不变，各账号继续使用自己绑定的 `proxyUrl` 或直连。

## Background（已由代码和接口调研确认）

研究产物见 `research/upstream-call-paths.md`、`research/retry-and-affinity.md`、`research/config-api-tests.md`、`research/floppydata-api.md`。

### 上游调用路径

- 所有带账号 key 的上游调用都经过 `clineRequest`（`server.js:4198`），出口由 `proxyUrl || account?.proxyUrl` 决定（`server.js:4228`）。经过它的调用包括：
  - 聊天流式（5663）和非流式（5449），Responses 和 Anthropic 入站共用这两条路径。
  - `/api/test`、`/api/probe`、`validateUpstreams`、周期探测（4701）、`/api/accounts/test`。
  - 额度刷新（4462，显式传入 `job.proxyUrl`）。
  - `/api/accounts/proxy-test`（6418，ephemeral）。
- **唯一例外**：`catalog()`（6181）带账号 key，却用全局 `fetch` 直连 `{upstreamBase}/models`。

### 依赖账号 `proxyUrl` 的现有逻辑

- **失败归因**：传输失败按 `account.proxyUrl ? 'proxy' : 'network'` 归因，共 11 处：3416、4305、5162、5466、5689、5703、5735、6029、6052、6142、6624。
- **agent 缓存**：只保留账号 `proxyUrl` 对应的 agent，上限 128（4181、4192、4229）。
- **脱敏种子**：只取自 `config.accounts[]`，位置在 271、5203、5214、6216 和 `lib/detailed-log-capture.js:492`。`DetailRedactor` 上限为 256 个种子、64 KiB（`lib/detailed-log-capture.js:61-64`）。

### HTML 429 现状

- 识别函数是 `isGatewayThrottle`（5300）。
- 退避按 account.id 记，从 1s 起、最长 8s（5297-5320）。
- `gatewayStep`（5619）在同一账号、同一出口上等退避结束后重试 1 次。

### 其他事实

- **会话粘性**：HRW、session binding、缓存池只按 accountId 选号，不依赖出口；开启代理池不影响选号。仓库里没有任何证据表明上游 prompt cache 和客户端出口 IP 有关（未实测）。
- **旧镜像兼容**：
  - 旧镜像会原样保留未知的顶层配置字段（`server.js:157`）。
  - `metadata.json` 中 `proxyHealth` 的键必须等于 `proxyEndpointKey()`，否则旧镜像启动失败（1140）。
  - `config.json` 已在 `.gitignore` 中。
- **FloppyData**：
  - 一次 `POST /v2/proxy/rotating/connections` 调用只返回一个连接，没有数量参数，100 个会话需要调用 100 次（单次约 0.4s）。
  - `rotation` 只能取 -1、0、5、10、15、20、60，0 表示粘性会话；没有 3 分钟这一档。
  - 不传 `session` 时，服务端会生成随机会话号。
  - 所有连接共用账号级密码。
  - 网关为 `<floppydata-gateway-host>`：socks5 用 10800 端口，http 用 10080 端口。
  - 流量按 GB 计费，探测时账户余额约 11.8 GB。

## Requirements

### R1 代理池配置与来源

- 顶层单例 `proxyPool`，包含：
  - 开关 `enabled`
  - 选择策略 `strategy`：`round-robin`（默认）或 `random`
  - 来源 `source`：`manual` 或 `floppydata`
  - R3～R5 的参数
- **手动来源**（`source: manual`）：
  - `entries` 是代理 URL 列表，一行一个，每个 URL 就是一个出口，支持 http、https、socks5、socks5h，校验规则与 `proxyUrl` 相同。
  - 上限 2000 条，按规范化后的 URL 去重。
  - 条目写在 config.json 里。
- **FloppyData 来源**（`source: floppydata`），见 R2。
- 没有 `proxyPool` 字段，或 `enabled=false` 时，行为和 config.json 字节都与改动前完全一致；启动时不补写 `proxyPool`。
- 账号配置不新增任何字段。

### R2 FloppyData 自动导入与定时刷新

- **配置项**（`proxyPool.floppydata`）：

  | 字段 | 说明 | 默认值 |
  |---|---|---|
  | `apiKey` | API 密钥 | 必填 |
  | `type` | 代理类型 | `residential` |
  | `country` | 国家 | `US` |
  | `state` / `city` | 地区 | 不填 |
  | `protocol` | `socks5` / `http` / `https` | `socks5` |
  | `rotation` | 轮换间隔 | `0`，即粘性会话 |
  | `count` | 每批数量，1～500 | 100 |
  | `refreshIntervalMs` | 刷新间隔，60000～3600000 | 180000 |
  | `apiBase` | 接口地址 | `https://api.floppydata.net`，测试时可指向本地 |

- **导入**：
  - 开启模式且来源是 floppydata 时，服务启动、配置保存或 SIGHUP 后立即导入一批，之后每隔 `refreshIntervalMs` 再导入一批。
  - 每批调用 `count` 次 connections 接口。每次带一个本地生成的随机 `session`，格式为 `cps<批次号><序号>`，长度不超过 128。
  - 并发不超过 8，单次调用超时 15s。
- **替换**：
  - 新批次至少一半成功时，整批原子替换旧列表。不足一半时保留旧列表，30s 后重试，失败退避上限为一个刷新间隔。
  - 被替换下来的旧条目不再被选中。它们的在途请求（包括长 SSE 流）要正常跑完，连接在请求结束后才销毁。
- **存储**：FloppyData 导入的条目**只放在内存里**，不写入 config.json，重启后重新导入。`apiKey` 存在 config.json 里，和账号 key 一样只对已认证管理员可见，控制台里掩码显示。
- **可观测与手动操作**：
  - 状态里能看到：上次刷新时间、成功数/请求数、下次刷新时间、最近一次错误的枚举值（`unauthorized` / `insufficient_balance` / `rate_limited` / `network` / `invalid_response`）。
  - 提供"立即刷新"操作。
- **余额**：控制台可以查询并显示剩余流量（调用 `/v2/account/balances`），只在手动查询时调用。
- **密钥安全**：调用 FloppyData 时，API key、返回的用户名和密码都不得出现在日志、metadata、错误体和普通 API 中。

### R3 按调用选代理与回退

- `enabled=true` 时，**所有账号**的每次上游 HTTP 调用（Background 中列出的全部 `clineRequest` 路径）都从池中选取。选取前先排除冷却中和已达限速的条目，然后：
  - `round-robin`：维护一个全局游标，依次选下一个可用条目。来源刷新后游标重置。
  - `random`：在可用条目中均匀随机选一个。
- 选中池条目时，**覆盖**账号自己的 `proxyUrl`。
- **池中没有可用条目时（D10）**：本次调用退回账号原来的出口，即该账号的 `proxyUrl`；如果账号本来就没配代理，就直连。这与关闭模式下的行为完全相同，日志 `egress` 记为 `account-proxy` 或 `direct`，并带 `poolFallback: true`。触发情况包括：
  - 池为空，例如 FloppyData 首次导入尚未完成或已失败；
  - 所有条目都在冷却中；
  - 所有条目都已达到限速。
- `catalog()` 改为经过 `clineRequest`，与其他调用一样受代理池控制（**D7**）。
- `/api/accounts/proxy-test` 保持只测试显式给出的单个 URL。

### R4 条目健康与冷却

- 条目的健康状态只保存在进程内存中，不写入 metadata。重启或 FloppyData 换批后状态清零。
- 两类事件会触发冷却：
  - **上游 HTML 429**：冷却时长取响应的 `Retry-After`，没有时用 `throttleCooldownMs`（默认 60000）。
  - **代理连接阶段失败**：在与上游建立连接之前出错，包括代理拒绝、握手失败、认证失败、连接超时。冷却时长为 `failureCooldownMs`（默认 30000）。
- 连接阶段超时 `connectTimeoutMs`，默认 10000。
- 连接建立之后才发生的错误不让条目冷却。

### R5 HTML 429 和连接失败时换代理重试

- 本次 attempt 走的是池条目，且在**首包前**遇到 HTML 429 或连接阶段失败时，立即换一个本请求**还没用过**的池条目重试，不等待。
- 每个请求最多换 `egressRetries` 次，默认 2，范围 0～5。这个次数单独计算，不占用 provider 重试次数和换号次数。
- 换代理重试不改变已选的账号，也不触发账号级退避。条目自身的故障不会让账号被降级、冷却或隔离。
- 次数用完后：
  - 如果最后一次是 HTML 429：返回 429 `rate_limit_error`，`Retry-After` 取最早的恢复时间，按秒向上取整，限制在 1～60。
  - 如果最后一次是连接失败：沿用现有 502 的返回形态。
  - **不**再追加一次走账号出口的请求。只有在"选不到可用条目"时才按 R3 回退。
- 回退到账号出口的 attempt，以及关闭模式下的请求，HTML 429 处理与现在完全一致：按账号退避，同一出口重试 1 次。

### R6 按条目限速（可选）

- `maxRpmPerProxy`：0 表示关闭；1～10000 表示每个条目 60 秒滚动窗口内最多发出的请求数，在 `req.end()` 时提交计数。
- 达到上限的条目不参与选取。所有条目都满时，按 R3 回退到账号出口。

### R7 管理接口与控制台

- **`GET /api/accounts`**：返回 `proxyPool`，包含手动条目的明文 URL 和 FloppyData 的 `apiKey`，仅限已认证管理员查看，与现有 `proxyUrl` 的处理一致。
- **`POST /api/accounts`**：严格校验后保存。
  - 请求里省略 `proxyPool` 时，保留服务器上的现有值。
  - 受 `configurationRevision` 保护，并发冲突返回 409。
  - 校验失败返回 400，且不写文件。
- **`GET /api/proxy-pool/status`**：不包含任何 URL、用户名、密码或 key，返回以下内容：
  - 开关、来源、策略、条目总数和可用数；
  - FloppyData 刷新状态（R2）；
  - 每个条目的信息：短 id、协议、`proxyEndpointKey`（`scheme://host:port`，不含凭据）、状态（`ok` / `cooldown` / `rate-limited` / `retiring`）、冷却截止时间、原因枚举、当前窗口 RPM 用量，以及最近 15 分钟的请求数、HTML 429 数、连接失败数、回退次数。
- **`POST /api/proxy-pool/refresh`**：触发一次 FloppyData 导入。
- **`GET /api/proxy-pool/balance`**：查询 FloppyData 剩余流量。
- **`POST /api/proxy-pool/test`**：抽样测试条目的连通性，最多 50 个，并发 8。结果只包含短 id、ok、ms 和原因枚举，不影响条目的冷却状态。
- **控制台**："代理池"卡片，包含：
  - 模式开关、策略、来源（手动 / FloppyData）以及各项参数；
  - 手动来源：条目列表默认折叠并掩码，点"显示并编辑"后变成一行一个 URL 的 textarea；
  - FloppyData 来源：API key（密码框）、类型、国家、协议、rotation、数量、刷新间隔，以及"立即刷新"和"查询余额"按钮；
  - 条目状态表。
- **开启模式后的账号显示**：账号列表的出口徽标显示"代理池"；账号抽屉里提示"代理池可用时不使用此固定代理"。
- **热加载**：`proxyPool` 支持 SIGHUP 热加载。非法配置拒绝加载，不改文件。手动来源下，同一 URL 的条目保留原有健康状态。切换来源或修改 FloppyData 参数后，立即导入新的一批。
- 切换开关不会让账号的额度、会话绑定、circuit、RPM 状态失效。

### R8 日志与脱敏

- 每个 attempt 的 trace 条目、错误记录和请求记录新增以下字段：
  - `egress`：取值为 `direct`、`account-proxy` 或 `pool:<8 位 hex>`。后者是 `HMAC(routingSecret, 规范化 URL)` 的前 8 位，不是 URL。
  - `poolFallback`：布尔值。
- 以下内容都要加入所有脱敏种子来源，包括普通日志、错误原因、详细日志、Provider note 和诊断头：
  - 手动条目的 URL、用户名、密码；
  - FloppyData 的 apiKey；
  - FloppyData 当前批和退役中条目的用户名、密码。
- 种子要随 FloppyData 换批动态更新。条目数达到 2000 时，脱敏也不能因为种子超限而退化成整段省略。
- `metadata.json` 不新增键。`proxyHealth` 继续使用 `proxyEndpointKey` 作为键，但改为按 attempt 实际使用的出口归属。FloppyData 的全部条目会聚合到 `socks5://<floppydata-gateway-host>:10800` 这一个网关键下。
- 传输失败的归因改为看本次 attempt 实际使用的出口。

### R9 安全约束

- 从池中选出的条目连接失败时，只会换其他池条目，**不会**在同一次 attempt 内直连重试。只有"选不到条目"时才按 D10 回退到账号原出口。
- 账号自己的固定代理失败时，仍然不回退直连，与现状一致。
- 旧镜像回滚安全：旧镜像保留但忽略 `proxyPool`；metadata 结构不变。

## Acceptance Criteria

- [ ] AC1：不含 `proxyPool` 或 `enabled=false` 时，以下各项都与改动前一致：config.json 字节（启动、保存、热加载后）、选号、出口、429 重试；现有测试全部通过，不改语义。
- [ ] AC2：手动 3 条目的池开启 round-robin 后，连续 6 个请求依次走 A、B、C、A、B、C；改为 random 后，60 个请求覆盖全部条目。实际出口由测试里的假代理记录。
- [ ] AC3：开启后，账号自带的代理和直连都收不到请求；关闭后（保存或 SIGHUP），流量立即回到账号原来的出口。
- [ ] AC4：A 返回 HTML 429 时，请求换到下一个条目并成功，客户端收到 200，trace 中依次出现两个 `pool:` 短 id；A 在冷却期内不再被选，到期后恢复；账号既没有被降级，也没有进入账号级退避。
- [ ] AC5：A 的端口无法连接时，请求换到其他条目并成功；A 进入冷却，账号健康状态不受影响。
- [ ] AC6：所有条目都在冷却时，新请求走账号原出口（有固定代理的走固定代理，没有的直连），并记录 `poolFallback: true`；换代理次数用完时返回 429 并带 `Retry-After`，不追加走账号出口的请求。
- [ ] AC7：`maxRpmPerProxy=2`、2 个条目时，同一窗口内的第 5 个请求回退到账号出口，不会在池条目上超发。
- [ ] AC8：开启后，以下路径都经过池条目：额度刷新、`/api/accounts/test`、`/api/probe`、周期探测，以及 `catalog()`（若 D7 获批）。
- [ ] AC9：FloppyData 来源：
  - 本地假 API 返回 `count` 个连接后，池中条目数等于 `count`；
  - 过 `refreshIntervalMs` 后整批换新，旧条目上进行中的 SSE 流不受影响，流结束后旧连接被销毁；
  - 假 API 返回 401、402、500，或成功数不足一半时，保留旧列表，状态中显示对应的错误枚举；
  - 首次导入完成前，请求按 D10 回退；
  - 同一批次中每次调用的 `session` 都不相同。
- [ ] AC10：带 RFC1929 用户名密码的 SOCKS5 条目、带认证的 HTTP CONNECT 条目都能正常工作；以下各处都不出现条目的 URL、用户名、密码和 FloppyData apiKey：普通日志文件、日志 API、`metadata.json`、错误响应体、诊断头、`/api/proxy-pool/*`；2000 个条目时详细日志的脱敏仍然有效。
- [ ] AC11：
  - `POST /api/accounts` 遇到以下非法输入时返回 400，文件字节不变：非法 URL、重复条目、超出上限、floppydata 来源缺少 apiKey、参数越界、rotation 不在允许值内。
  - SIGHUP 可以开关模式、切换来源、修改参数。
  - 非法配置下 SIGHUP 被拒绝，文件不变。
- [ ] AC12：metadata 结构不变；HEAD 版本代码能加载新版本写出的 metadata，也能启动带有 `proxyPool` 的配置并保留该字段。
- [ ] AC13：控制台能完成开关、选择来源和策略、编辑手动条目（默认掩码）、配置 FloppyData、立即刷新、查询余额、查看条目状态；UI 契约测试覆盖这些操作。
- [ ] AC14：所有自动化测试只使用本地假上游、假代理和假 FloppyData API，不访问 `api.cline.bot` 或 `api.floppydata.net`；仓库、测试、文档和提交信息中不出现真实代理地址、用户名、密码或 API key。

## Decisions

已由用户确定：
- 全局单一代理池，有开关，不与账号绑定。关闭时沿用账号原有的代理。
- D10：池中没有可用条目时，退回账号原出口（有固定代理用固定代理，没有就直连）。
- 支持两种来源：FloppyData 自动导入（默认 100 个，约每 3 分钟整批更新）和手动导入；选取方式以轮询为主。

用户于 2026-10-20 确认（按建议值）：
- D1 手动来源一行一个 URL，不做 `{session}` 模板展开。
- D3 HTML 429 和连接阶段失败都会在首包前立即换代理重试，默认最多 2 次；条目故障不连带影响账号。
- D4 冷却默认值：HTML 429 冷却 60s，连接失败冷却 30s，连接超时 10s。
- D5 按条目限速默认关闭；如需开启，建议设为 60/分钟，所有条目都满时按 D10 回退。
- D7 `catalog()` 改为走统一出口。
- D8 管理 API 维持现有做法：已认证管理员可以看到明文，控制台默认掩码。
- D11 FloppyData 默认参数：住宅代理、US、socks5、rotation=0（粘性）、100 个、每 180s 刷新；`session` 由本地生成随机值。
- D12 FloppyData 条目只放内存、不落盘，重启后重新导入。

## Risks

- **流量计费**：开启 FloppyData 后，所有 Cline 上游流量都经过住宅代理，按 GB 计费，长上下文请求体占大头。当前余额约 11.8 GB，其中一部分 2026-11-04 到期。控制台提供余额查询，但不做自动停用（见 Out of Scope）。
- **延迟和稳定性**：住宅代理会增加首字延迟。实测住宅代理链路错误率约 1～3%，这部分由换代理重试吸收。
- **接口调用频率**：100 个 / 3 分钟 ≈ 每小时 2000 次 API 调用，FloppyData 没有公布速率限制。实现上限制并发并做失败退避；如果遇到限流，可以把刷新间隔调大。
- **D10 回退直连**：对没有配置固定代理的账号，D10 意味着池不可用时会直连，即回到改动前的行为。

## Out of Scope

- 多个池、按账号指定池、同一会话固定同一代理。
- 其他代理商的 API 对接。来源字段已经预留了扩展位置。
- 余额不足时自动停用或报警。
- 关闭模式下，账号固定代理或直连出口的按 IP 限速与冷却。
- 通过代理查询真实出口 IP、按 /16 网段去重、`{session}` 模板生成。
- 统计页按条目绘制分钟级曲线。
- 跨进程共享条目状态。
- 调整账号 `maxConcurrent` 的默认值。
