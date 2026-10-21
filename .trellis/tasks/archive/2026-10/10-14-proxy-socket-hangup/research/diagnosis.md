# 诊断报告：proxy socket hang up / ≈60s 断连

日期：2026-10-14（生产只读，`167.114.158.4`，镜像 `20261014-f837905-empty-dash`）

## 结论（先看这个）

1. **字面 `socket hang up` 仍存在，但很少**：保留请求日志里仅 **2** 次请求命中规则 `proxy-socket-hangup`（`2026-10-13 19:17` / `19:19` UTC），账号 `zxg-10.13-04`，出口 `socks5://egress-W2:1080`。同一请求内多个 Provider（deepseek→fireworks→alibaba）连续 `upstreamStatus=0`、约 60s。
2. **更大一簇是「约 60s + transport_proxy」**，多数 **没有** `proxy-socket-hangup` 规则 ID：48h 内约 **46** 个 `errorCategory=proxy` 失败请求、约 **101** 次 ≈60s/`upstreamStatus=0` attempt。主峰在已删除的 `zxg-10.13-03`，其次 `zxg-10.13-04`（同属 `egress-W2`）及少量其它出口。
3. **与代码同形**：`server.js` 里 `proxyAgentOptions.timeout = 60_000`。SOCKS keep-alive 空闲/无进展约 60s 被掐断时，若错误文案不含 `socket hang up`，不会命中 hang 规则，但仍记为 `failureClass=network` + `scopeEvidence=transport_proxy`。
4. **不是全站代理池整体炸掉**：各 SOCKS 出口 48h 总失败率约 1.5%–5.7%，大部分失败是普通 `errorCategory=upstream`（780 vs proxy 46）。Hang/≈60s 传输失败是 **出口/账号侧偶发尖峰**，不是 switcher 逻辑全面回归。
5. **规则 `action=ignore` + account scope**：hangup 后仍在 **同一账号** 上换 Provider 重试，坏代理会被乘以渠道数（常见 3×≈60s），放大用户可见延迟。这是处置语义，不是 hangup 的根因。
6. **本任务范围（用户选 1）**：只出诊断与建议，**不改代码、不动生产配置**。

## 信号三分法

| 信号 | 识别 | 48h 量级 | 含义 |
|------|------|----------|------|
| A. 字面 hang up | `ruleId=proxy-socket-hangup` 或 reason 含 `socket hang up` | 2 请求 | SOCKS/上游连接被对端掐断，文案匹配规则 |
| B. ≈60s 代理传输失败 | `errorCategory=proxy`，attempt ≈55–65s，`upstreamStatus=0`，`transport_proxy` | ~46 请求 / ~101 attempt | 与 Agent `timeout:60s` 同形；多数无 hang 规则 ID |
| C. 普通上游失败 | `errorCategory=upstream` 等 | ~780 | 与本次 hangup 排查无关的业务/渠道错误 |

普通 `errors-*.jsonl` 当前为空，证据来自 `requests-*.jsonl` 的 attempt 投影。

## 账号 / 出口建议（运维向，本任务不执行）

优先关注：

- **`socks5://egress-W2:1080`**：唯一确认的 hang 规则命中出口；仍挂在启用账号 `zxg-10.13-04`（以及未出 hang 的 `10.11-03` / `10.11-05` 等）。建议单独探活该出口；若持续 ≈60s/`transport_proxy`，换出口或暂时避开该出口上的重负载账号。
- **历史 `zxg-10.13-03`**：≈60s proxy 尖峰主账号，配置中已不存在——说明删号有效降低了后续 hang 可见量，但不能证明出口本身已健康。
- **其它出口**（`egress-O2`、`<proxy-domain>:<port>`、`egress-W1`、`egress-Z1`）：有常规失败，但 hang 规则未命中；不必因本次 hangup 一律替换。

回看指标（运维自检）：

- 请求日志中 `ruleId=proxy-socket-hangup` 计数
- `errorCategory=proxy` 且 attempt ≈60s 的请求数
- 按 SOCKS host（非凭证）聚合的上述计数

## 若将来做代码（明确不在本次交付）

可选方向（仅记录，不实施）：更短的代理 connect/idle 分类、hangup 时换账号而非同账号换 Provider、把 Agent 60s 超时与字面 hang up 在日志里分开投影。需另开任务。

## 证据边界

- 只读 SSH + `data/logs`；未改配置、未重启、未打真实探测流量。
- 部署后短窗口无新 hang，**不能**据此宣称已修复。
- 未在报告中记录任何代理账号密码或完整带凭证 URL。
