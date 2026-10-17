# 请求日志：计划/实际上游、用量 Token、默认浅色

## Goal

运维在请求日志中一眼看到「计划钉住的上游」与「回包实际渠道」、本请求输入/输出/缓存 Token，并在默认浅色控制台下完成日常排查。

## Background

- 后端已投影 `targetProviders` / `actualProvider`，但 UI「供应商路径」列用计划盖住实际。
- 用量已进统计聚合，普通请求 JSONL 仅有 `cacheHit` 三态，无按请求 Token 计数。
- 控制台 `:root` 硬编码深色；用户要求默认白色系（参考 ClinePassBridge 浅色观感，不要求像素级复刻）。

## Requirements

1. **两列上游**：请求日志拆成「计划上游」「实际上游」；计划来自 `targetProviders`（空→「自动」）；实际来自 `actualProvider`（缺→「未知」，不得用计划冒充）；有计划时比对首个目标与实际，用既有 `match`/`mismatch`。
2. **错误日志**：展示该次盯住目标（`targetProvider` / 路径）；实际有则显示，否则「未知」。
3. **用量投影**：新请求在普通 JSONL 写入有界 `inputTokens` / `outputTokens` / `cachedTokens`（非负整数或 null）；规则与 `normalizeUsage` / 统计同源；缺失≠0；历史行兼容未报告。
4. **用量列 UI**：主行 `输入 / 输出`；次行缓存 Token，可算时附占比；不做 TTFT 条与 `t/s`；可选轻量展示已有 `durationMs`。
5. **默认浅色**：整站改 CSS 变量为浅色系（卡片/表/按钮/抽屉/弹层等依赖变量的表面）；**不做**暗色切换器与偏好持久化。
6. 契约：`ui-contract` 列数/colspan、logging-guidelines、相关集成测试同步；敏感边界不变。

## Out of scope

- `provider_source`；改钉住/`only`/`order` 策略；Bridge 摘要卡/TTFT/`t/s`；暗色主题切换；统计页/工作流重构。

## Key decisions

| ID | 决定 |
|---|---|
| D1 | 计划/实际拆两列表头 |
| D2–D5 | 默认唯一浅色（无切换）；用量 MVP 仅 Token |

## Acceptance Criteria

- [x] 请求日志两列同时可见计划与实际；有计划时实际不被隐藏；命中样式正确。
- [x] 新产生且上游回报 usage 的请求行可见输入、输出、缓存 Token；缺失显示未报告而非 0；无 TTFT/`t/s`。
- [x] 控制台默认即为浅色，主要板块无深色花斑；无暗色切换控件。
- [x] 相关 `ui-contract` / 日志投影 / 集成测试通过；不引入 `provider_source`；不改变单元素 `only`。
