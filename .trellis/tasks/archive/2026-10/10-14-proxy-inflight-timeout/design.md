# 设计：代理进行中超时与 attempt 期限对齐

## Boundary

- **改**：`server.js` 中 `proxyAgentOptions` 的构造；可选在 `clineRequest` 对嵌套 socket 同步 attempt 期限；`test/` 回归；`.trellis/spec/backend/quality-guidelines.md`（及同类提及）中关于「代理 Agent 60s idle」的表述。
- **不改**：`directAgentOptions`、账号选择、Provider 计划、错误/重试规则、生产配置。

## Root cause（已证实）

| 路径 | `timeout: 60_000` 含义 | 与 `req.setTimeout(attemptMs)` |
|------|------------------------|--------------------------------|
| 直连 `http(s).Agent` | 空闲池回收；活动请求可被 request timeout 覆盖 | 正常，长非流可达 attempt 上限 |
| `SocksProxyAgent` | connect + **raw socket** `setTimeout`，到期 `req.destroy()` → `socket hang up` | 只改 TLS 外层，raw 仍 60s |
| `HttpsProxyAgent` | `omit(opts)` 进 `net.connect({ timeout })`，同样可在进行中触发 hang up | 同上 |

本地最小复现：raw 1.5s + request 6s → ~1.5s `socket hang up`；直连 Agent 1.5s + request 6s → 等到 request timeout。

## Approach

1. **主修复**：从 `proxyAgentOptions` 移除 `timeout` 字段。  
   - SOCKS：不再对已建立连接设 60s destroy。  
   - HTTPS 代理：不再把 60s 传给 `net.connect`。  
   - 进行中仅依赖既有 `req.setTimeout(timeoutMs)`（及 SSE 接受后的 `setIdleTimeout`）。  
   - 空闲隧道靠 `maxFreeSockets`（默认 2）与对端关闭收敛；接受比直连略长的空闲存活。

2. **加固（同批）**：在 `clineRequest` 于 request 绑定 socket 后，沿 TLS→parent/`socket` 链把嵌套 `setTimeout` 同步为当前 `timeoutMs`。  
   - `setIdleTimeout(ms)` 同样同步嵌套链，避免 SSE 接受后仍被短 raw 定时器杀掉。

3. **期限策略（已确认，本任务不改默认值）**：首包 2min、非流 5min、流式空闲仍 6min；不加流式总墙钟。

4. **明确不做**：改 `SSE_*` / `NON_STREAM_*` 默认；自定义 Socks 子类；单独 connect-only 环境变量；错误规则/换号策略。

## Contracts

- 代理 Chat 进行中：唯一墙钟期限 = 传入 `clineRequest` 的 `timeoutMs`（及 SSE idle 替换值）。
- 失败文案：真正的 attempt 超时仍为 `upstream timeout`；对端真实掐断仍可为 `socket hang up`，但不得由本进程 60s 代理 Agent 定时器制造。
- 直连：`directAgentOptions.timeout = 60_000` 保留。

## Compatibility / Rollback

- 行为变化：经代理的长非流（>60s 静默）从失败变为可完成或等到 attempt 超时——这是目标修复。
- 回滚：恢复 `proxyAgentOptions.timeout = 60_000` 即可回到旧误杀行为。
- 无需持久化迁移或配置 schema 变更。

## Test shape

- 可控上游：headers 前故意 sleep 例如 2–3s；代理/agent 层注入短 raw timeout（或使用真实 SocksProxyAgent + mock SOCKS）模拟旧 bug。
- 断言：修复后在 attempt 超时前不得以 hang up 结束；可对照「若仍传 timeout:60_000 则会 hang up」的单元级复现放在测试辅助中。
- 跑现有 proxy / keepalive / non-stream timeout 相关集成测试，确认直连无回归。
