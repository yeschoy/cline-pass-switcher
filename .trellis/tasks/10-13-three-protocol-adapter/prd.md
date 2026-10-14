# 三协议入站适配

## Goal

Switcher 对外同时提供三种入站协议，内部仍统一调用 Cline 上游 `/chat/completions`，使 Codex CLI 与 Claude Code 可直连 Switcher，不再依赖外部 NewAPI 转换层。新协议是**基于 Chat 上游的有损兼容子集**，不是原生 Responses / Anthropic 服务。

| 入站协议 | 路由 | 现状 |
|---|---|---|
| OpenAI Chat Completions | `/chat/completions`、`/v1/chat/completions`、`/api/v1/chat/completions` | 已支持，行为不变 |
| OpenAI Responses | `POST /v1/responses` | 固定 501（`server.js:5726`），改为支持 |
| Anthropic Messages | `POST /v1/messages`、`POST /v1/messages/count_tokens` | 不存在，新增 |

## Background

- 上游只有 Chat Completions（默认 `https://api.cline.bot/api/v1`），订阅模型均为 `cline-pass/*`（GLM、Kimi、DeepSeek、Qwen、MiniMax、MiMo）。
- `handleChat()`（`server.js:5350`）拥有正文解析、模型别名、会话身份、账号租约、Provider 链、流式透传、取消、统计和日志终结；流式路径把上游字节直接 pipe 给客户端（`server.js:5472-5591`）。
- 会话识别已能识别 Codex 与 Claude 请求特征（`server.js:3728-3772`），并按协议白名单转发 Header（`server.js:3808`）；模型别名为精确匹配（`server.js:696`）。
- 客户端鉴权只认 `Authorization: Bearer` 与旧 `X-Admin-Key`（`server.js:2542`）；Claude Code 使用 `ANTHROPIC_API_KEY` 时发送 `x-api-key`。
- 详细日志已把 `/v1/responses` 列入捕获路由（`lib/detailed-log-store.js:110`、`lib/detailed-log-capture.js:428`），`/v1/messages` 未列入。
- 9 月 18 日调研（`.trellis/tasks/archive/2026-09/09-18-response-chat-tool-protocol-error/research/switcher-responses-feasibility.md`、同目录 `design.md`）记录了 Responses-over-Chat 的边界与风险；当时因产品不接受有损子集而关闭。本任务产品已明确接受有损子集。

## Decisions

- D1 验收目标客户端：Codex CLI（Responses，`stream: true`、`store: false`）与 Claude Code（Messages）。在通用 SDK 规范之上，按两者真实请求形态兼容。
- D2 模型名：不新增映射机制。Claude Code 通过 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` 填 `cline-pass/*` 或现有精确别名，README 给示例；未配置的 `claude-*` 名照常走别名解析，上游模型不存在错误以 Anthropic 错误格式返回。
- D3 客户端执行的非 function 工具降级：Responses `custom`（apply_patch）→ Chat function，参数为单个字符串 `input`，grammar 定义附在描述里；`local_shell` → Chat function（`command` 字符串数组、`workdir`、`timeout_ms`、`env`）。模型调用后还原为 `custom_tool_call` / `local_shell_call`；历史中的这些项及其 output 同样双向映射。接受丢失 grammar 约束的风险。
- D4 托管/服务端工具（Responses `web_search*`、`file_search`、`code_interpreter`、`mcp`、`computer*`、`image_generation` 等；Anthropic 带 `type` 的 server tools，如 `web_search_*`、`web_fetch_*`、`code_execution_*`）：在账号租约和网络工作之前返回该协议格式的 400，消息写明工具类型。
- D5 推理内容：上游推理文本展示给客户端（Responses `reasoning` 输出项 summary；Anthropic `thinking` 块）。网关把推理文本编码进自有不透明格式的 `encrypted_content` / `signature`；回传时只有"最后一条真实用户消息之后"的 assistant 推理还原发往上游，更早轮次丢弃；非本网关签发的 `encrypted_content` / `signature` 静默丢弃。
- D6 `count_tokens`：本地启发式估算（ASCII 约 4 字符 / Token，CJK 约 1 字符 / Token，图片固定值），不占账号、不耗额度、不走网络、不新增依赖。

## Requirements

- R1 三协议均支持 `stream: true` 与非流式。
- R2 工具：Responses `function` + D3 降级工具；Anthropic 自定义工具（无 `type` 或 `type: "custom"`）、`tool_use`、`tool_result`（含 `is_error`）；与 Chat `tools` / `tool_calls` / `role: tool` 双向映射，保留调用 ID；`tool_choice` 与并行工具开关映射。
- R3 图片输入：Responses `input_image`（URL / data URL）、Anthropic `image`（`base64` / `url`）→ Chat `image_url`；`file_id`、`input_file`、Anthropic `document` 返回 400。
- R4 推理：按 D5 输出与回传；请求侧 Responses `reasoning.effort`、Anthropic `thinking.budget_tokens` best-effort 映射为 Chat `reasoning_effort`。
- R5 `POST /v1/messages/count_tokens` 按 D6 返回 `{ "input_tokens": N }`；需客户端鉴权，不写对话统计。
- R6 新协议复用现有客户端鉴权与账号池归属、账号租约、Provider 链、首包前重试与换号、取消、RPM、统计、会话粘性、普通日志与详细日志；不通过本机 HTTP 自调用。统计 usage 仍取自真实上游 Chat 数据。
- R7 不支持的能力在账号租约与网络工作之前返回该协议格式的 400：Responses `previous_response_id`、`conversation`、`background: true`、`store: true`、`context_management`、`prompt`、`item_reference` 及未知输入项类型；托管工具（D4）；文件输入（R3）。不改变状态语义的未知顶层字段忽略，以免客户端升级即失效。
- R8 错误格式按协议：Responses 使用 OpenAI 错误信封；Anthropic 使用 `{ "type": "error", "error": { "type", "message" } }`，并把状态码映射到 Anthropic 错误类型；鉴权 401、繁忙 429/503 同样按协议格式。
- R9 `/v1/messages` 与 `count_tokens` 额外接受 `x-api-key` 作为客户端密钥；与 `Authorization` 同时出现且不一致时拒绝。
- R10 现有 Chat Completions 三个路由的请求、响应、SSE 字节、统计与日志行为不变。
- R11 普通日志新增入站协议标识（`chat` / `responses` / `anthropic`），不新增任何正文内容；详细日志捕获路由加入 `/v1/messages`。
- R12 README 更新：三协议端点、支持子集与拒绝清单、Codex 与 Claude Code 接入示例（含 D2 的环境变量）；删除 "Responses 返回 501" 的旧表述。

## Acceptance Criteria

- AC1 `/v1/chat/completions` 现有全部测试不改断言即通过。
- AC2 Responses 非流式：文本、文本 + 多个 function 调用、custom / local_shell 降级还原、`finish_reason=length` → `status: incomplete`；`output` 与 `usage` 完整。
- AC3 Responses 流式：事件序列含 `response.created` … `response.completed`，`sequence_number` 单调；`response.completed.response.output` 与流内输出一致且非空；多工具参数分片正确聚合；推理以 summary 事件输出，`include` 含 `reasoning.encrypted_content` 时带 `encrypted_content`。
- AC4 Anthropic 非流式与流式：`message_start` → `content_block_*` → `message_delta`（含 `stop_reason` 与 usage）→ `message_stop`；thinking / text / tool_use 各块索引正确；`stop_reason` 映射 `end_turn` / `max_tokens` / `tool_use` / `stop_sequence`。
- AC5 推理回传：本网关签发的 `encrypted_content` / `signature` 在当前工具循环内还原为上游 assistant 消息的推理字段；更早轮次与非本网关签发的被丢弃；可用单测断言上游收到的 Chat body。
- AC6 R7 / D4 / R3 列出的每种不支持输入均在零上游请求、零账号租约下返回对应协议格式 400。
- AC7 首个上游事件前的失败按现有规则重试 / 换号；输出开始后的上游错误发送协议终止事件（Responses `response.failed`、Anthropic `event: error`）并只终结一次；客户端断开中止上游，记 499，租约释放一次。
- AC8 `x-api-key` 鉴权在 `/v1/messages` 生效；在 Chat 与 Responses 路由上不生效；两种凭据冲突时 401。
- AC9 `count_tokens` 不产生上游请求、不占账号、不进入对话统计，返回正整数。
- AC10 统计、健康度、普通日志在三协议下各计一次，usage 与上游 Chat 一致；普通日志带入站协议标识且无正文。
- AC11 `npm test`、`node --check`、`git diff --check` 通过；用真实 Codex CLI 与 Claude Code 各跑通一次"工具调用 → 工具结果 → 最终回答"的两轮循环（部署后手工验收）。

## Out of Scope

- Responses 有状态能力：`previous_response_id`、`conversation`、`store: true` 检索、`background`、retrieve / cancel / compact、WebSocket。
- 托管 / 服务端工具执行；Switcher 不执行任何工具。
- Files API、`file_id` 图片、PDF / document 输入、图片输出。
- Anthropic 格式的 `/v1/models`、Message Batches、Prompt caching 的 `cache_control` 语义（字段忽略）。
- 通配符 / 前缀模型别名（D2）。
- 新运行时依赖、持久化 schema 变更。
