# 修复代理超时误杀非流请求

## Goal

经代理（SOCKS / HTTPS CONNECT）转发的非流式 Chat 请求，在上游仍在生成、尚未返回完整响应时，不得被代理 Agent 的 60 秒空闲定时器提前掐断并报成 `socket hang up`。进行中请求的期限只由既有 attempt / request timeout 约束。

## Background

生产日志出现 `status_code=502, upstream fetch failed: socket hang up`，总耗时约 3 分 8 秒。根因：`proxyAgentOptions.timeout = 60_000` 被 SOCKS（raw socket `setTimeout` + destroy）和 HTTPS 代理（`net.connect({ timeout })`）当成**进行中请求**的空闲销毁；`req.setTimeout(NON_STREAM_ATTEMPT_MS)` 只覆盖外层 TLS，盖不住嵌套 raw socket。同账号换 Provider 会把多次 ≈60s 失败叠成约 3 分钟。直连 Agent 的同名 `timeout` 语义是空闲池回收，不被本任务改动。

## Requirements

1. 账号配置了 `proxyUrl`（`socks5`/`socks5h`/`http`/`https`）时，进行中的上游 Chat 请求不得因代理 Agent 构造参数里的 60 秒 timeout 被 `destroy`，从而产生字面 `socket hang up`。
2. 进行中的期限继续使用现有 `clineRequest` / `runChatChain` 的 attempt 超时（非流默认 `NON_STREAM_ATTEMPT_MS`，流式首事件 `SSE_FIRST_EVENT_MS`，接受后 idle `SSE_STREAM_IDLE_MS`）。到期应仍表现为既有 `upstream timeout` 路径，而不是代理 hang up。
3. 直连（无 `proxyUrl`）的 Agent 空闲池 60 秒回收语义保持不变。
4. 不得为「修好 hang up」而改错误规则、换号策略、或放宽 `NON_STREAM_TIMEOUT_RETRY` 默认值。
5. 用自动化测试锁定：代理路径在「上游故意慢于 60s、短于 attempt 超时」时，不得在约 60s 以 `socket hang up` 失败。

## Out of Scope

- 生产代理出口探活、换号运维、账号冷却策略调整。
- New API / 客户端侧超时配置。
- 把字面 hang up 与 ≈60s `transport_proxy` 在日志投影上拆分（可另开任务）。
- 修改 `maxRetries`、errorRules、retryRules 默认行为。

## Acceptance Criteria

- [x] 代理路径下，上游在 60s～attempt 超时之间才返回时，请求可成功或等到 attempt 超时，而不会在约 60s 以 `socket hang up` / `ECONNRESET` 失败。
- [x] 直连路径的空闲 Agent timeout 行为与现有测试一致，无回归。
- [x] 相关集成/单元测试通过；文档或 backend spec 中「代理 Agent 60s idle」的表述与真实语义一致（进行中由 request timeout 约束）。

## Product intent（已确认）

- 首包 2 分钟：沿用 `SSE_FIRST_EVENT_MS=120000`，本任务不改该默认值。
- 「一次对话 5 分钟」：指**非流式**整段生成 `NON_STREAM_ATTEMPT_MS=300000`；本任务不改该默认值。
- 流式接受后：继续用**上游空闲**上限（现默认 6 分钟 `SSE_STREAM_IDLE_MS`），**不加**整段对话总墙钟；本任务不把空闲默认改成 5 分钟。
- 用户已选推荐方案：本任务只让代理路径遵守上述既有期限，去掉 60s Agent 误杀。

## Notes

- 先前诊断任务 `10-14-proxy-socket-hangup` 已归档；本任务是其代码修复落地。
- 修好后：经代理的长非流可等到最多约 5 分钟；流式首包最多约 2 分钟；不再被代理构造参数的 60s 提前 `socket hang up`。

