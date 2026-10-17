# 网关 HTML 429 诊断与规则可见性

## Goal

固化 HTML 429（`gateway_html_throttle`）诊断结论；将进程内 backoff 从「按出口/代理」改为「按账号」；对外文案可识别为限流类错误。是否真为出口 IP 限流**未证实**，本任务不以此为设计前提，另作待研问题记录。

## Confirmed facts

- 截图时段 NewAPI 为 UTC；上游 HTTP 429 + `text/html`（~142B）→ NewAPI `invalid error response`。
- 当前实现：`gatewayEgressKey = account.proxyUrl || ''`，同代理（或全体直连）共用 backoff；配置 `errorRules` 被 gateway 短路绕过。
- 证据：`research/diagnosis-20261018.md`。

## Product decisions（已确认）

1. **Backoff 按账号**，不再按 `proxyUrl` / 空键共享。账号 A 撞 HTML 429，不应拖住同代理上的账号 B。
2. **「是否 IP 限流」不清楚** → 记入待研，不作为本次改动的论证前提；也不因此去「换出口/换代理」优化。
3. 仍可改对外文案，避免只看到笼统 invalid response。

## Requirements

1. HTML 429（现有 `isGatewayThrottle` 条件）触发的进程内 backoff，必须以**账号身份**为键（稳定 account id），不得再用 `proxyUrl` 或空字符串把多账号绑在同一窗口。
2. 同窗口并发拒绝仍可共享**该账号**自己的窗口；升档/上限/jitter 语义可保持现有量级（约 1s→8s），除非实现时证明必须微调。
3. 成功清除 backoff 时只清**该账号**窗口。
4. 不因此把 HTML 429 重新挂到 `general-429` 等配置规则去做 durable cooldown / 健康降级 / 硬隔离（除非后续另开任务）；本任务只改进程内 backoff 粒度 + 可观察文案。
5. 自动化测试：同代理两账号时，其一 HTML 429 不得迫使另一账号等待同一 gateway 窗口；对外文案可识别限流。

## Open research（非本任务交付）

- 生产上此类 HTML 429 是否确实按出口 IP / 共享代理限流，尚无结构化证据；需另开观测或对照实验，不能从当前分类器名称反推。

## Out of Scope

- 证实或否定「IP 限流」假说的实验设计与生产压测。
- 撞限流后自动换代理 / 换账号策略。
- 让配置 `errorRules` 声明式命中并 durable cooldown（可另开任务）。
- 修改 NewAPI 源码。

## Acceptance Criteria

- [ ] 诊断与「IP 限流未证实」待研记录保留在任务 `research/`
- [ ] gateway HTML 429 backoff 按账号键；同代理其它账号不被连带暂停
- [ ] 既有「不 durable 冷却账号/Provider、同 Provider 一次退避重试」行为在单账号路径上仍成立（测试覆盖）
- [ ] 对外错误文案不再仅用笼统 `invalid error response`
- [ ] 相关 spec（quality / logging）与 `proxyUrl` 键假设同步修订

## Notes

- 状态：`planning`。实现须等规划总结获批后 `task.py start`。
