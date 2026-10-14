# PRD: 请求日志亲和文案 — 请求体会话键

## 背景

请求日志「亲和键/上游键/缓存」列把 `upstreamPromptCacheKeySource=none` 显示成「上游未提供」，易被理解成「Cline 没有返回」。实际含义是：Switcher 没有把 `prompt_cache_key` / `session_id` 写入发给 Cline 的请求体（Header 仍可能已转发）。

本任务只改控制台展示文案，不改会话提取、Header 透传、body 注入或 NewAPI 配置。

## 目标

让运营/排障人员一眼看出「请求体有没有会话键」，而不会误以为上游没响应。

## 非目标

- 不把 generic `X-Session-Id` 写入 body / 派生 `prompt_cache_key`
- 不改 NewAPI 渠道 `param_override`
- 不改日志 JSON 字段名或枚举值（仍用 `upstreamPromptCacheKeySource` / `upstreamPromptCacheKeyApplied`）
- 不改表头业务语义以外的布局（若表头「上游键」同样误导，可一并改为「请求体键」）
- **不得展示、截断展示或暗示具体会话键值**：包括原始 `session_id` / `prompt_cache_key` / Header 值、派生上游键、HMAC 指纹（含前缀）、绑定命中的具体 identity。界面与普通日志仍只允许有界枚举（键类型、置信度、写入来源、绑定命中/未命中、缓存三态），与现有 logging 边界一致。

## 文案约定

`affinityLogLabel` 中「上游 …」段改为「请求体会话键 …」：

| `upstreamPromptCacheKeySource` | 现文案片段 | 新文案片段 |
|---|---|---|
| `none` | 上游 未提供 | 请求体会话键 未写入 |
| `caller_prompt_cache_key` | 上游 caller prompt_cache_key（已提供） | 请求体会话键 caller prompt_cache_key |
| `caller_session_id` | 上游 caller session_id（已提供） | 请求体会话键 caller session_id |
| `caller_invalid` | 上游 caller 字段非法 | 请求体会话键 caller 字段非法 |
| `derived_codex` | 上游 派生 Codex key（已提供） | 请求体会话键 派生 Codex key |
| `derived_claude` | 上游 派生 Claude key（已提供） | 请求体会话键 派生 Claude key |

有合法键时不再依赖「（已提供）」后缀强调（字段已在文案中体现）；非法/未写入仍要明确。

表头若仍为「亲和键/上游键/缓存」，改为「亲和键/请求体键/缓存」。

## 验收标准

- [x] 请求日志亲和列不再出现「上游未提供」作为 `none` 的展示。
- [x] `none` 显示为含「请求体会话键」与「未写入」的文案。
- [x] caller / derived 来源仍可区分，且不声称 Cline 实际采用了该键。
- [x] 表头与列文案一致使用「请求体键」语义。
- [x] 亲和列与请求详情展开 JSON **均不出现**具体会话键/指纹值；只保留现有安全枚举字段。
- [x] `test/ui-contract.test.js`（及相关契约断言）通过；不引入行为/转发逻辑变更。
- [x] 服务端日志投影字段与枚举不变。
