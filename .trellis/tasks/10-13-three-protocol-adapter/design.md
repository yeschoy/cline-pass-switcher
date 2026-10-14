# 三协议入站适配 — 技术设计

## 1. 边界

```text
POST /v1/responses | /v1/messages
  -> dispatch: 设置 res.protocolAdapter（鉴权前，401 也按协议格式）
  -> 客户端鉴权（/v1/messages 额外接受 x-api-key）
  -> handleChat(req, res, clientKeyId, adapter)
       readBody -> JSON.parse -> adapter.toChat(body)   // 失败: 协议 400，零租约零网络
       -> 现有流程（模型别名、会话身份、租约、runChatChain、重试、统计、日志）
       -> 非流式: adapter.fromChat(out) / adapter.errorBody(...)
       -> 流式:   上游 Chat SSE -> ChatSseReader -> adapter 流编码器 -> res
POST /v1/messages/count_tokens
  -> 鉴权 -> anthropic.toChat(body) -> estimateTokens(chatBody) -> { input_tokens }
```

不通过本机 HTTP 自调用；不复制账号 / Provider / 统计逻辑。Chat 路由传 `adapter = null`，走原有字节透传分支（R10）。

### 新模块（纯函数，无网络 / 配置 / 账号依赖）

| 文件 | 职责 |
|---|---|
| `lib/protocol-common.js` | `AdapterError`（`status`、`type`、`param`、`code`、`message`）；Chat SSE 增量解析器 `createChatSseReader()`（UTF-8 / 事件边界碎片安全，解包 `{data: …}` 外壳，`[DONE]` 识别）；Chat 流聚合器（text / reasoning / tool_calls 按 index 累积，finish_reason，usage）；推理令牌 `encodeReasoning({text, field})` / `decodeReasoning(token)`；`estimateTokens(chatBody)`；ID 生成 |
| `lib/responses-adapter.js` | `responsesToChat(body)`、`chatToResponses(chatJson, ctx)`、`createResponsesStreamEncoder(ctx)`、`responsesErrorBody(status, err)` |
| `lib/anthropic-adapter.js` | `anthropicToChat(body)`、`chatToAnthropic(chatJson, ctx)`、`createAnthropicStreamEncoder(ctx)`、`anthropicErrorBody(status, err)` |

每个 adapter 导出统一形状：

```js
{ protocol: 'responses' | 'anthropic',
  toChat(body) -> { chatBody, identityHints, ctx },      // 抛 AdapterError
  fromChat(chatJson, ctx) -> object,
  errorBody(status, { message, type, param, code }) -> object,
  createStreamEncoder(ctx) -> { start() -> string, push(chatEvent) -> string, finish({ aborted }) -> string, fail(error) -> string, heartbeat() -> string } }
```

`ctx` 包含：请求的原始 `model` 名（回显给客户端）、工具降级映射表（函数名 → 原类型 custom / local_shell）、`include` 是否要求 `encrypted_content`、生成的响应 ID、`created_at`。

## 2. `server.js` 改动点

1. **路由**：`dispatch` 中 `modelRoute` 加入 `/v1/messages`、`/v1/messages/count_tokens`；删除 `/v1/responses` 的 501 分支；在鉴权前按路径设置 `res.protocolAdapter`。
2. **鉴权**：`clientKeyIdFor(req, { allowApiKey })`，仅 Anthropic 路由允许 `x-api-key`，与 `Authorization` 冲突返回 null（沿用 `X-Admin-Key` 冲突规则）。`x-api-key` 已不在任何转发白名单内，确认不会转发上游。
3. **错误格式**：`sendJSON` / `sendBusy` 在 `res.protocolAdapter` 存在且状态 ≥ 400 时，用 `adapter.errorBody(status, obj.error)` 替换正文；`Retry-After` 等 Header 不变。`unauthorized()` 因走 `sendJSON` 自动生效。
4. **`handleChat(req, res, clientKeyId, adapter = null)`**：
   - JSON 解析和对象校验后，若有 adapter：`const { chatBody, identityHints, ctx } = adapter.toChat(body)`，`AdapterError` → `sendJSON(res, err.status, …)` 并 return（此时未取租约）。随后 `body = chatBody`。
   - `requestedModel` 取自 chatBody.model（adapter 原样复制）；`sensitiveMessageValues` 在转换后的 Chat body 上计算，因此覆盖 instructions / system / tool 输出。
   - 会话身份：`extractSessionIdentity(req, { ...body, ...identityHints })`，Anthropic 的 `identityHints = { metadata: { user_id } }`，使 Claude 会话识别与现状一致；`identityHints` 不进入上游 body。`forwardHeadersFor` 同样传入合并视图。
   - 普通日志 `recordChat` 增加 `inboundProtocol: adapter?.protocol || 'chat'`，并在日志投影白名单中登记该字段（见 `.trellis/spec/backend/logging-guidelines.md`）。
5. **非流式输出**：`status === 200` 时 `res.end(JSON.stringify(adapter.fromChat(safeOut, ctx)))`；否则 `adapter.errorBody(status, safeOut.error)`。`X-Cline-*` Header 保留。`!out` 分支走 `sendJSON` 自动转换。
6. **流式输出**（仅 adapter 分支，Chat 分支代码不动）：
   - `writeHead` 使用 `Content-Type: text/event-stream; charset=utf-8`，不复用上游 content-type。
   - 原始上游字节仍先进 `observer.push()`（统计、错误判定、usage 不变）。
   - 同一字节再进 `ChatSseReader`，每个完整 Chat 事件交给编码器 `push()`，编码结果非空才 `writeDownstream`。`chain.streamHead` 同样两路处理；编码器 `start()` 在写第一段前输出（Responses `response.created` + `response.in_progress`；Anthropic `message_start`）。
   - 心跳：编码器输出总在事件边界，`atEventBoundary` 在 adapter 分支恒为 true；心跳内容为 `encoder.heartbeat()`（Responses `: PING\n\n`；Anthropic `event: ping\ndata: {"type":"ping"}\n\n`）。
   - 终结：`final` 时若观察到上游错误 → `encoder.fail(observed.errorPayload)`；若无 `finish_reason` 也无 `[DONE]` → `encoder.fail('stream ended before completion')`；否则 `encoder.finish()`。上游传输错误时先尝试 `writeDownstream(encoder.fail(...))` 再 `res.end()`，而不是直接 destroy（仅 adapter 分支；客户端断开仍 destroy）。`finalize()` 的一次性守卫保持不变，统计 / 日志 / 租约释放仍只发生一次。
   - 背压：沿用现有 `blocked` / `onDrain` 机制；一个上游 chunk 可能编码为多个事件，合并成一次 write。
7. **`count_tokens`**：新分支，鉴权后读 body（同 50 MiB 上限）→ `anthropicToChat` 校验 → `estimateTokens` → 200。不记录对话日志、不取租约。
8. **详细日志**：两个 lib 文件的捕获路由集合加入 `/v1/messages`（不含 count_tokens）。下游正文由 `res.write` 包装自动捕获转换后的协议输出；出站 Chat 正文由现有 attempt 捕获；入站为原始正文。三者天然分离。

## 3. Responses ↔ Chat 映射

### 请求

| Responses | Chat |
|---|---|
| `instructions` | 首条 `system` 消息 |
| `input: string` | `user` 消息 |
| message item（role `user` / `assistant` / `system` / `developer`；content string 或 `input_text` / `output_text` / `input_image` / `refusal`） | 同角色消息；`developer` → `system`；`input_image.image_url` → `{type:'image_url', image_url:{url, detail}}`；`file_id` → 400 |
| `function_call` | assistant `tool_calls[]`（相邻的 assistant 文本 / 推理 / 调用合并为一条 assistant 消息） |
| `function_call_output` | `role: tool`，`tool_call_id = call_id`，output 为字符串或内容数组时拼接文本 |
| `custom_tool_call` / `_output` | 同上，arguments = `JSON.stringify({input})` |
| `local_shell_call` / `_output` | 同上，arguments = `JSON.stringify(action 去掉 type)` |
| `reasoning` | 若 `encrypted_content` 为本网关令牌且位于最后一条 user message item 之后 → 挂到其后紧邻 assistant 消息的推理字段（字段名按令牌记录的 `reasoning_content` / `reasoning`）；否则丢弃 |
| `tools[type=function]` | `{type:'function', function:{name, description, parameters, strict}}` |
| `tools[type=custom]` | function，参数 `{input: string}`，描述追加 `format` 定义 |
| `tools[type=local_shell]` | function `local_shell`，参数 `{command: string[], workdir?, timeout_ms?, env?}` |
| 其他 tool type | 400，`param: tools[i].type` |
| `tool_choice` `auto` / `none` / `required` / `{type:function|custom, name}` | 同义映射；`allowed_tools` 等其他形态 → 400 |
| `parallel_tool_calls`、`temperature`、`top_p`、`user`、`prompt_cache_key` | 透传 |
| `max_output_tokens` | `max_tokens` |
| `text.format` `json_object` / `json_schema` | `response_format`；`text.verbosity` 忽略 |
| `reasoning.effort` | `reasoning_effort`（`minimal` → `low`，`none` 不发送） |
| `stream` | `stream` + `stream_options: {include_usage: true}` |
| `include`、`store: false`、`metadata`、`service_tier`、`client_metadata`、`safety_identifier`、未知字段 | 忽略 |
| `previous_response_id`、`conversation`、`background: true`、`store: true`、`context_management`、`prompt`、`item_reference`、未知 item type | 400 |

每个 call_id 必须先有调用后有输出；孤立 output 或重复 call_id → 400（Chat 上游对此会 400，提前拒绝避免占用账号）。

### 响应

- 非流式：`{id:'resp_…', object:'response', created_at, status, model: 请求原名, output:[…], usage, incomplete_details, error:null, parallel_tool_calls, tool_choice, tools, …}`。输出顺序：reasoning（如有）→ message（文本非空时，含 `output_text`，`annotations: []`）→ 各工具调用（按 Chat index；按降级表还原类型）。
- `finish_reason`：`stop` / `tool_calls` → `completed`；`length` → `incomplete`（`reason: max_output_tokens`）；`content_filter` → `incomplete`（`reason: content_filter`）。
- usage：`input_tokens = prompt_tokens`，`output_tokens = completion_tokens`，`total_tokens`，`input_tokens_details.cached_tokens`、`output_tokens_details.reasoning_tokens` 仅在上游提供时出现；上游无 usage 时 `usage: null`。
- 流式事件（每个事件 `event: <type>\ndata: <json>\n\n`，`sequence_number` 从 0 单调递增）：
  - `response.created`、`response.in_progress`
  - 推理：`output_item.added(reasoning)` → `reasoning_summary_part.added` → `reasoning_summary_text.delta`* → `reasoning_summary_text.done` → `reasoning_summary_part.done` → `output_item.done`（带 `encrypted_content` 如需）
  - 文本：`output_item.added(message)` → `content_part.added` → `output_text.delta`* → `output_text.done` → `content_part.done` → `output_item.done`
  - function：`output_item.added(function_call)` → `function_call_arguments.delta`* → `function_call_arguments.done` → `output_item.done`
  - custom / local_shell：参数在上游完成前不能还原，于 done 时一次性发 `output_item.added` →（custom 发 `custom_tool_call_input.delta` + `.done`）→ `output_item.done`
  - 终止：`response.completed` / `response.incomplete`（含完整 output 与 usage）；失败 `response.failed`（`response.error = {code, message}`）
  - 切换规则：推理块在首个文本 / 工具增量到来时关闭；文本块在首个工具增量到来时关闭；多个工具按首次出现顺序各占一个 output_index，参数增量按 index 路由，全部在终止前依次 done。

## 4. Anthropic ↔ Chat 映射

### 请求

| Anthropic | Chat |
|---|---|
| `system` string / text blocks | 首条 `system`（`cache_control` 忽略） |
| user `text` / `image(base64→data URL, url)` | user content parts |
| user `tool_result` | 每个 → `role: tool`（`content` 文本拼接；`is_error: true` 时前缀 `[tool error] `）；块内图片和同消息的其余 text / image 放在 tool 消息之后的一条 user 消息 |
| assistant `text` / `tool_use` | 一条 assistant 消息（content 文本拼接 + `tool_calls`，arguments = `JSON.stringify(input)`） |
| assistant `thinking` | 若 `signature` 为本网关令牌且位于当前工具循环 → 推理字段；否则丢弃；`redacted_thinking` 丢弃 |
| `document`、`search_result`、`container_upload` 等 | 400 |
| `tools[]` 无 `type` 或 `type:'custom'` | function（`input_schema` → `parameters`） |
| 其他 `type` 的工具 | 400 |
| `tool_choice` `auto` / `any` / `tool` / `none`，`disable_parallel_tool_use` | `auto` / `required` / `{type:function,function:{name}}` / `none`，`parallel_tool_calls: false` |
| `max_tokens`、`temperature`、`top_p`、`top_k` | 透传（`max_tokens` 缺失时不发送） |
| `stop_sequences` | `stop` |
| `thinking: {type:'enabled', budget_tokens}` | `reasoning_effort`：`< 4096` low，`< 16384` medium，否则 high；`disabled` 不发送 |
| `metadata.user_id` | 仅进入 `identityHints`，不发上游 |
| `stream` | `stream` + `stream_options: {include_usage: true}` |
| `service_tier`、`container`、`mcp_servers`、未知字段 | `mcp_servers` 非空 → 400；其余忽略 |

"当前工具循环"：最后一条包含非 `tool_result` 内容的 user 消息之后的所有 assistant 消息。

### 响应

- 非流式：`{id:'msg_…', type:'message', role:'assistant', model: 请求原名, content:[thinking?, text?, tool_use…], stop_reason, stop_sequence:null, usage:{input_tokens, output_tokens, cache_read_input_tokens?}}`。
- `finish_reason`：`stop` → `end_turn`（若命中 `stop_sequences` 无法判定，统一 `end_turn`）；`length` → `max_tokens`；`tool_calls` → `tool_use`；`content_filter` → `refusal`。
- usage：`input_tokens = prompt_tokens − cached`，`cache_read_input_tokens = cached`（上游提供时）；上游缺失时客户端可见值填 0（Anthropic schema 要求整数），统计仍按上游真实缺失处理。
- 流式：`message_start`（usage 输入 0）→ 按到达顺序 `content_block_start` / `content_block_delta`（`thinking_delta`、`text_delta`、`input_json_delta`）/ `content_block_stop`，thinking 块在 stop 前发 `signature_delta`（本网关令牌）→ `message_delta`（`stop_reason`、usage 含 `input_tokens` / `output_tokens` / `cache_read_input_tokens`）→ `message_stop`。失败：`event: error` + `{type:'error', error:{type, message}}`。
- 错误类型：400 `invalid_request_error`、401 `authentication_error`、403 `permission_error`、404 `not_found_error`、413 `request_too_large`、429 `rate_limit_error`、503 / 529 `overloaded_error`、其他 `api_error`。

## 5. 推理令牌

- 格式：`clps1.` + base64url(JSON `{t: text, f: 'reasoning_content' | 'reasoning'}`)。不加密、不签名：内容本就来自同一客户端会话，篡改只影响调用方自己的请求。识别前缀与可解码性；失败即丢弃。
- 上游推理字段读取顺序：`delta.reasoning_content`、`delta.reasoning`（字符串）；`reasoning_details` 中 `type: reasoning.text` 的 `text` 作为兜底。记录实际来源字段写入令牌，回传时写回同名字段。
- 不展示时（上游无推理）不生成 reasoning 项 / thinking 块。

## 6. Token 估算

`estimateTokens(chatBody)`：遍历 messages 的文本、tool_calls arguments、tools 的 JSON，ASCII 字符数 / 4 + 非 ASCII 字符数，向上取整；每条消息加 4、每张图片加 1000；结果至少 1。只用于 `count_tokens`。

## 7. 兼容性与回滚

- Chat 路由代码路径不变（`adapter === null` 时所有新分支跳过）。
- 无持久化 schema 变更；普通日志新增一个可选字段，旧镜像读取时忽略。
- 回滚：恢复 `/v1/responses` 501、移除 `/v1/messages` 路由即可；数据目录无需处理。

## 8. 风险

- 流编码器状态机错误会让客户端拿到空回复或挂起：用逐事件快照测试覆盖碎片化输入、多工具交错、无 finish、错误中断。
- custom 工具丢 grammar：apply_patch 可能格式错误；Codex 会把工具错误回传给模型重试，可接受。
- Claude Code 新版可能发送新的 beta 块类型：未知块类型统一 400 并写明类型，便于定位。
- 推理回传增加输入 Token：限定当前工具循环。
