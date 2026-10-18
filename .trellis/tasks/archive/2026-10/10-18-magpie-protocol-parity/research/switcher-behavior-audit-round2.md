# Switcher 行为审计 Round 2

对照：`parity-gap-matrix.md` P0 G1–G11 / P1 Q1–Q6，加上矩阵外增量缺口。

基线代码（全量阅读）：

- `lib/protocol-common.js`
- `lib/responses-adapter.js`
- `lib/anthropic-adapter.js`
- `server.js` 适配器接线 / 流式终态（约 5513–5855、5930–5933、6506–6508）

测试基线：`test/{responses,anthropic}-adapter.test.js`、`test/protocol-common.test.js`、`test/protocol-integration.test.js`

---

## 接线速览（server）

| 点 | 行为 | 位置 |
|---|---|---|
| 路由 | `POST /v1/responses` → `responsesAdapter`；`POST /v1/messages` → `anthropicAdapter`；Chat 无 adapter | `server.js:6506-6508` |
| `protocolAdapter` 挂载 | 入站路径先设 `res.protocolAdapter`，`sendJSON` 对 ≥400 调 `errorBody` | `server.js:5932-5933`, `5859-5864` |
| toChat 失败 | `AdapterError` → `sendJSON(400, {error…})` → 再经 `errorBody` 协议整形 | `server.js:5534-5542` |
| 流式 | `createChatSseReader` + `createStreamEncoder`；chunk → `push`；终态 `finish`/`fail` | `server.js:5661-5675`, `5765-5806` |
| 流式失败判定 | `observed.error` 或（无 `finish_reason` 且无 `[DONE]`）→ `encoder.fail`；否则 `finish` | `server.js:5782-5787` |
| Heartbeat | adapter 用 `encoder.heartbeat()`；Responses=`: PING`；Anthropic=`event: ping` | `server.js:5696-5703`；`responses-adapter.js:653`；`anthropic-adapter.js:405` |
| 畸形 SSE JSON | `parseSseEvent` catch 后返回 `[]`（静默丢） | `protocol-common.js:75-77` |

---

## P0：G1–G11

### G1 — 未答 tool call → 合成 interrupted output

| 项 | 内容 |
|---|---|
| **当前行为** | **并非**「未答就 400」。`function_call` 写入 `calls.set(id,'open')` 后若无对应 `*_output`，仅 `flush` 出带 `tool_calls` 的 assistant，**不合成** interrupted output，也**不**因仍 open 而拒绝。真正 400 的是：**output 无匹配 call**、**缺 call_id**、**重复 call_id**。见 `responses-adapter.js:151-174`、`97-107`；拒绝用例 `responses-adapter.test.js:102-103`。 |
| **测试** | 覆盖「orphan output / duplicate call_id → 400」：`responses-adapter.test.js`「rejects unsupported…」。**NO TEST**：未答 open call 续聊、合成 interrupted。 |
| **最小修复** | 在 `convertInputItems` 结束时扫描仍为 `open` 的 call_id，各插入一条合成 tool 消息（内容如 `[interrupted]` 或 magpie 等价文案），再 flush；可选在 Responses 出站标 interrupted 状态。 |
| **做错风险** | Codex 中断会话续聊时 Chat 上游「No tool output」/400；或合成文案被模型当真 → 幻觉续跑。 |

### G2 — orphan tool output（无 call_id）→ user message

| 项 | 内容 |
|---|---|
| **当前行为** | `call_id` 非非空字符串则 `fail('tool output requires call_id')`（400）。无「降级成 user message」路径。`responses-adapter.js:169-170`。Anthropic 侧 `tool_result` 缺 `tool_use_id` 同样 400：`anthropic-adapter.js:74`。 |
| **测试** | Responses：间接覆盖于 reject 表（missing matching call）。**NO TEST**：专门「无 call_id 字段 / 空字符串 → 变 user」的 magpie 行为。Anthropic：`tool_result` 缺 id 的 400 **NO TEST**（仅有成功带 id 用例）。 |
| **最小修复** | 缺/空 `call_id` 时改为 `messages.push({role:'user', content: outputText(item)})`（或加前缀），不 fail；保留有 call_id 但不匹配的严格 400（或一并降级，需产品定）。 |
| **做错风险** | Codex 跨线程通知被 400 打断；过度降级则破坏 pairing 不变量。 |

### G3 — `joinSplitCalls` / `joinToolRuns` 重排并行 tool + 夹杂文本

| 项 | 内容 |
|---|---|
| **当前行为** | 无重排。Responses 入站按 item 顺序：call 挂到当前 assistant，output 先 `flush` 再推 tool 消息。文本夹在并行 call 中间会并进同一 assistant（`ensureAssistant`）。`responses-adapter.js:91-164`。流式侧按 Chat `index` 聚合，不做跨 run 合并：`protocol-common.js:111-121`。 |
| **测试** | 有序两轮 fixture：`responses-adapter.test.js` Codex-shaped / function+custom+shell 历史。**NO TEST**：并行 call 被文本切开、output 乱序、需 join 才能满足「每个 call 有 output」的上游。 |
| **最小修复** | 入站后做 pairing pass：按 call_id 配对；乱序 output 插入到对应 call 后；夹杂文本保留在相邻 assistant；必要时把并行 call 拆成多条 assistant+tool 交错以满足严格 Chat。 |
| **做错风险** | Volcengine/严格 Chat「No tool output」；或重排后丢失中间自然语言。 |

### G4 — Chat 缺 call id 铸造 + 流式 mend

| 项 | 内容 |
|---|---|
| **当前行为** | **入站历史**：缺 `call_id` → 400（`responses-adapter.js:154`）。**出站/流式**：Chat 缺 id 时 `newId('call_')`（`buildOutput` `387-391`；流式 `callId \|\|= current.id \|\| newId('call_')` `594`）。延迟到达的 id 会更新 `current.id`，但 `callId` 一旦在 `opened` 时钉死则不再改——晚到 id **不会**回写已发出的 `call_id`（`579-604`）。 |
| **测试** | 「upstream id arrives late」断言 added/done 的 call_id **一致**（同为铸造值）：`responses-adapter.test.js:287-298`。**NO TEST**：晚到真实 id 应覆盖铸造值；历史缺 id 系统铸造而非 400。 |
| **最小修复** | 入站缺 id 时铸造稳定 id；流式在首个 `output_item.added` 前尽量等 id，或若晚到则 mend（同一 item 的后续事件与最终 output 用真实 id，并文档化不可改已发 call_id 的限制）。 |
| **做错风险** | 客户端用铸造 id 提交 output，与上游真实 id 错配 → 下一轮 400 / Codex hang。 |

### G5 — Anthropic tool_use id charset 编解码

| 项 | 内容 |
|---|---|
| **当前行为** | `tool_use.id` / `tool_result.tool_use_id` **原样**进出 Chat `tool_calls[].id` / `tool_call_id`。无 charset 过滤、无编解码。`anthropic-adapter.js:106-111`, `74-75`, `255-261`。出站缺 id 才 `newId('toolu_')`。 |
| **测试** | **NO TEST**（无非法字符 id、编解码往返）。 |
| **最小修复** | 出站/入站对非法 Anthropic id 字符做可逆编码（对齐 magpie `anthropicOutID`）；`tool_result` 侧对称解码。 |
| **做错风险** | Claude Code #1304 类：上游 Chat 生成的 id 含非法字符 → Claude 客户端 400。 |

### G6 — Codex call_id ≤64 / `ctc_`/`tsc_` 前缀映射

| 项 | 内容 |
|---|---|
| **当前行为** | 无长度截断、无前缀映射。入站 `call_id` 原样；出站 item `id` 用 `ctc_`/`lsc_`/`fc_`/`rs_`/`msg_`，但 **call_id 字段跟 Chat id**。`responses-adapter.js:154-162`, `386-391`, `498-509`。 |
| **测试** | **NO TEST**。 |
| **最小修复** | 出站 call_id 映射到 ≤64 且合法前缀；入站逆映射回 Chat id；custom 历史与 `ctc_`/`tsc_` 对齐 magpie。 |
| **做错风险** | 长 id / custom 历史 → Codex 校验失败或 pairing 断裂。 |

### G7 — `tool_search` ↔ function

| 项 | 内容 |
|---|---|
| **当前行为** | `HOSTED_TOOLS` 含 `tool_search` → `convertTools` 直接 400。`responses-adapter.js:7-10`, `193-195`。 |
| **测试** | 托管工具拒绝表含 `web_search`，**不含** `tool_search` 专测（同类路径）。集成 reject 同样只测 `web_search`。实质：**弱覆盖 / 近 NO TEST**。 |
| **最小修复** | 将 `tool_search` 从 HOSTED 挪出，按 function（或 magpie custom）映射 schema；回译时按 toolMap 还原类型。 |
| **做错风险** | Codex tool_search 路径整请求 400；误当可执行托管工具则静默空结果。 |

### G8 — DeepSeek 类：tool 后必须 reasoning 开头（`reasonFirst`）

| 项 | 内容 |
|---|---|
| **当前行为** | 仅当 `encrypted_content`/`signature` 为合法 `clps1.` 封条且位于「当前工具循环」（last user 之后）才写回 `reasoning_content`/`reasoning`。轮次外与非法封条丢弃。`responses-adapter.js:137-149`；`anthropic-adapter.js:113-117`, `182-191`。无「tool 消息后强制插空/占位 reasoning」的 reasonFirst。 |
| **测试** | 当前环回传 + 旧环丢弃：`responses-adapter.test.js` reasoning 用例；`anthropic-adapter.test.js` thinking 用例。**NO TEST**：tool 后必须以 reasoning 字段开头的上游 400 场景。 |
| **最小修复** | 对标 reasonFirst：若账号/模型标记需要，在含 tool_calls 的 assistant 前或该消息上保证非空 reasoning 字段（可用空串或上一轮封条）。 |
| **做错风险** | 部分上游 400；乱插 reasoning 干扰不需要该字段的厂商。 |

### G9 — 空/畸形 `response.completed` 必须 failed

| 项 | 内容 |
|---|---|
| **当前行为** | 畸形 SSE JSON：**静默丢事件**（`protocol-common.js:75-77`）。`finish()` 在 `finish_reason` 缺省时用 `'stop'`，仍发 `response.completed`（可 empty output）：`responses-adapter.js:618-630`。server：若无 `hasTerminal` 且无 `sawDone` → `fail`（`5785-5787`）；若仅有 `[DONE]` 无 finish_reason → **走 finish → completed**。Anthropic `finish` 同样默认 `end_turn`。 |
| **测试** | 传输中断 / 无终态 → `response.failed`：`protocol-integration.test.js:198-205`（post-error/drop/truncated）。**NO TEST**：畸形 JSON 事件、空 completed、`[DONE]` 无 choice 时必须 failed。 |
| **最小修复** | reader 对 JSON 失败记 `kind:'corrupt'`；encoder/server 在无有效 choice/无 output 且无明确 finish 时强制 `fail`；禁止「空 completed」。 |
| **做错风险** | Codex 静默结束（#1933）；误 fail 则正常短回复被标失败。 |

### G10 — Claude signed empty thinking 必须 `thinking:""`

| 项 | 内容 |
|---|---|
| **当前行为** | 非流：`contentFromSnapshot` **仅当** `snapshot.reasoning` 真值才推 thinking 块（`anthropic-adapter.js:249-252`）——空推理则**整块省略**，无 `thinking:""`+signature。流式：`content_block_start` 用 `thinking: ''`（`364`），有增量才 delta；收尾有 signature。 |
| **测试** | 流式 start 间接含空 thinking 字段；**NO TEST**：signed empty（有 signature、thinking 为空串）非流/流式契约。 |
| **最小修复** | 当需要 signature（withSignature / 流式曾开 thinking）时始终输出 `{type:'thinking', thinking: text\|\|'', signature}`，即使 text 为空。 |
| **做错风险** | 客户端校验失败 / Claude 400；多余空块干扰部分客户端。 |

### G11 — Chat 流译只取 first choice；重复 tool id fragment 续写

| 项 | 内容 |
|---|---|
| **当前行为** | 只读 `choices?.[0]`：`protocol-common.js:152`；`chatToResponses`/`chatToAnthropic` 同。`applyToolDelta`：有 `index` 用 index；无 index 时启发式 `max(keys)+(id?1:0)`（`111-121`）。同 index 上 id/name/arguments **累加/覆盖**；**无**「同 id 跨 index 合并」或「重复 id fragment 续写到已有槽」。 |
| **测试** | 交错 index 聚合：`protocol-common.test.js:39-51`；Responses/Anthropic 多 tool 流。**NO TEST**：无 index + 重复 id fragment；多 choice；同 id 换 index。 |
| **最小修复** | 对齐 magpie：同 id 续写到已有槽；无 index 时优先按 id 归槽；明确忽略 choice>0 或文档化。 |
| **做错风险** | 交错工具错槽、参数拼接损坏 → 工具调用失败 / hang。 |

---

## P1：Q1–Q6

### Q1 — Anthropic 跨协议自动 `cache_control` 断点

| 项 | 内容 |
|---|---|
| **当前行为** | `systemText` / 内容转换**忽略** `cache_control`（只抽 text）。`anthropic-adapter.js:21-28`, `66-93`。出站亦不写回 cache_control。 |
| **测试** | 入站带 `cache_control` 的 system 仍合并文本：`anthropic-adapter.test.js:18-41`（证明忽略不炸）。**NO TEST**：自动断点注入。 |
| **最小修复** | 在转 Chat 前按 magpie 规则给 system/最后 user/tool 边界打 ephemeral；或 Chat 侧用 `prompt_cache_key` 会话层（已有）声明有损接受。 |
| **做错风险** | 长会话 cache 命中差、成本升；错误断点导致缓存失效抖动。 |

### Q2 — Chat 入站三种 reasoning 拼写

| 项 | 内容 |
|---|---|
| **当前行为** | **出站/聚合** `extractReasoning` 覆盖 `reasoning_content` → `reasoning` → `reasoning_details[]`（`protocol-common.js:46-61`）。**入站历史**：Responses/Anthropic 只认本网关封条，不读 Chat 历史里的三种字段拼写回填。 |
| **测试** | `extractReasoning` 单测：`protocol-common.test.js:65-68`。**NO TEST**：assistant 历史同时带三种拼写的入站全覆盖。 |
| **最小修复** | 在 `convertAssistant` / Responses assistant 路径对 message 级字段调用 `extractReasoning`（与封条策略合成）。 |
| **做错风险** | 丢思维链 → 上游 400（reasonFirst）或质量下降。 |

### Q3 — MiniMax `<think>` 内联

| 项 | 内容 |
|---|---|
| **当前行为** | 未实现。文本原样当 content。 |
| **测试** | **NO TEST** |
| **最小修复** | 出站前从 content 拆 `<think>…</think>` 进 reasoning；入站可选反向封装。 |
| **做错风险** | MiniMax 用户可见标签泄漏或推理丢失。 |

### Q4 — `forVendor` 剥 OpenAI-only 字段

| 项 | 内容 |
|---|---|
| **当前行为** | 无 forVendor。Responses `PASSTHROUGH` 固定白名单（`temperature/top_p/user/prompt_cache_key/parallel_tool_calls`）：`responses-adapter.js:11,298`。账号 Header 白名单在 server 另轨。 |
| **测试** | passthrough 正测有；**NO TEST**：剥 `verbosity`/`metadata`/`logit_bias` 等厂商不识字段。 |
| **最小修复** | 按 upstream 厂商 profile 删未知字段；或严格只发白名单。 |
| **做错风险** | 上游 400；剥过头丢 `prompt_cache_key` 等有用字段。 |

### Q5 — ThinkOff / adaptive thinking display

| 项 | 内容 |
|---|---|
| **当前行为** | Anthropic：`thinking.type === 'enabled'` 才映射 budget→effort；否则 undefined（`166-173`）。Responses：`effort` null/`none` → 不传；`minimal`→`low`（`268-273`）。无 ThinkOff、无 adaptive display 分流。 |
| **测试** | budget→effort：`anthropic-adapter.test.js`；minimal→low：`responses-adapter.test.js:17-38`。**NO TEST**：ThinkOff / adaptive。 |
| **最小修复** | `type:disabled`/`off` 显式不传 effort 且出站不发 thinking；adaptive 按 display 标志决定是否回传 summary。 |
| **做错风险** | 客户端仍显示思考块 / 或需要思考时被关掉。 |

### Q6 — `content_filter` / `json_schema` 映射补测

| 项 | 内容 |
|---|---|
| **当前行为** | Responses：`content_filter` → `incomplete` + `incomplete_details.reason=content_filter`（`356-359`）。Anthropic：`content_filter` → `stop_reason=refusal`（`227-232`）。`json_schema`：`convertTextFormat` 映射到 Chat `response_format`（`258-265`）。`refusal` 内容 part 并入文本（`43`）。 |
| **测试** | `length`/`stop`/`tool_calls` 有测；`json_object` 有测。**NO TEST**：`content_filter` 非流/流式；`json_schema` 往返；`refusal` stop_reason。 |
| **最小修复** | 补单测三件套；确认流式 incomplete/refusal 事件类型。 |
| **做错风险** | 安全过滤被当成正常 completed；schema 请求被上游拒绝。 |

---

## 矩阵外增量缺口（A1–A12）

| ID | 主题 | 当前行为（cite） | 测试 | 最小修复 | 风险 |
|---|---|---|---|---|---|
| **A1** | `stop_reason` / `finish_reason` 完整性 | Anthropic：`length→max_tokens`, `tool_calls→tool_use`, `content_filter→refusal`, 其它→`end_turn`（含未知 finish）（`227-232`）。Responses：仅 `length`/`content_filter`→incomplete，**`tool_calls` 仍 `status:completed`**（`356-359`, `427-428`）。 | stop 映射部分有；**tool_calls→completed** 有意测于 mixed output。缺 content_filter。 | 文档化或把 tool 结束标为 completed（OpenAI Responses 惯例）并对齐客户端预期；补 content_filter 测。 | Claude/Codex 误判结束态。 |
| **A2** | usage cache token | `mapChatUsage` 读 cached/reasoning（`220-232`）。Responses 放 `input_tokens_details.cached_tokens`（`347-353`）。Anthropic：**input 减去 cached**，另给 `cache_read_input_tokens`；**无** `cache_creation_input_tokens`（`235-244`）。 | Anthropic cached 减法有测。缺 creation / reasoning 出站。 | 补齐 Anthropic cache_creation；reasoning_tokens 按需挂 output details。 | 账单/统计偏差；Claude 缓存 UI 不准。 |
| **A3** | `parallel_tool_calls` 默认 | Responses：`body.parallel_tool_calls !== false` → 默认 **true**（`319`, `408`）。透传原值到 Chat（`298`）。Anthropic：仅 `disable_parallel_tool_use` 时设 `false`；否则不设（`155-163`）。 | Anthropic disable→false 有测。Responses 默认 true **弱测**。 | 与上游默认对齐；未指定时省略字段而非强塞 true。 | 强制并行触发上游拒绝或不稳。 |
| **A4** | system / developer 角色合并 | `developer`→`system` **各条独立 push**；`instructions` 另推一条 system（`116-121`, `289`）。多段 system **不合并**。Anthropic `system` 数组仅 `\n` 拼接文本。 | developer **NO TEST**。instructions+input 有测。 | 可选合并连续 system/developer；明确 instructions 置顶。 | 重复 system 稀释指令；顺序敏感缓存 miss。 |
| **A5** | 空 assistant 消息 | 仅有 tool_calls 时 `content=null`（Responses `104`；Anthropic `122-124`）。纯空 assistant（无 text/tools/reasoning）仍可能被 push（flush 时 pending 存在）。流式无文本则可不 open message。 | tool+null content 间接有。纯空 assistant **NO TEST**。 | flush 时若无 content/tools/reasoning 则丢弃；出站省略空 message。 | 上游拒空消息；或客户端漏气泡。 |
| **A6** | `tool_choice` required vs any | Responses：透传 `required`/`none`/`auto`；对象仅 function/custom（`248-255`）。Anthropic：`any`→Chat `required`（`158`）。`allowed_tools` → 400。 | `allowed_tools` 拒绝有测；`any→required` **NO TEST**。 | 保持 any→required；补测；document required 与厂商差异。 | Claude `any` 未映射则上游当非法。 |
| **A7** | 流 ping/heartbeat | 两边 encoder 均有 `heartbeat`；server 统一臂心跳（见接线表）。Responses 注释行 vs Anthropic `event: ping`。adapter 路径 `observeBoundary` 直接 `atEventBoundary=true`（`5687`），可在事件中插入 ping。 | Chat SSE heartbeat 集成测有；**协议 adapter 心跳形态 NO TEST**。 | 保持；补测 ping 不破坏 sequence_number / block index。 | 错误插入撕裂 SSE → 客户端解析挂起。 |
| **A8** | Anthropic `max_tokens` 默认 | 仅透传；**无默认**（`199`）。缺省时 Chat 上游可能 400。 | 正测带 max_tokens；**缺省默认值 NO TEST**。 | 缺省填安全默认（如 4096）或在 toChat 显式 400 提示。 | Claude Code 省略 max_tokens → 上游 400。 |
| **A9** | refusal / content_filter 出站形态 | Responses：refusal part→文本拼接（`43`）；finish content_filter→incomplete。Anthropic→`refusal` stop_reason，**无**独立 refusal 内容块。 | **NO TEST** content_filter/refusal。 | 出站对齐各协议 refusal 块；流式发 incomplete/error。 | 安全拒绝被当正常文本。 |
| **A10** | Responses 历史 `developer` role | 已映射为 system（`116-120`）。与 A4 合并策略相关。 | **NO TEST** | 加单测；考虑与 instructions 去重。 | Codex developer 指令丢失或重复。 |
| **A11** | function call arguments `""` vs `{}` | 入站：string 原样；非 string `JSON.stringify(arguments ?? {})`（`63`）。出站 function：`arguments: args` 可为 `""`（`391`）。Anthropic：`JSON.parse(args\|\|'{}')`，失败则原样对象（`223-224`）；空串→`{}`。custom：`parseCustomInput` 空→`''`。 | custom/shell 有测；**空串 arguments NO TEST**。 | 出站统一非空 JSON 对象字符串 `"{}"`；入站空串当 `{}`。 | 严格 JSON schema / strict tools 400。 |
| **A12** | 重复 tool 名 | `toolMap.set(name, kind)` **后写覆盖**；Chat tools 数组可含重名（`196-244`）。Anthropic 同（`136-152`）。无 400。 | **NO TEST** | 重名 400 或后缀消解并逆映射。 | 回译 kind 错（function↔custom）→ Codex 工具形态错乱。 |

### 额外接线缺口

| ID | 主题 | 当前行为 | 测试 | 风险 |
|---|---|---|---|---|
| **A13** | 入站 AdapterError 与 Anthropic 信封 | `handleChat` 调 `sendJSON`；因已设 `protocolAdapter`，≥400 会再 `errorBody`（`5541`+`5859-5861`）。`count_tokens` 同样（`5976`）。行为正确但依赖隐式顺序。 | 集成 400 测 Anthropic `type:error`（`protocol-integration.test.js:232-235`）。 | 若未来绕过 `sendJSON` 直写，Claude 客户端拿到 OpenAI 信封。 |
| **A14** | 流式 `fail` 不关 Anthropic 已开 block | `createAnthropicStreamEncoder.fail` 只发 `error` 事件，**不** `content_block_stop` / `message_stop`（`393-397`）。Responses `fail` 会 `closeOpen` 再 `response.failed`（`634-645`）。 | fail 发 error 有测；**半开 block 后 fail NO TEST**。 | Claude 客户端挂起等 block_stop。 |

---

## 优先级建议（本期 Codex + Claude Code × Chat 上游）

1. **P0 必做**：G1（合成 interrupted）、G9（禁空/畸形 completed）、G5（id charset）、G7（tool_search）、G10（空 thinking）、A14（Anthropic fail 收尾）。
2. **P0 高相关**：G2、G3、G4 mend、G6、G11、A8（max_tokens 默认）、A11（`{}`）。
3. **P1 / 可后续**：Q1–Q5、A2–A4、A12；Q6 以补测为主。

---

## 已有且可依赖的行为（勿重做）

- custom / local_shell ↔ function + 单测
- `clps1.` 推理封条当前环回传；非法/环外丢弃
- 托管工具 / 有状态字段显式 400
- call_id 配对：**orphan output** 严格拒绝（与 G1 未答 call 不同）
- 流式 typed SSE / Anthropic 单开 block + tool 整块 finish
- `prompt_cache_key` / Anthropic `metadata.user_id` → identityHints
- server 流中断 → `response.failed` / Anthropic `error`（非空 completed 的传输失败路径）

---

*审计日：2026-10-18 · Round 2 · 只读产品代码，仅写本文件。*
