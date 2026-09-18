# Switcher Responses Compatibility Design（Draft）

## Status

Closed by product decision. The user accepted that Switcher will not implement the lossy Responses compatibility layer. No implementation plan or business-code change follows from this design.

## Decision

**推荐不实施本设计。** Switcher 继续对 `/v1/responses` 返回明确 501；当前工具 discriminator 400 应在 NewAPI 已有 Responses → Chat 转换边界修复。

原因是产品关心的 MCP、reasoning/thinking、vision、prompt cache 和真实消费口径都不能由 Chat 上游等价恢复。把转换移到 Switcher 只会新增第二个协议 owner，并不会获得原生 Responses 语义。

仅在两个条件之一满足时重新开启设计：

1. 受控探测证明 Cline 存在满足需求的原生 `/responses`，此时设计原生透传而不是双向转换；或
2. 产品明确接受 function/custom-only、无状态、缓存/usage 非等价的兼容子集，并确有客户端必须直连 Switcher 的需求。

以下边界保留为第二种情况的备选设计，不代表当前实施建议。

## Boundaries

### New pure compatibility boundary

建议增加 `lib/responses-compat.js`，仅负责：

- `responsesRequestToChat(body)`：完整验证并返回转换后的 Chat body；
- `chatResponseToResponses(chat, context)`：非流式结果转换；
- `createChatToResponsesTransform(context)`：Chat SSE 解码、状态聚合和 Responses typed SSE 编码；
- 协议错误使用带安全 `statusCode` / `param` / `code` 的普通 Error，不访问账号、网络或持久化。

该模块不拥有账号、HTTP、日志、配置、模型路由或工具执行。

### Existing runtime owner

`server.js` 继续拥有：

- 鉴权和 50 MiB 正文限制；
- 模型别名与 session identity；
- 账号选择/租约；
- account proxy 和 Header 边界；
- provider attempts、timeout 和 account error actions；
- client cancellation；
- statistics、ordinary logs、detailed capture。

## Request Flow

```text
POST /v1/responses
  -> auth + readBody
  -> strict Responses validation
  -> responsesRequestToChat
  -> extractSessionIdentity(converted body; prompt_cache_key retained)
  -> existing account lease / model route / provider chain
  -> upstream POST /chat/completions
  -> non-stream or stream Responses encoder
  -> existing idempotent finalization
```

Do not self-call the local Chat endpoint over HTTP.

## Supported Contract

Initial allowlist:

- `model`, `instructions`, `input`, `stream`;
- `tools` function and explicitly approved custom;
- `tool_choice`, `parallel_tool_calls`;
- `max_output_tokens`, `temperature`, `top_p`;
- `text.format`, `reasoning.effort` best-effort mapping;
- `prompt_cache_key`;
- `store` only when absent/false;
- known optional Codex fields that are safe no-ops only when documented as such.

Unknown or unsupported semantic fields fail before account leasing. Do not silently drop a field that changes state, tool execution, background behavior, or output contract.

## Unsupported Contract

Return stable 400 for:

- hosted/provider-executed tool types without an explicit adapter;
- `previous_response_id`, `conversation`, `background: true`, `store: true`;
- context management/compaction;
- retrieval/cancel/WebSocket endpoints;
- input items whose semantics cannot be represented safely in Chat.

## Tool Policy

- `function`: structural conversion and full call_id preservation.
- `custom`: decision pending. Direct pass-through works only for compatible upstreams; function fallback changes freeform/grammar semantics.
- Other types: explicit 400 by default.
- No tool execution loop in Switcher.

## Streaming State

The stream encoder owns:

- generated response/item IDs;
- monotonic sequence numbers;
- text and tool-call accumulation;
- deterministic output/tool index order;
- Chat finish-reason to Responses status mapping;
- complete final `response.completed.response.output` and usage;
- failure event generation after output starts.

It exposes observed terminal facts to the existing finalizer so parsing is not duplicated for usage/error/status.

A validated first Chat SSE event may permit downstream start. After any Responses event is written, provider/account replay is forbidden.

## Error Semantics

- Local validation: Responses-style HTTP 400, no lease/network work.
- Upstream error before output: preserve normalized HTTP status and safe error envelope; existing retry/account rules apply.
- Upstream error after output: emit terminal failure event, never retry; existing future account action may apply.
- Client disconnect: abort upstream/transform, no failure event requirement, finalize 499 once, no health penalty.

## Diagnostics

- Ordinary logs stay body-free and may continue using the existing request projection.
- Detailed logs observe three separate bodies: ingress Responses, outbound Chat, downstream Responses.
- Sensitive text collection must cover converted instructions/messages/tool outputs before persisting any upstream error reason.
- Conversion/storage failures must not leak credentials or alter a previously determined model result.

## Compatibility and Rollout

- Keep current Chat endpoints byte-compatible.
- Replace the stable Responses 501 only when the compatibility feature is complete and tested.
- Document the endpoint as a compatibility subset, not native/full Responses.
- Rollback is removal/disablement of the Responses route, restoring the current 501; no persisted schema migration is required.

## Known Drawbacks

- The endpoint would be a compatibility facade over Chat, not native Responses. Client-visible IDs/events are synthesized and advanced output items may be unavailable.
- Hosted tools remain unavailable. Rejecting them is honest but reduces functionality; filtering or renaming them would create silent semantic errors.
- Stateful continuation, background work and stream resumption remain unsupported, so clients must resend full history. This can increase payload size, token cost and latency.
- Reasoning continuity is lossy: encrypted reasoning/compaction items, assistant phase and provider-native reasoning state cannot be preserved through Chat. Mapping `reasoning_content` to a Responses summary is only best-effort.
- Tool compatibility is provider-dependent. Vercel planner may accept `custom`, while direct/OpenRouter or a selected backend may reject it; a single conversion cannot guarantee uniform behavior.
- Streaming conversion adds latency, buffering and a second terminal state machine. Missing/duplicated/out-of-order done events can produce empty final replies, hanging clients or duplicated finalization.
- MCP is only compatible when the client has already expanded MCP capabilities into ordinary function tools. Native `type: "mcp"` requires provider-side connection, authorization, approval and typed output handling that this design does not provide.
- Vision is limited to image URL/data-URL inputs supported end-to-end. Files API IDs, image generation, computer screenshots, output images, citations and reliable image-token details are unavailable.
- Usage, refusal, annotation, logprob and finish semantics are only as complete as the Chat upstream response; absent facts must remain absent rather than be fabricated.
- Client-visible usage, NewAPI billing, Switcher successful-request statistics, Cline quota and provider charges are distinct. Retries, cancelled streams, missing final usage, multi-round tools and non-token tool fees can make displayed consumption lower than actual consumption.
- Converting instructions/items into messages can change prompt prefix shape and reduce provider cache reuse even when `prompt_cache_key` is preserved; account stickiness does not guarantee final-provider cache affinity.
- Strict allowlisting is safer but creates maintenance churn as OpenAI/Codex add fields; permissive pass-through creates upstream 400s and ambiguous behavior.
- The diagnostic surface becomes harder to operate: one request has ingress Responses, outbound Chat and downstream Responses bodies, with additional sanitization and error-attribution risks.

## Pending Decisions

1. Is the target specifically Codex HTTP streaming, or generic Responses clients?
2. Must `custom` tools work across both planner and direct pipelines?
3. Should known Codex-only fields such as `include: reasoning.encrypted_content` be accepted as documented no-ops, or rejected?
4. Is a controlled probe of a native Cline `/responses` endpoint desired before committing to conversion?
