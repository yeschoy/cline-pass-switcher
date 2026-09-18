# Switcher 原生 Responses 兼容层可行性调查

## 结论摘要

可以在 Switcher 中实现一个 **Responses-over-Chat 兼容子集**，但不能靠把 `/v1/responses` 改为转发路由完成，也不应宣称完整 Responses 兼容。

当前 Cline 上游的已验证入口是 Chat Completions。Switcher 若接收 Responses 请求，至少需要：

1. Responses request → Chat request；
2. 复用现有账号选择、代理、供应商路由、重试和取消；
3. Chat JSON/SSE → Responses JSON/typed SSE；
4. 对无法等价转换的字段和工具在上游调用前明确拒绝。

当前错误最小修复仍应优先放在 NewAPI 的转换边界。把转换迁入 Switcher 会减少部署链路中的一个协议所有者，但不会自动解决 `web_search` 等 Responses 内置工具与 Chat/Vercel 工具类型不兼容的问题。

## 当前实现事实

### 路由与上游

- `server.js:1652` 的 `CHAT_PATHS` 只包含三个 Chat Completions 别名。
- `server.js:2177` 对 `POST /v1/responses` 固定返回 501。
- `server.js:1865`、`server.js:1883` 的非流式和流式尝试均固定调用 `${config.upstreamBase}/chat/completions`。
- `server.js:1765` 的 `injectPrefs()` 会按 planner/direct 管道注入 Vercel/OpenRouter 路由偏好；转换后的 Chat body 仍必须经过这里。

### 请求生命周期

`handleChat()` 同时拥有正文解析、模型别名、会话身份、账号租约、上游链、流式输出、取消、统计和日志终结。它目前直接向 `ServerResponse` 写 Chat JSON/SSE，不存在可直接复用的“协议无关执行结果”接口。

因此不应通过内部 HTTP 再请求本机 `/v1/chat/completions`：这会造成重复鉴权、重复账号租约、重复统计/日志，并使取消与详细日志关联变复杂。合理方向是抽出可复用执行边界，或让 `handleChat` 接受经过严格转换的 body 与输出编码器。

### 日志与安全

- 详细日志已把 `/v1/responses` 列入捕获路由，但当前 501 不读取正文，所以正文状态为 `unread`。
- 真正支持后，详细日志会开始读取和保存脱敏后的 Responses 输入及转换后的 Chat 上游请求，必须补充双协议测试。
- 普通日志不能保存 input、instructions、tool output、会话值或工具参数。现有 `sensitiveMessageValues()` 只认识 Chat `messages`，应在转换后使用完整 Chat 消息，或扩展为协议无关的敏感文本收集，避免上游错误回显内容进入普通错误日志。

## 为什么不是简单字段重命名

OpenAI 官方迁移说明明确区分：

- Chat 使用 `messages` 与 `choices[]`；Responses 使用 typed `input`/`output` Items；
- function 定义在 Chat 中为 `tools[].function`，在 Responses 中字段位于 tool 顶层；
- Chat stream 是增量 chunk，Responses stream 是 typed semantic events；
- Responses 原生提供 `previous_response_id`、Conversations、托管工具、reasoning items、background 等语义，Chat 没有等价能力。

NewAPI 的初版双向兼容实现本身就新增了约 613 行请求转换、157 行非流式响应转换、576 行流式状态机及额外编排代码；后续仍出现工具顺序、首个 SSE 错误、completed.output 为空等修复问题。这说明转换层本身是独立协议实现，不是小路由补丁。

## 主要问题

### 1. 请求转换

最低限度需要处理：

| Responses | Chat | 风险 |
|---|---|---|
| `instructions` | system/developer message | 多段 instructions 与原有 developer message 顺序 |
| `input: string` | user message | 简单 |
| message item + `input_text` | messages/content | 角色、顺序、空内容 |
| `input_image` | `image_url` | URL/file/data 形态与上游支持差异 |
| `function_call` | assistant `tool_calls` | call ID、name、arguments 必须保留 |
| `function_call_output` | role=tool | 必须和 `call_id` 配对 |
| `custom_tool_call/output` | Chat custom 或降级 function | 非所有 Chat 上游都支持 custom；降级会改变 freeform 语义 |
| `max_output_tokens` | `max_completion_tokens` | 部分模型只认 `max_tokens` |
| `text.format` | `response_format` | `json_schema` 嵌套结构不同 |
| `reasoning.effort` | `reasoning_effort` | 模型/供应商能力不一致 |
| `prompt_cache_key` | 同名透传 | 应继续参与 Switcher 粘性身份 |

必须完整验证 JSON 顶层、数组、字段类型、长度、tool schema 与 call 配对，再选择账号或访问网络。

### 2. 工具类型

#### 可合理兼容

- `function`：可转换为 Chat `{"type":"function","function":{...}}`。
- `custom`：Vercel 当前错误列出的允许类型包含 `custom`，但 OpenRouter/其他 Chat 供应商并不一定支持。若降级为 function，会丢失 grammar/freeform 输入语义。

#### 不能通用兼容

Responses 的 `web_search` / `web_search_preview`、`file_search`、`code_interpreter`、`mcp`、`computer`、`local_shell`、`shell`、`image_generation`、`tool_search` 等工具依赖 OpenAI 或特定 provider 的执行环境。Chat 转换层不能只改 discriminator 就声称支持。

可选策略：

1. **明确 400 拒绝（推荐默认）**：稳定、诚实，客户端可关闭该工具；
2. 静默过滤：请求可能成功，但能力无声丢失，不推荐；
3. 映射为普通 function：只有调用方或 Switcher 真正执行该工具时才正确；
4. 映射到 `vercel:*` provider tool：仅 planner/Vercel 管道成立，语义、计费、隐私、输出事件均不同，且 direct/OpenRouter 不可移植；
5. Switcher 自建工具执行循环：引入网络访问、授权、审批、沙箱和无限循环风险，超出本项目定位。

当前报错很可能就是非 function/custom 的 Responses 工具类型被 NewAPI 原样写进 Chat `tools`，再被 Vercel discriminator 校验拒绝。

### 3. 状态能力不可等价

以下能力不能在无状态 Chat 上游上直接实现：

- `previous_response_id`；
- `conversation`；
- `store: true` 对应的检索/续接；
- `background: true`、GET retrieve、cancel、resume stream；
- `context_management` 与 `/responses/compact`；
- provider 加密的 reasoning/compaction items。

若要支持，需要在 Switcher 新增持久化响应对象、上下文历史、状态机、保留策略、鉴权、取消与恢复协议。这会把账号路由器变成 agent state service，并产生新的敏感数据存储，不建议。

建议兼容层仅接受无状态请求：`store` 缺失或 false、无 `previous_response_id`/`conversation`/`background`/`context_management`。出现这些字段时在上游工作前返回明确 400。

### 4. 非流式响应转换

需要把 Chat 的首个 choice 转为 Responses：

- 生成 `resp_*` ID、`created_at`、`object: response`、`status`；
- assistant text → message/output_text item；
- tool calls → 独立 function/custom call items；
- `finish_reason=length/content_filter` → `incomplete` 与 `incomplete_details`；
- Chat usage → input/output/total tokens，并保留 cached/reasoning 明细的 unknown/zero 区别；
- 同时有 text 与 tool calls 时不能丢其中一类；
- refusal、annotations、reasoning_content 没有完全等价映射，不能伪造语义。

### 5. 流式转换是最高风险部分

现有 Switcher 验证 Chat SSE 首事件后直接 pipe 给客户端。Responses 需要有状态 Transform，至少发出并维护：

- `response.created` / `response.in_progress`；
- `response.output_item.added`；
- `response.content_part.added`；
- `response.output_text.delta`；
- 多工具并行时的 `response.function_call_arguments.delta`；
- 对应的 done 事件；
- 带完整 `output` 和 usage 的 `response.completed`；
- 失败时的 `response.failed` / `error`。

必须维护单调 `sequence_number`、response/item/call ID、choice/tool index、增量 name/arguments、完整文本与 output 聚合。不能只转发 delta；已有兼容网关曾因 `response.completed.response.output=[]` 导致客户端最终保存空回复。

还要处理：

- 首事件之前出现 HTTP 200 + SSE error：应保留为可重试的上游失败；
- 输出开始后的 error：不能重试，只能发失败事件并更新未来账号状态；
- 流在 finish_reason/completed 前结束；
- `[DONE]` 不能替代 Responses 的 `response.completed`；
- 多 tool call 的事件顺序必须确定；
- 转换 Transform 出错、客户端关闭、上游关闭必须只终结一次并只释放一次租约。

### 6. 账号路由、重试与取消

可以复用当前账号选择和 provider chain，但必须保持：

- 先选择账号，再执行该账号的 provider chain；
- 首个有效 Chat SSE 已接收后即视为开始，不能透明重放；
- 转换后的首个 Responses event 写出后同样不可换 provider/账号；
- 客户端断开要销毁 Chat upstream 与转换 Transform；
- `[DONE]`、Responses completed、socket close 三者之间只允许一次统计/日志/lease finalization；
- pre-stream 400/429/5xx 转成标准 error envelope，不能伪装成 response.completed。

### 7. 统计与诊断

统计应继续从真实 Chat 上游 usage 计算，而不是从新生成的 Responses 包装反推。协议转换不能改变：

- 成功/失败/取消计数；
- missing 与 numeric zero 的区别；
- 健康度对普通参数 4xx 不处罚；
- 账号规则只根据规范化终态执行；
- 普通日志严格投影；
- 详细日志记录 ingress Responses、outbound Chat、downstream Responses 三个不同正文。

## Codex 兼容性边界

当前 Codex HTTP Responses 请求通常包含：

- `instructions`、完整 `input` Items；
- 多个 function tools，可能包含 `custom` apply_patch、`local_shell`、`web_search`；
- `stream: true`、`store: false`；
- `parallel_tool_calls`；
- `reasoning`；
- `include: ["reasoning.encrypted_content"]`；
- `prompt_cache_key`、`text`、`service_tier`、`client_metadata`。

因此“Codex 可用”至少还需要决定：

- `web_search` / `local_shell` 是否要求客户端关闭，还是做显式拒绝；
- `custom` 是否只在已知 Vercel planner 管道支持；
- `include: reasoning.encrypted_content` 是否作为无输出的兼容 no-op；
- input 中 reasoning/compaction item 是拒绝、丢弃还是降级；
- Chat `reasoning_content` 是否映射为 reasoning summary（不是加密 reasoning 的等价物）。

只支持文本和 function tools，不足以承诺所有 Codex 配置开箱即用。

## MCP、Thinking、图像、缓存与 Token 口径

### MCP

Responses 原生 `type: "mcp"` 是 provider-executed tool：上游负责连接 MCP server、列工具、携带授权、审批并生成 `mcp_*` output items。Chat 上游没有等价协议。Switcher 若原样透传会被 Chat/Vercel schema 拒绝；若转换为 function，前提是已经获得完整工具 schema，并且客户端或 Switcher 真正执行调用。

Codex 本地加载的 MCP 工具有时会在请求中展开为普通 function tools，这种形态可进入 MVP；原生 `mcp` block 不可。让 Switcher 执行 MCP 会新增 OAuth/密钥存储、SSRF、审批、写操作授权、超时和循环控制，不应包含在兼容层。

### Reasoning / Thinking

`reasoning.effort` 可 best-effort 映射为 Chat `reasoning_effort`，但以下语义无法等价：

- Responses reasoning/compaction item 与 `encrypted_content`；
- 跨轮次的 provider-native reasoning continuity；
- assistant `phase`；
- typed reasoning summary events；
- Chat 模型返回的供应商私有 `reasoning_content`。

把 raw `reasoning_content` 包装成 Responses summary 可能泄露本不应暴露的思考内容，也不等价于加密 reasoning item。完全丢弃则使 Codex 的思考展示和跨工具轮次质量下降。部分 DeepSeek Chat 模型还要求带 tool calls 的历史 assistant message保留特定 reasoning 字段，否则下一轮可能 400，因此需要模型特定兼容，而非通用映射。

### 图像

Responses `input_image` 可以有限映射到 Chat `image_url`，但仅在模型、Cline 管道和最终供应商都支持视觉输入时有效。主要缺口：

- Switcher 没有 OpenAI Files 服务，不能解析只给 `file_id` 的输入；
- data URL、远程 URL、detail 和尺寸限制在各供应商间不同；
- 图像生成、computer screenshot、文件引用和输出图片不是普通 vision input；
- image token/details、annotations 和 citations 可能不由 Chat 上游返回；
- provider fallback 可能从支持视觉的供应商切到不支持者。

因此 MVP 最多支持明确的 URL/data-URL 图像输入，并需按模型/上游实测；不能承诺图像输出或 Files API。

### 缓存

缓存命中可能低于原生 Responses，但不一定低于当前 NewAPI→Chat 转换，因为两者最终都使用 Chat 上游。风险来源包括：

- `prompt_cache_key` 在 Switcher 中可用于账号粘性，但 Chat/Vercel/最终供应商未必把它当作原生 Responses cache key；
- input items 被扁平化为 messages 后，instructions、tool schema、reasoning/history 的 token prefix 发生变化；
- 字段顺序、空消息、合并文本、custom tool 降级等非确定性变化会破坏 exact-prefix cache；
- provider/account failover 会切换缓存域；账号粘性只能降低该风险，不能保证最终供应商一致；
- 不支持 `previous_response_id` 和 reasoning state 时，客户端需要重传完整历史，缓存未命中时成本更高。

必须保持转换确定性、保留 `prompt_cache_key`、稳定工具顺序并观测真实 `cached_tokens`；不能仅凭粘性命中宣称 provider prompt cache 命中。

### Token 与消费口径

至少存在五个不同口径：

1. 客户端看到的单次 Responses `usage`；
2. NewAPI 的计费 usage；
3. Switcher 的成功请求统计；
4. Cline 5h/周/月额度；
5. 最终供应商真实计量与非 token 工具费用。

它们可能不一致：

- Chat→Responses 只能映射上游实际返回的 prompt/completion/cache/reasoning/image 字段；缺失字段不能推断；
- 多轮工具任务是多次模型请求，客户端若只展示最后一次 usage，会低于整项任务消耗；
- provider retry、失败尝试、输出开始前失败可能已产生消费，但最终响应没有该次 usage；
- 客户端取消时 Switcher 按契约不计统计，但上游可能已生成并计费；
- streaming 若没有最终 usage，模型已消费但客户端/统计只能显示 unknown；
- reasoning/image token 可能计入 total，却缺少细分；若错误补 0，会形成虚假的精确值；
- MCP/web search/code interpreter 等工具可能另行收费，不属于 token usage；
- NewAPI 的转换/计费层可能使用与客户端响应不同的 billing snapshot。已有公开问题显示 Responses cache details 可以在客户端响应中出现，但计费归一化遗漏 cached tokens，因此“显示正确”不等于“扣费正确”。

兼容层必须只复制显式上游 usage，保留 missing 与 zero 的区别，并在产品文案中把“模型上报 Token”“NewAPI 计费”“Cline 额度”分开。要证明一致性，需要同一 request ID 的下游 usage、NewAPI 消费记录、Switcher attempt、Cline 额度变化做受控对账；代码映射测试本身不能证明真实扣费一致。

## 方案比较

| 方案 | 优点 | 主要问题 | 建议 |
|---|---|---|---|
| 修 NewAPI 转换 | 改动最小；转换已有 owner 和测试；当前 400 可直接解决 | 继续依赖两层代理；需跟随 NewAPI 版本 | 当前故障优先 |
| Switcher 内 Responses-over-Chat | 可直接接 Codex；统一账号/路由/诊断；减少外部转换依赖 | 需要完整双向转换和流式状态机；维护成本高 | 仅做严格子集 |
| 透传 Cline `/responses` | 若上游原生支持则语义最好 | 当前无支持证据；路由偏好、包装、错误、账号代理均需重验 | 先做本地/受控探测，不能假设 |
| Switcher 完整 Responses 服务 | 能覆盖 state/background/tools | 需要对象存储、后台任务、工具执行器、恢复流、更多 API 和安全边界 | 不建议 |

## 推荐架构（若后续实施）

1. 新建一个无依赖、纯转换边界 `lib/responses-compat.js`：
   - request validator/converter；
   - non-stream response converter；
   - Chat SSE → Responses SSE 有状态 Transform；
   - 独立单测。
2. 在 `server.js` 增加 `handleResponses()`，但复用同一个账号/transport/provider-chain owner。
3. 将 `handleChat()` 中“读取/验证请求”和“执行并写协议响应”适度分开；不要通过本机 HTTP 自调用。
4. 保持上游仍为 `/chat/completions`，并让转换后的 body 继续经过模型别名、session identity、`injectPrefs()`、账号代理、重试和统计。
5. 所有不支持能力在账号租约/网络之前返回有明确 `param`/`code` 的 400。
6. 不新增运行时依赖，不持久化 Responses 对象。

## 建议 MVP

### 支持

- `POST /v1/responses`；
- stream true/false；
- `model`、`instructions`；
- `input` string 与 message/input_text；
- 普通 function definitions、function_call、function_call_output；
- 经单独决策后的 custom tool；
- `tool_choice`、`parallel_tool_calls`；
- `max_output_tokens`、temperature、top_p；
- `text.format` JSON/JSON Schema；
- `reasoning.effort` 的 best-effort Chat 映射；
- `prompt_cache_key`；
- text/function-call Responses JSON 与 typed SSE；
- usage、取消、错误、账号路由与详细日志。

### 明确拒绝

- 非白名单 tool type；
- `previous_response_id`、`conversation`；
- `store: true`；
- `background: true`；
- `context_management`；
- Responses retrieval/cancel/compact/WebSocket；
- input/output 中无法安全降级的 hosted-tool、computer、shell、MCP、compaction 或 provider-encrypted reasoning item。

## 测试重点

- 请求：string/message、instructions、图片、空内容、function/custom、call pairing、未知字段/类型、50 MiB 边界；
- 非流式：text、text+tools、多 tools、length/content_filter、usage missing/zero/cache/reasoning、错误包装；
- 流式：碎片化 UTF-8/SSE、文本、多个并行工具、arguments 分片、usage-only chunk、首事件 error、输出后 error、无 finish、completed 完整 output、客户端取消；
- 生命周期：provider 重试、account cooldown/ban replacement、代理失败无直连、lease 归零、统计/健康/普通日志各一次；
- 详细日志：原始 Responses、转换后 Chat、最终 Responses 三者可关联且凭据脱敏；
- Codex 最小真实客户端验收：关闭 hosted tools，执行一次 function/custom tool 循环并完成第二轮。

## 来源

- OpenAI, Migrate to the Responses API: https://developers.openai.com/api/docs/guides/migrate-to-responses
- OpenAI, Streaming API responses: https://developers.openai.com/api/docs/guides/streaming-responses
- OpenAI, Using tools: https://developers.openai.com/api/docs/guides/tools
- OpenAI, Conversation state: https://developers.openai.com/api/docs/guides/conversation-state
- Vercel, AI Gateway Tool Use: https://vercel.com/docs/ai-gateway/inputs-and-tools/tool-use
- NewAPI PR #5787, Responses to Chat: https://github.com/QuantumNous/new-api/pull/5787
- NewAPI issue #4362, completed.output empty: https://github.com/QuantumNous/new-api/issues/4362
- NewAPI issue #6643, code-only SSE rate-limit error: https://github.com/QuantumNous/new-api/issues/6643
- Codex Responses request/tool sources: https://github.com/openai/codex/blob/35aaa5d9/codex-rs/core/src/client.rs and https://github.com/openai/codex/blob/ac4332c05b11e00ae775a24cb762edc05c5b5932/codex-rs/tools/src/tool_spec.rs
