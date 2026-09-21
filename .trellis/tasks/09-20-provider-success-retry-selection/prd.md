# 单渠道健康与重试选择

## Goal

在现有 singleton Provider attempt owner 上实现两种明确策略：strict 首次遵循用户首选、后续按渠道+模型成功率；preferred/智能从首次起由 Switcher 按成功率自动选择。同时新增独立、有序的重试判定配置，使确定性请求错误可按 normalized status 与安全正文条件立即停止剩余 Provider/账号尝试。所有重试逐次排除已尝试项且每个 HTTP attempt 只钉一个 Provider。

## Background

父任务：`../09-20-scoped-error-rules-dynamic-routing/`。依赖 `09-20-scoped-error-rules-success-rate` 已提供 Provider-model success rate、cooldown/quarantine 和 rule action contract。后续生产排查确认现有显式 `cooldown`/`hard-quarantine` 只写处置状态、不写失败样本，导致冷却错误不降低直接成功率；用户已确认本任务先收敛该语义，再让选择器消费修正后的 rate。

另发现确定性请求错误可能被上游包装成 502，例如响应错误 message 含 `system message must have content`。当前 `runChatChain()` 对此仍遍历剩余 Provider，既不能修复请求，又增加延迟/请求量。用户确认新增独立 retry policy：status 与 body 条件 AND 匹配后停止全部剩余重试，并通过配对的健康规则忽略 Provider 惩罚。

## Requirements

1. 候选来源：configured 非空时权威，否则 stable discovered；static exclude、hard quarantine、active cooldown 先过滤。
2. strict 首次选择来源顺序首个可用 Provider；失败后排除本请求已尝试项，再按 Provider-model 24h success rate 降序选择，null最后、同率按来源顺序。
3. preferred 兼容值作为 Switcher 智能模式，从首次起按相同健康顺序选择；不委托 Cline 网关做不透明多 Provider 回退。
4. 每次 named HTTP attempt 只在 planner/direct/unknown pipeline 注入同一个单元素 `only`，删除所有 `order`；`sort` 只作用于已选 Provider 内部。
5. 完全无 configured/discovered 候选时只允许一次 unattributed auto；有候选但全被 exclude/hard/cooldown 阻止时安全失败，不绕过。
6. `maxRetries` 限制 outer attempts；每次失败后重算剩余候选。retry classification 与 rule health action 分离。
7. Provider scope cooldown/quarantine 继续同账号下一 Provider；account scope removal 才可首包前最多换一次账号。Authorization 不跨账号混用。
8. stream 首事件后不重放；取消停止重试且无状态/健康副作用。
9. 日志/Headers/UI 明确 strict-first、health-selected、compat-auto、计划与真实路径，不把候选或网关不可见行为当实际 Provider。
10. 规则动作与直接健康样本语义固定为：`ignore`不记样本且不处置；`degrade`记一次失败样本；`cooldown`记一次失败样本并临时跳过；`hard-quarantine`记一次失败样本并持续隔离。Provider-model scope按每个具名真实attempt最多一次，account scope沿用每请求/账号去重且失败优先；取消、管理流量、unattributed auto、stale generation均不记样本。
11. 新增顶层 canonical `retryRules` 有序数组。每条规则必须有稳定唯一 ID、`decision: "stop"`，以及同时存在的 `when.statuses` 与 `when.body_contains`；两类条件 AND，body 数组内部 ANY，匹配为大小写不敏感普通文本，不支持正则。
12. `retryRules` 第一条命中即停止；无命中保持当前继续尝试的兼容默认。stop 在首包前同时阻止同账号剩余 Provider 与账号 replacement，保留原始最终 status/body；已开始 SSE、取消和无剩余候选不产生额外 replay。
13. Retry decision 与健康动作保持独立。内置“system message must have content”预设同时生成 `retryRules: stop` 与相同 status/body 条件的 provider-model `errorRules: ignore`，从而停止重试且不降低 Provider 成功率；自定义 retry rule 不隐式修改健康。
14. `retryRules` 完整严格验证、启动默认、管理 API/旧客户端保留、browser draft/raw editor/preset 和持久化 round-trip 必须一致。普通日志只投影 bounded rule ID、decision 和 `status/body` 命中类型，不记录正文 needle、匹配片段、Header/body 或凭据。

## Acceptance Criteria

- [ ] `ignore/degrade/cooldown/hard-quarantine`分别产生0/1/1/1个失败样本；后两者同时保持临时/持续处置，非目标scope、取消、auto和stale completion无样本，SSE post-start finalizer不重复计数。
- [ ] `retryRules` 对 `502 AND body contains system message must have content` 命中 stop，只发送一个真实 attempt，不切 Provider/账号，且配对 ignore 后不增加 Provider degrade；仅 status 或仅 body 命中均继续兼容重试。
- [ ] 多条 retry rule first-match、body ANY/大小写、严格字段/大小/重复 ID/缺失条件、旧客户端 omission 保留和 restart round-trip 均确定；日志/UI不泄漏 needle 或匹配正文。
- [ ] strict 首试为用户首个可用渠道，后续真实顺序由 success rate 决定并排除已尝试项。
- [ ] preferred 从首试起按 success rate；null/tie 行为确定且模型隔离。
- [ ] planner/direct/unknown 每个 named payload 只有相同 singleton `only` 且无 `order`。
- [ ] configured/discovered/exclude/all-hard/no-known/maxRetries 行为安全确定。
- [ ] account/provider actions、retry stop、换号上限、Authorization、stream/cancel/finalizer 边界保持。
- [ ] 日志和 UI 投影有策略/重试证据但无原始会话、规则匹配值、Header/body 或凭据。
- [ ] 聚焦测试、全量项目门禁与相关 spec/docs 更新通过。

## Out of Scope

- 账号成功率流水线与动态热池。
- 跨 Provider 成本/TTFT/TPS 综合评分。
- retry 延迟、指数退避、正则条件或 Header 条件。
- 修改 NewAPI 重试实现。
- 生产部署。
