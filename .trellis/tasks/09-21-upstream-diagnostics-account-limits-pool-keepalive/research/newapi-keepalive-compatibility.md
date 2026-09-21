# New API 与 cline-pass-switcher 长连接兼容性核查

## 最终范围决策

本任务只补现有 New API -> switcher Chat Completions链路的HTTP/1.1连接复用、SSE注释心跳、首data/起流后idle timeout和前置comment兼容；明确不实现HTTP/2/h2c入站、Realtime WebSocket或Responses API，也不修改New API。heartbeat必须把`write(false)`视为背压并等待drain，不能误判客户端断开；draft proxy override使用一次性agent，不进入persisted proxy cache。

## 结论摘要

核查基线：

- `cline-pass-switcher`: `fe3b70c`
- 相邻 `../new-api`: `cf475250`
- 只读取源码、README 和测试；未读取两边的运行配置、凭据或生产数据，也未启动真实上游。

当前 README 明确的主集成方向是：

```text
OpenAI 客户端
  -> New API
  -> cline-pass-switcher /v1/chat/completions
  -> Cline 上游
```

证据：`README.md:179-183` 明确要求把 New API 渠道 Base URL 指向 `http://switcher:3123/v1`。

总体判断：

1. **OpenAI Chat Completions SSE 已基本兼容**。两边都能处理 `text/event-stream`、逐块转发、`data: [DONE]` 和下游断开；switcher 还会在暴露响应前检查首个完整 SSE 事件，避免首包前错误被错误地当作成功流。
2. **HTTP/1.1 长连接与 SSE 长流不是同一能力**：New API 的上游连接池是明确实现的；switcher 的连接复用部分依赖 Node 版本默认值，代理 Agent 当前没有启用 keep-alive，且 switcher 入站空闲连接寿命未显式配置。
3. **端到端 HTTP/2 不成立**。New API 的出站客户端支持 TLS HTTP/2 和连接分片，但 switcher 自身只启动明文 `node:http` HTTP/1.1 服务，因此常见 `http://switcher:3123` 链路会自动落到 HTTP/1.1。这个降级不妨碍 SSE 或正确性。
4. **静默长流存在缺口**。switcher 对 Cline 上游使用固定 120 秒超时，且不生成 SSE 心跳；New API 流扫描默认允许 300 秒无数据，但实际链路会先被 switcher 的 120 秒上游空闲超时终止。
5. **取消传播在“已收到上游响应头/已开始流”后可用**；但 New API 普通 Chat 的通用上游请求由 `http.NewRequest` 创建，没有继承入站请求 context。若最终客户端在 switcher 返回响应头之前断开，New API 不会立刻取消它到 switcher 的请求。此缺口不能仅靠 switcher 完全修复，只能用 switcher 的有界超时限制残留工作。
6. **WebSocket 不是当前 switcher 集成协议**。New API 提供 `/v1/realtime` WebSocket 中继；switcher 没有 upgrade/WebSocket 路由，只支持 Chat Completions，且 `/v1/responses` 明确返回 501。若“长连接”指 OpenAI Realtime WebSocket，则双方当前不兼容，且不应把它与 SSE/keep-alive 混为一谈。

---

## 能力矩阵

符号：✅ 明确支持；⚠️ 支持但有条件/缺口；❌ 不支持。

| 能力 | New API | cline-pass-switcher | 当前端到端结论 |
|---|---|---|---|
| HTTP/1.1 服务端 keep-alive | ✅ Go `http.Server` 默认支持；源码未禁用 | ✅ Node `http.createServer` 默认支持；未显式配置寿命 | ✅ 可用，但 switcher 端空闲寿命由 Node 默认值决定 |
| HTTP/1.1 出站连接复用 | ✅ 显式共享 `http.Client`/`Transport`，`DisableKeepAlives=false`，默认池 500/每主机 100，空闲 90 秒 | ⚠️ 直连使用全局 Agent，Docker Node 22 可复用，但项目声明 Node >=18，行为跨版本不统一；HTTP/SOCKS 代理 Agent 当前 `keepAlive=false` | ⚠️ New API → switcher 可复用；switcher → Cline 的代理链路不复用，直连不是源码显式契约 |
| HTTP/2 出站 | ✅ TLS 下 `ForceAttemptHTTP2=true`；支持 `auto`、强制 `http1` 和 1-8 个 HTTP/2 transport shard | ❌ 使用 `node:http`/`node:https.request`，无 `node:http2` | ⚠️ New API 可对其他 HTTPS 上游用 HTTP/2；对明文 switcher 自动降级 HTTP/1.1 |
| HTTP/2 入站 | ❌ 进程自身是明文 `ListenAndServe`，未启用 TLS/h2c；可由外部反代终止 HTTP/2 | ❌ 明文 `http.createServer`，未启用 TLS/h2c | ❌ 应由反向代理承担，不是当前应用间协议 |
| OpenAI Chat SSE | ✅ 设置 SSE 头、扫描 `data:`、Flush、识别 `[DONE]` | ✅ 检查首个完整事件后再暴露，随后管道转发并观察 `[DONE]`/usage/error | ✅ 主路径兼容 |
| SSE 注释心跳 | ✅ 可配置 `: PING\n\n`；默认关闭，默认配置值 60 秒；流处理器能忽略上游注释行 | ❌ 当前不产生心跳；首事件门禁还要求首个事件以 `data:` 开始 | ⚠️ New API 自己可保活最终客户端；switcher 无法保活 New API → switcher 的静默响应段 |
| 首响应前等待 | ⚠️ 启用 New API ping 后，等待上游响应头期间可向最终客户端发送 ping | ⚠️ 最多约 120 秒；为保留首事件失败切换，响应头和首个合法 `data:` 事件一起延后 | ⚠️ 超过 switcher 120 秒仍会失败 |
| 流式空闲超时 | ✅ `STREAMING_TIMEOUT` 默认 300 秒，扫描到任意一行都会 reset | ⚠️ `ClientRequest.setTimeout(120000)` 是 socket 空闲超时；流开始后仍生效 | ⚠️ 有效上限约为 switcher 的 120 秒 |
| 流总时长 | ✅ 默认 `RELAY_TIMEOUT=0`，无 `http.Client` 总时长；但 post-header ping goroutine 最多运行 30 分钟 | ✅ 没有单独的流总时长；有 120 秒上游空闲限制 | ✅ 只要持续有上游数据可长时间运行；心跳覆盖不足 |
| 慢客户端写入保护 | ✅ 每次流写前延长 30 秒 write deadline | ⚠️ 依赖 Node stream backpressure/pipe，无独立写 deadline | ⚠️ 基本可用，switcher 没有与 New API 等价的显式写期限 |
| 客户端取消：流已开始 | ✅ 监听入站 context，关闭上游 `resp.Body`；测试证明及时停止并不处理后续块 | ✅ 下游 response/socket close 时 destroy 上游 body/请求、释放 lease；集成测试覆盖 | ✅ 可沿链路传播 |
| 客户端取消：等待上游响应头 | ⚠️ 普通 Chat 的 `DoApiRequest`/`DoFormRequest` 使用无入站 context 的 `http.NewRequest` | ✅ 若直接客户端断开，switcher 会 AbortController → destroy Cline 请求 | ⚠️ 经 New API 时断点发生在 New API，switcher看不到原始客户端断开，只能等超时 |
| OpenAI Realtime WebSocket | ✅ `/v1/realtime`，双向 WebSocket 中继 | ❌ 无 upgrade handler/路由 | ❌ 不兼容；不属于本次 Chat SSE 最小修复范围 |

---

## 证据明细

### 1. New API：HTTP 连接池与 HTTP/2

`../new-api/service/http_client.go:72-108`：

- 从 `http.DefaultTransport.Clone()` 创建 relay transport；
- 显式设置：
  - `MaxIdleConns = common.RelayMaxIdleConns`
  - `MaxIdleConnsPerHost = common.RelayMaxIdleConnsPerHost`
  - `IdleConnTimeout = RelayIdleConnTimeout`
  - `ForceAttemptHTTP2 = true`
- `RelayTimeout != 0` 时才设置 `http.Client.Timeout`。

`../new-api/common/init.go:112-115,178` 的默认值：

- `RELAY_TIMEOUT=0`：默认没有整个请求的总时长上限；
- `RELAY_IDLE_CONN_TIMEOUT=90` 秒；
- `RELAY_MAX_IDLE_CONNS=500`；
- `RELAY_MAX_IDLE_CONNS_PER_HOST=100`；
- `STREAMING_TIMEOUT=300` 秒。

`../new-api/service/http_transport_policy.go` 与 `http_transport_sharded.go`：

- `auto` 默认尝试 HTTP/2；
- 可强制 `http1`，同时仍保留 HTTP/1 keep-alive；
- 可按 origin 在最多 8 个独立 transport 间轮转，为一个 origin 保持多条可复用 HTTP/2 连接。

`../new-api/service/http_client_transport_test.go:116-178` 已证明：

- auto + 1 shard 对 TLS HTTP/2 服务复用一条连接；
- 4 shards 建立并复用恰好四条 HTTP/2 连接。

`../new-api/service/http_client_transport_test.go:181-266` 已证明：

- 强制 HTTP/1 时不会协商 HTTP/2；
- keep-alive 没有被禁用；
- 并发 HTTP/1 请求能按需建立多条连接。

### 2. New API：自身服务端不是原生 HTTP/2 入口

`../new-api/main.go:190-215` 创建普通 `http.Server{Addr, Handler}` 并调用 `ListenAndServe()`：

- 没有 TLS；
- 没有 h2c handler；
- 没有显式 `ReadTimeout`、`WriteTimeout`、`IdleTimeout`。

因此进程直连入口是 HTTP/1.1；部署在 Nginx/Caddy/Ingress 后时，外层反代可以对客户端提供 HTTP/2，但反代到 New API/ switcher 的内层协议仍取决于其 upstream 配置。

### 3. New API：SSE、ping、超时和取消

`../new-api/relay/helper/common.go:45-58,110-122`：

- SSE 响应设置 `Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`；
- ping 是标准 SSE 注释 `: PING\n\n`，写后立即 Flush。

`../new-api/setting/operation_setting/general_setting.go:26-30`：

- ping 默认关闭；
- 默认配置间隔为 60 秒。

`../new-api/relay/channel/api_request.go:411-475,490-548`：

- 流请求在 `relayClient.Do(req)` 等待响应头期间也可以启动 ping；
- 该阶段 pinger 最长 120 分钟；
- `relayClient.Do` 返回后 defer 停止这个首响应阶段 pinger。

`../new-api/relay/helper/stream_scanner.go:78-305`：

- 响应头到达后由共享 scanner 处理上游 SSE；
- 每扫描到一行就重置 `STREAMING_TIMEOUT`，之后才过滤非 `data:` 行，因此 switcher 将来发送的 SSE 注释心跳可以维持 New API 的上游扫描器，但不会成为模型事件；
- 可另起 ping goroutine向最终客户端发送心跳；该 goroutine最长 30 分钟；
- 每次写入有 30 秒 write deadline；
- 最终客户端断开时设置 `client_gone`、关闭上游 `resp.Body` 并等待所有 goroutine退出。

对应测试：

- `../new-api/relay/helper/stream_scanner_test.go:216-284`：取消后关闭上游 body、不再处理后续块、及时返回；
- `:288-379`：慢流期间发送 ping，以及 `DisablePing=true` 时不发送；
- `:454-490`：流空闲超时。

### 4. New API：普通 Chat 首响应前取消传播缺口

`../new-api/relay/channel/api_request.go:312-370` 中 `DoApiRequest` 和 `DoFormRequest` 都使用：

```go
http.NewRequest(c.Request.Method, fullRequestURL, requestBody)
```

没有使用 `http.NewRequestWithContext(c.Request.Context(), ...)`，后续 `relayClient.Do(req)` 因而不能在最终客户端断开时自动取消正在等待响应头的上游请求。

相对地，task 请求在 `../new-api/relay/channel/api_request.go:591-595` 明确使用 `NewRequestWithContext`，且 `api_request_test.go:14-24` 只固定了 task 路径的取消继承。这进一步说明普通 Chat 路径目前没有同等契约。

一旦响应头已返回并进入 `StreamScannerHandler`，客户端取消会关闭 `resp.Body`，所以该缺口主要位于首响应前；它不否定已开始 SSE 的取消能力。

### 5. switcher：协议、SSE 和取消

`server.js:1947-1978`：

- 只使用 `http.request`/`https.request`；
- `req.setTimeout(timeoutMs)` 默认 120000 ms；
- AbortSignal 会同时 destroy response 和 request；
- 未显式传 Agent 时依赖 Node 全局 Agent。

`server.js:2727-2845`：

- 每个 attempt 有默认 120 秒 AbortController timer；
- 流请求要求 HTTP 200 且规范化 Content-Type 等于 `text/event-stream`；
- 最多读取 64 KiB，等待首个完整 SSE 事件；
- 首事件必须以 `data:` 开始，首事件携带 error 时可在暴露流之前执行 provider/account fallback；
- 成功暴露流后清除 attempt wall timer，但底层 `req.setTimeout(120000)` 的 socket 空闲限制仍在。

`server.js:2944-3009`：

- 返回 SSE 时设置 `Content-Type`、`Cache-Control: no-cache`、`Connection: keep-alive`；
- 先写已验证的首事件，再用 Node stream pipe 转发余下内容；
- 观察 `[DONE]`、usage 和流中错误；
- 下游关闭时 destroy 上游 body；
- finalize 幂等释放账号 lease。

`test/integration.test.js:128-216,523-557` 已覆盖：

- `[DONE]` 后关闭视为成功；
- 流式和非流式客户端取消记录为 499，而不是健康失败；
- 首响应前直接客户端断开会关闭上游请求；
- 流开始后断开会关闭上游流、释放容量且不重放。

### 6. switcher：HTTP/1.1 keep-alive 的不确定性

`server.js:3057` 只调用 `http.createServer`，没有设置：

- `server.keepAliveTimeout`
- `server.headersTimeout`
- `server.requestTimeout`

本机 Node `v26.8.1` 只读探针结果为：

```json
{
  "keepAliveTimeout": 5000,
  "keepAliveTimeoutBuffer": 1000,
  "headersTimeout": 60000,
  "requestTimeout": 300000,
  "timeout": 0
}
```

项目 Dockerfile 固定 `node:22-alpine`，而 `package.json` 允许 `node >=18`。由于代码没有建立自己的服务端 keep-alive 契约，New API 默认愿意保存 90 秒的空闲连接时，switcher 可能在约 5 秒后先关闭它；这不会破坏请求正确性，但会造成额外重连。

switcher 出站同样没有显式直连 Agent：

- Docker Node 22 的全局 Agent 默认可 keep-alive；
- Node 18 兼容范围不能得到相同保证；
- `proxyAgentFor()` 缓存了 HTTP/SOCKS Agent，但构造时未传 `{ keepAlive: true }`。

本机对当前锁定依赖的只读实例探针显示：

```json
{
  "HttpsProxyAgent.keepAlive": false,
  "SocksProxyAgent.keepAlive": false
}
```

因此“缓存 Agent 对象”不等于“缓存隧道/连接”。

### 7. WebSocket 边界

New API：

- `../new-api/router/relay-router.go:75-80` 注册 `GET /v1/realtime`；
- `../new-api/relay/websocket.go` 和 `relay/channel/openai/relay_realtime.go` 实现双向 WebSocket 中继。

switcher：

- 没有 server `upgrade` handler；
- `CHAT_PATHS` 只包含 Chat Completions；
- `server.js:3086-3087` 对 `/v1/responses` 明确返回 501。

因此本任务若以现有 README 的 New API → switcher Chat 渠道为目标，不应顺手增加 WebSocket、Responses API 或 HTTP/2；它们是独立协议和显著扩项。

---

## 集成缺口与影响排序

### P0：switcher 到 Cline 的复用不是稳定契约

影响：

- Node 18 直连可能每次重建 TCP/TLS；
- HTTP/SOCKS 账号代理当前明确不复用空闲连接；
- 高并发下增加握手、代理 CONNECT 和端口消耗。

这属于 switcher 自身缺口，可仅修改 switcher。

### P0：switcher 不发送 SSE 心跳，且 120 秒先于 New API 300 秒超时

影响：

- Cline 在流中长时间无数据时，switcher 会约 120 秒后主动销毁上游；
- New API 的 300 秒扫描超时没有机会成为实际上限；
- New API 与 switcher 之间若存在小于 120 秒的空闲反代，也可能先断开；
- New API 自己的 ping 只保活“New API → 最终客户端”，不能反向替代“switcher → New API”的字节流。

### P1：switcher 服务端空闲连接寿命太依赖 Node 默认值

影响：

- New API 默认连接池保留 90 秒，而 switcher 常见 Node 默认约 5 秒；
- 连接仍可安全重建，但复用命中率低。

### P1：SSE 首事件门禁不接受前置注释事件

switcher 要求首个完整事件以 `data:` 开始。标准 SSE 允许先发送 `: PING` 注释。当前主方向中 switcher 自己控制返回格式，因此不阻塞 New API → switcher；但若将 New API 作为 switcher 上游、或 Cline 将来先发注释，switcher 会把合法 SSE 误判为 `unexpected stream head`。

### 外部残余：New API 普通 Chat 首响应前取消

最终客户端在首响应前断开时，New API 仍可能维持到 switcher 的请求。switcher 看见的是仍然存活的 New API 连接，无法知道原始客户端已离开。仅改 switcher不能实现即时取消，只能通过首事件/上游超时限制残留工作。

这应在报告和测试中作为已知限制，不应伪称已由 switcher 修复。

---

## 仅修改 cline-pass-switcher 的最小方案

### 方案 A：显式统一现有 `clineRequest()` 的 HTTP/1.1 连接池

不新增第二套 transport，仍由现有 `clineRequest()`/`proxyAgentFor()` 持有：

1. 为直连 HTTP 与 HTTPS 各创建一个进程级 Agent：
   - `keepAlive: true`
   - 有界 `maxSockets`、`maxFreeSockets`
   - 明确空闲 socket 超时/调度策略（按 Node 22 支持范围实现，不能破坏 Node >=18）。
2. `clineRequest()` 在无账号代理时按 URL 协议传入对应 Agent。
3. 构造 `HttpsProxyAgent`/`SocksProxyAgent` 时显式传 `keepAlive: true` 和同类有界参数；继续按代理 URL 缓存，绝不在代理失败后改走直连。
4. 不引入 `fetch`、Undici 或第二个请求实现。

收益：直连、HTTP 代理、HTTPS 代理、SOCKS 都由同一现有边界获得稳定复用，不再依赖 Node 版本默认。

### 方案 B：显式配置 switcher 入站 keep-alive 窗口

在现有 `server` 上设置有界值，使其略长于 New API 默认 90 秒空闲池，例如：

- `keepAliveTimeout` 约 95 秒；
- `headersTimeout` 大于 keep-alive 窗口并保持有界；
- 保留请求体读取的现有 50 MiB 限制和 Node request timeout 防护。

值应可通过有界环境变量调整，默认值与 README 中推荐的 New API 直连部署一致。无需引入 TLS 或 HTTP/2 server。

### 方案 C：只在 SSE 已成功暴露后发送注释心跳

1. 保留当前“首个合法 SSE data 事件前不提交响应”的 fallback 语义。
2. 在首事件已写给下游后，若一段时间没有从 Cline 收到任何字节，则向下游写 `: PING\n\n` 并 Flush。
3. 心跳间隔必须：
   - 有界、可配置；
   - 小于部署链路最短空闲超时；
   - 默认可取 15-30 秒；
   - 不进入 usage、错误分类或 provider 重试；
   - 在正常结束、上游错误、客户端取消时由现有幂等 finalize 清理。
4. 写失败按客户端断开处理，不把它算成供应商健康失败。

兼容性依据：New API scanner 在过滤非 `data:` 行前已经重置流空闲 ticker，所以会把该注释当作保活字节并安全忽略。

限制：New API 不会把上游注释原样转发给最终客户端。要保活最终客户端，仍需启用 New API 已有的 ping 设置；这只需要运维配置，不需要修改 New API 代码。

### 方案 D：拆分“首事件期限”和“已开始流的空闲期限”

不要用一个 120 秒值表达两种生命周期：

- `firstEventTimeoutMs`：保留首事件前有界等待和 failover，默认可继续 120 秒；
- `streamIdleTimeoutMs`：流开始后的 Cline socket 空闲限制，默认至少与 New API 的 300 秒扫描窗口协调，或采用约 310-360 秒；
- 非流式总 attempt timeout 继续有界。

实现仍复用 `runChatChain()` 的 AbortController 与 `clineRequest()` 的 `req.setTimeout()`：

- AbortController timer负责首响应/首事件硬期限；
- request socket timeout负责已开始流的上游空闲期限；
- 下游 heartbeat只保活 switcher → New API，不应掩盖 Cline 上游永久卡死。

### 方案 E：首事件解析容忍标准 SSE 注释（建议同时做，非主链必需）

让首事件读取器跳过：

- `:` 注释事件；
- 空事件；
- 可选 `event:`/`id:` 元数据，直到遇到首个 `data:` 事件。

仍保持累计 64 KiB 上限和首事件超时，防止无界等待/缓存。这样 switcher 既可接收 Cline 心跳，也可在反向拓扑中接收 New API 的 `: PING`。

### 明确不做

- 不在 switcher 中新增 HTTP/2 server；
- 不实现 h2c；
- 不实现 `/v1/realtime` WebSocket；
- 不实现 `/v1/responses`；
- 不修改 New API；
- 不为 keep-alive 新增第二套 transport/队列/状态所有者。

这些都不是修复现有 New API → switcher Chat SSE 所必需的最小变更。

---

## 本地 mock 验证建议

全部使用临时 `DATA_DIR`、本地 mock Cline 和无真实凭据。

### T1. New API 风格 HTTP/1.1 连接复用

- 启动 switcher 与本地 mock Cline；
- 使用显式 keep-alive 客户端连续请求 switcher；
- 记录客户端本地端口/服务端连接计数；
- 两次请求间隔应覆盖旧 5 秒默认窗口但小于新配置窗口；
- 断言复用同一连接，且响应内容正确。

该测试固定 switcher 入站 keep-alive 契约，不依赖本机 Node 默认值。

### T2. switcher 到 Cline 直连复用

- mock Cline 记录每个请求的 `socket.remotePort`；
- 连续执行两次非流式 Chat；
- 读取并正常结束响应；
- 断言两次命中同一上游连接。

### T3. HTTP/SOCKS 代理隧道复用

- 扩展现有本地代理测试，分别统计 HTTP CONNECT 次数和 SOCKS 建连次数；
- 同一账号连续两次 Chat；
- 断言业务请求两次、隧道只建立一次；
- 再让代理失败，断言绝不回退直连。

### T4. SSE 静默段心跳

mock Cline：

1. 立即发送一个合法 `data:` 事件；
2. 静默时间大于测试心跳间隔；
3. 再发送内容和 `[DONE]`。

断言：

- switcher 下游在静默段收到至少一个 `: PING`；
- data 事件字节顺序不变；
- `[DONE]` 后只 finalize 一次；
- usage、日志和健康统计不把 ping 当事件；
- lease 最终释放。

再用一个“New API scanner 等价”小型本地消费者过滤注释行，断言 ping 重置空闲计时但不产生模型 chunk。

### T5. 首事件与流空闲超时分离

通过仅测试环境变量缩短时间：

- 上游迟迟不发首事件：命中 first-event timeout，未向下游提交 SSE；
- 首事件及时、后续静默短于 stream-idle timeout：流成功；
- 首事件及时、后续静默超过 stream-idle timeout：流失败一次、释放 lease、不重放；
- 下游 ping 不得重置 switcher 对 Cline 的上游空闲计时。

### T6. 标准 SSE 前置注释

mock Cline 依次发送：

```text
: PING


data: {"choices":[...]}


data: [DONE]


```

断言 switcher 跳过注释、正常暴露 data 流，不产生 `unexpected stream head`，累计首事件缓存仍受 64 KiB 限制。

### T7. 取消传播

保留现有直接客户端测试并增加 New API 风格中间层：

- **流已开始**：中间层读到第一个 data 后关闭 switcher response body；断言 switcher 关闭 mock Cline、释放 lease、不重放、不记健康失败。
- **首响应前**：中间层保持到 switcher 的请求，即使其“最终客户端”已取消；断言 switcher最终由 first-event timeout 收敛。该测试应明确标记这是 New API 当前 context 缺口的有界缓解，不声称即时传播。

### T8. HTTP/2 边界

无需给 switcher 增加 HTTP/2 测试。只需证明：

- New API 对 `http://switcher` 能按 HTTP/1.1 工作并复用；
- New API 的 `auto`/强制 `http1` 都不改变 Chat/SSE 语义；
- 若部署要求客户端侧 HTTP/2，由现有反向代理终止并关闭响应缓冲。

---

## 最终判定

若用户所说“长连接”是：

- **HTTP/1.1 keep-alive/连接复用**：双方可工作，但 switcher 需要显式 Agent 和服务端 keep-alive 窗口，才能从“运行时碰巧可复用”升级为稳定契约。
- **OpenAI SSE 流式**：当前已兼容；需补 switcher post-start 心跳和分离后的流空闲超时，才能可靠覆盖静默长流。
- **HTTP/2**：New API 出站支持，switcher 不支持；当前明文内网链路会安全降级 HTTP/1.1，无需为本任务增加 HTTP/2。
- **WebSocket/OpenAI Realtime**：New API 支持、switcher 不支持；不属于现有 Chat Completions 集成，不能宣称兼容。

推荐最小落地顺序：

1. switcher 显式统一出站 keep-alive Agent；
2. 对齐 switcher 入站 keep-alive 窗口；
3. 增加 post-start SSE 注释心跳；
4. 拆分首事件 timeout 与流空闲 timeout；
5. 首事件解析容忍前置 SSE 注释；
6. 用上述本地 mock 固定复用、静默流、超时和取消边界。
