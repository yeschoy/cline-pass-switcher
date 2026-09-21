# 单渠道健康重试选择

## Goal

在现有 singleton Provider attempt owner 上实现两种明确策略：strict 首次遵循用户首选、后续按渠道+模型成功率；preferred/智能从首次起由 Switcher 按成功率自动选择。所有重试逐次排除已尝试项且每个 HTTP attempt 只钉一个 Provider。

## Background

父任务：`../09-20-scoped-error-rules-dynamic-routing/`。依赖 `09-20-scoped-error-rules-success-rate` 已提供 Provider-model success rate、cooldown/quarantine 和 rule action contract。后续生产排查确认现有显式 `cooldown`/`hard-quarantine` 只写处置状态、不写失败样本，导致冷却错误不降低直接成功率；用户已确认本任务先收敛该语义，再让选择器消费修正后的 rate。

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

## Acceptance Criteria

- [ ] `ignore/degrade/cooldown/hard-quarantine`分别产生0/1/1/1个失败样本；后两者同时保持临时/持续处置，非目标scope、取消、auto和stale completion无样本，SSE post-start finalizer不重复计数。
- [ ] strict 首试为用户首个可用渠道，后续真实顺序由 success rate 决定并排除已尝试项。
- [ ] preferred 从首试起按 success rate；null/tie 行为确定且模型隔离。
- [ ] planner/direct/unknown 每个 named payload 只有相同 singleton `only` 且无 `order`。
- [ ] configured/discovered/exclude/all-hard/no-known/maxRetries 行为安全确定。
- [ ] account/provider actions、换号上限、Authorization、stream/cancel/finalizer 边界保持。
- [ ] 日志和 UI 投影有策略证据但无原始会话、规则匹配值、Header/body 或凭据。
- [ ] 聚焦测试、全量项目门禁与相关 spec/docs 更新通过。

## Out of Scope

- 账号成功率流水线与动态热池。
- 跨 Provider 成本/TTFT/TPS 综合评分。
- 生产部署。
