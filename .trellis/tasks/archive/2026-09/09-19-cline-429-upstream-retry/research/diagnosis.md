# Cline 429 与上游重试链路诊断

## 结论摘要

1. **确定发生了账号切换**：请求记录依次出现账号5和账号3；当前 `handleChat` 仅在命中 `cooldown` / `ban` 账号动作时才会在同一请求中更换账号，且最多一次（`server.js:1704-1734`）。
2. **现有证据不支持“已切换到 fireworks”**：`X-Cline-Attempts: 2` 是跨账号合并后的真实 HTTP attempt 数；两个账号各有一个 attempt，因此没有第三次 attempt 可对应同一账号内的第二个 provider。
3. **按当前实现，最可能的路径是**：`账号5/deepseek -> 429 -> 账号动作 -> 账号3/deepseek -> 429 -> 返回`。账号替换会从新账号路由的首个 provider 重新开始（`server.js:1704-1734`）。
4. **`X-Cline-Target-Upstream: deepseek>fireworks` 只表示最终账号配置产生的候选目标**（`server.js:1709-1710,1790-1794`），不是实际轨迹。
5. **`X-Cline-Actual-Upstream: unknown` 只说明错误响应无法解析 `routing.finalProvider`**，既不能证明 deepseek 被调用成功，也不能证明 fireworks 被调用过（`server.js:1777-1794`）。
6. **429 的根因层级尚不能严格定性**：两账号都在约 150ms 内收到完全相同的 `HTTP 429 + text/html + 142 bytes`，更像发生在 Cline API 边缘/网关、共享 IP 或全局限流层，而不是返回结构化错误的具体模型 provider；但缺少 142 字节正文，不能排除 Cline 的账号额度页或其他统一限流响应。

## 代码路径

### Provider chain

- `buildAttempts()` 按配置顺序为 `deepseek`、`fireworks` 等构建外层候选（`server.js:1494-1510`）。
- `runChatChain()` 在普通失败时继续下一 provider（`server.js:1584-1661`）。
- 但每个失败都会先执行 `accountActionFor()`；若动作是 `cooldown` 或 `ban`，立即 `break`，不会继续该账号的下一 provider（`server.js:1534-1537,1656-1659`）。

### Account replacement

- `handleChat()` 外层最多执行两次账号循环（`server.js:1704`）。
- 第一个账号命中 `cooldown/ban` 且响应尚未开始时，将其排除并选择替代账号（`server.js:1724-1732`）。
- 替代账号重新调用完整 `runChatChain()`，即从替代账号路由的第一个 provider 开始，而不是从原账号未执行的第二个 provider 继续。
- 两段 trace 最终合并，因此 `X-Cline-Attempts` 为 2（`server.js:1735,1745,1793`）。

## 429 来源层级判别

| 来源 | 典型证据 | 本次证据 |
|---|---|---|
| Switcher 本地容量不足 | 没有上游 attempt；响应带 `Retry-After`；错误为 accounts unavailable | 已发生两次 `api.cline.bot` 调用，排除 |
| Cline 账号额度/账号限流 | 通常与 Authorization 账号相关；结构化错误可能带额度/计划说明 | 两账号均失败，但正文未知，不能确认 |
| Cline API 边缘/全局/IP 限流 | 多账号短时间同样失败；HTML 而非 API JSON；无法得到 actual provider | 与现象高度一致，但仍需正文确认 |
| 实际模型 provider 限流 | Cline JSON/envelope 或 routing 信息通常能标明 provider/原因 | `actual=unknown` 且 HTML，现有证据较弱 |

## 日志字段解读

- 用户材料中 attempt 的 `provider: [deepseek, fireworks, ...]` 看起来是请求捕获系统投影出的候选集合，不是本项目 JSONL 中的单次 `targetProvider` 字段，不能当作实际命中的 provider。
- 本项目可用于最终还原的字段：
  - 请求日志：`targetProviders`、`attempts[].provider/status/upstreamStatus/account/action`；
  - 错误日志：`attemptIndex`、`targetProvider`、`providerPath`、`status`、`upstreamStatus`、`reason`、`accountAction`。
- `responseHeaders.X-Cline-Actual-Upstream=unknown` 在错误路径很常见，因为 `routing.finalProvider` 为空。

## 当前行为的设计风险

HTTP 429 本身无法区分“账号额度”与“某个 provider/网关的瞬时限流”。如果生产把 429 配成账号级 `cooldown`：

- 好处：账号额度耗尽时可迅速换账号；
- 代价：provider 特定 429 或 Cline 网关 429 也会被当成账号问题，导致同账号的 `fireworks` 等后备 provider 永远不执行；切账号后又重复首选 provider。

这不是循环实现错误，而是当前“状态码直接映射账号动作”的契约带来的分类歧义。若产品期望 provider 429 先切 provider、明确账号额度才换账号，需要改变错误分类/优先级并补充测试，不能只增加重试次数。

## 最终取证步骤与最小证据

1. 用 `X-Cline-Request-Id` 同时读取 `/api/logs/requests?requestId=bdbad1a0-18e9-40b4-87fd-3affb4bbcfe9` 与 `/api/logs/errors?requestId=...`。请求日志用于核对账号路径和真实 attempt 总数；错误日志按 `attemptIndex` 核对每次 `targetProvider/providerPath/errorScope/scopeEvidence/accountAction`。
2. 任意读取一个 142 字节 body ID 对应的短期响应正文即可辅助区分 Cline 边缘页与结构化错误。捕获必须限时、脱敏且不写入持久化日志；现有 body 未提供，因此当前结论仍保持 unknown。
3. 核对生产该模型的账号级 `perModel` 与 `accountErrorRules[429]`，无需提供 Key/Header 值。

字段边界：`X-Cline-Target-Upstream` 是最终账号的规划候选顺序；`X-Cline-Attempts` 是跨账号的真实 HTTP 调用总数；`X-Cline-Actual-Upstream` 只表示响应中可解析的终态 provider。完整逐次路径只能以请求/错误日志为权威。本请求两个 attempt 分别属于账号5和账号3，已足以确认换号；没有同账号第三个 attempt，因此不能证明执行过 fireworks。
