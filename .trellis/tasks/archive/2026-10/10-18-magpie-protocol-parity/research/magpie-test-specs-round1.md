# Research: magpie 网关测试可执行规格（Round 1）

- **Query**: 从 yetone/magpie `internal/gateway/` 相关测试提取 Chat/Responses/Anthropic 互译边角的可执行规格，面向 Chat-upstream-only 网关（服务 Codex CLI / Claude Code）
- **Scope**: mixed（外部 GitHub 源码 + 本仓库适配器对照）
- **Date**: 2026-10-18
- **Source**: https://github.com/yetone/magpie `main` / `internal/gateway/*_test.go`（经 raw.githubusercontent.com 拉取）
- **本仓库基线**: `lib/{responses,anthropic}-adapter.js`、`lib/protocol-common.js`；既有差距见 `parity-gap-matrix.md`

---

## 执行摘要：按 Agent 挂断风险排序的 Top 20 行为

> 适用性：`yes`=Chat 上游路径必须；`partial`=可降级/部分适用；`no`=多上游/同协议密封原样回传，本期不追。  
> 本仓库覆盖：对照适配器与 `parity-gap-matrix.md`；`unknown` 表示未在测试中直接断言到等价行为。

| # | 行为（可执行规格一句话） | 风险 | Chat-upstream | 本仓库大致状态 |
|---|---|---|---|---|
| 1 | **未答 tool call → 合成 interrupted output**（文案含 `unavailable` / `interrupted`），使严格 Chat/Anthropic/Responses 上游可续聊 | 极高 | yes | **缺**：未配对 → 400（G1） |
| 2 | **orphan tool output**（无匹配 call / 空 call_id）→ 降为 user 文本，不造假 call、不复用 id | 极高 | yes | **缺/拒**（G2） |
| 3 | **乱序并行 tool results 按 call 顺序重排**，且 tool 消息排在同轮 user 文本前（Claude Code 并行） | 极高 | yes | **缺**（G3 相关） |
| 4 | **joinToolRuns**：并行 batch 的 results 之间夹杂 message（如 image_resize_notice）时，把打断项挪到整批 results 之后 | 极高 | yes | **缺**（G3） |
| 5 | **空/缺 call_id 铸造**：入站空 id 与对应 tool_result 同铸且跨请求稳定；流式首片给 id，后续空 id 不覆盖 | 极高 | yes | **部分**：出站会 `newId`；入站空 id 系统化铸造未证实（G4） |
| 6 | **畸形/异协议流错误 → 显式 failed**（`response.failed` / Anthropic `error`），禁止空 `response.completed` 当成功 | 极高 | yes | **缺**：SSE JSON 失败静默丢事件（G9） |
| 7 | **重复 tool_call id 的流式 fragment 续写同一 call**（不因每片重复 id 开新 call） | 高 | yes | **部分**：reader 有启发式；缺对照 magpie 的补测（G11） |
| 8 | **Anthropic tool_use id 字符集编解码**：客户端仅见 `[A-Za-z0-9_-]`，回上游还原原始 id（#1304 `Bash:0#…`） | 高 | yes | **缺**（G5） |
| 9 | **Codex call_id ≤64**：过长 id 截断/映射且 call↔output 同映射、跨请求稳定（#732） | 高 | yes | **缺**（G6） |
| 10 | **signed 空 thinking 必须带 `"thinking":""`**（字段存在，不能省略） | 高 | yes | **待核**（G10）；出站有 thinking 块 |
| 11 | **tool 后必有 reasoning 回放**（DeepSeek `reasonFirst` / Chat `reasoning_content`；有损封条可替代明文） | 高 | yes | **部分**：`clps1.` 封条；非本网关历史明文可能丢（G8） |
| 12 | **重复 tool_result 只保留第一次**；第二次丢弃（严格上游拒双答） | 高 | yes | **未知**（可能因配对校验失败） |
| 13 | **跨多个 user 消息收集的 tool results 仍挂回对应 assistant，并按 call 序** | 高 | yes | **未知/缺** |
| 14 | **late result（exchange 已用合成结果关闭）并入后续 user 文本，禁止二次占用同 id** | 高 | yes | **缺**（与 G1/G2 同族） |
| 15 | **thinking-only assistant（中断流残留）在 exchange 内外丢弃/合并**，避免空 assistant 被严格 Chat 拒 | 中高 | yes | **未知** |
| 16 | **Chat 流译只取 first choice**；index 字符串/`1`/未索引续写规则 | 中高 | yes | **部分**：reader 有；缺完整对照测（G11） |
| 17 | **custom_tool ↔ function 降级 + 回译为 custom**；item `id` 用 `ctc_` 前缀 | 中 | yes | **已有** custom/local_shell；`ctc_` 出站已有 |
| 18 | **tool_search ↔ function**（托管路径拒绝 vs magpie 降级） | 中 | yes | **拒**（G7） |
| 19 | **流已开后的可重试错误文案**（Pi/Codex 按文本决定 retry；413→`request_too_large`） | 中 | partial | **未知**（本仓库无 Pi 专用文案层） |
| 20 | **prompt_cache_key 透传 + 上游拒 key 时剥掉重试**；usage 各厂商 cached 字段归一 | 中低 | partial | **部分**：key 透传/派生已有；拒 key 自动剥离 **未知**；Anthropic 自动 `cache_control` **未做**（Q1） |

**明确不进 Top20 本期追齐（文档仍记录）**：Responses/Anthropic **真 sealed** 原样回传、`ClaudeSubscriptionKeepsSealedThinking`、多账号 `stream_error_open` failover、Gemini byte-cap 形状、ChatGPT 原生 standalone output 不改写。

---

## Findings

### Files Found（已拉取分析）

| File Path（magpie） | Description |
|---|---|
| `internal/gateway/chat_tool_pairing_test.go` | Chat 出站 pairing / orphan / 乱序 / 合成 interrupted |
| `internal/gateway/anthropic_tool_pairing_test.go` | Messages 路径同等 mend + 上游校验模拟 |
| `internal/gateway/pair_tool_items_test.go` | Responses `pairToolItems` 合成 / 保干净交换 |
| `internal/gateway/orphan_tool_output_test.go` | standalone / 空 id output → user message |
| `internal/gateway/join_tool_runs_test.go` | 并行 run 被中间 message 打断时重排 |
| `internal/gateway/chat_call_ids_test.go` | 空 call_id 铸造、流式 mend |
| `internal/gateway/call_item_ids_test.go` | `ctc_`/`tsc_` 前缀与 tool_search 降级形态 |
| `internal/gateway/codex_call_id_test.go` | call_id 长度 ≤64 |
| `internal/gateway/anthropic_ids_test.go` | 回复 id → `msg_…` |
| `internal/gateway/anthropic_call_ids_test.go` | tool_use id 安全字符集双向 |
| `internal/gateway/reasoning_replay_test.go` | 翻译路径回放 reasoning / summary |
| `internal/gateway/reasoning_state_responses_test.go` | sealed reasoning 同协议往返 |
| `internal/gateway/reasoning_state_anthropic_test.go` | sealed/redacted thinking 同协议往返 |
| `internal/gateway/chat_inbound_reasoning_test.go` | Chat 入站三种 reasoning 拼写 |
| `internal/gateway/responses_hidden_thinking_test.go` | tool 后隐藏 thinking 不截断流 |
| `internal/gateway/thinking_block_test.go` | 空 thinking 字段必保留 |
| `internal/gateway/translate_stream_test.go` | Chat→Responses/Anthropic 流译细节 |
| `internal/gateway/stream_error_shape_test.go` | 畸形流必须 failed |
| `internal/gateway/stream_error_open_test.go` | 流错误立即 failover |
| `internal/gateway/stream_error_passing_test.go` | 可重试文案 / 413 形状 |
| `internal/gateway/chat_from_anthropic_test.go` | Chat 客户端 ← Anthropic 上游实时流 |
| `internal/gateway/custom_tool_test.go` | custom 拒则降级为 function |
| `internal/gateway/codex_custom_tools_test.go` | Codex code mode namespaced custom |
| `internal/gateway/prompt_cache_test.go` | cache key / usage / Anthropic cache_control |

### Related Specs（本仓库）

- `.trellis/tasks/10-18-magpie-protocol-parity/prd.md` — 任务目标与 G1–G11
- `.trellis/tasks/10-18-magpie-protocol-parity/research/parity-gap-matrix.md` — 差距矩阵
- `.trellis/tasks/10-18-magpie-protocol-parity/research/magpie-edge-capabilities.md` — 能力簇索引
- `.trellis/tasks/archive/2026-10/10-13-three-protocol-adapter/` — 已实现有损子集

### External References

- [yetone/magpie](https://github.com/yetone/magpie) — 测试源
- 合成 interrupted 文案常量（多测共用）：`[The result of this tool call is unavailable: the turn was interrupted.]`

---

## 测试簇详表

说明列含义：

1. **Test name**
2. **Input shape（客户端协议）**
3. **Expected behavior（一句）**
4. **Chat-upstream-only**：yes / partial / no
5. **cline-pass-switcher**：已覆盖 / 部分 / 缺 / 未知 / 不适用

---

### A. Chat tool pairing（`chat_tool_pairing_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestChatToolResultsLeadInCallOrder` | IR/Chat：assistant(A,B,C,D) + user 含乱序 results + 文本 | 出站 Chat：`tool(A)…tool(D)` 按 call 序，再 user 文本 | yes | 缺 |
| `TestChatToolResultsGatherAcrossUserMessages` | Claude Code：连续多个 user 各带部分 results | 收集到同一 assistant 后，按 call 序成 tool 消息 | yes | 缺 |
| `TestChatOrphanToolResultBecomesUserMessage` | 仅有 tool result、无对应 call | 变为 user 文本；不造 call；id 不重复 | yes | 缺（当前拒） |
| `TestChatLateToolResultJoinsUserMessage` | call 后先 user 文本再 late result | 先合成 interrupted 关交换；late 并入 user 文本 | yes | 缺 |
| `TestChatDuplicateToolResultsKeepFirst` | 同一 call 两个 results | 只保留首次答案 | yes | 未知 |
| `TestChatEmptyToolCallIDBecomesUserMessage` | `tool_call_id:""` | 当 orphan user，永不产生空 id call | yes | 缺/拒 |
| `TestChatUnansweredCallGetsSyntheticResult` | assistant(call) + user 文本无 tool | 插入含 `unavailable` 的 tool 消息 | yes | 缺（400） |
| `TestChatThinkingOnlyAssistantDroppedInsideExchange` | call 与 result 之间夹 thinking-only assistant | 丢掉该 assistant；真实 result 仍配对 | yes | 未知 |
| `TestChatThinkingOnlyAssistantLeftOutOutsideExchange` | 两 user 间 thinking-only | 丢弃并合并两 user 文本 | yes | 未知 |
| `TestChatSessionShapeStaysValid` | Claude Code 会话形复合 fixture | 整串仍 kimiValid + idsUsedOnce | yes | 缺 |
| `TestChatCleanExchangeUntouched` | 干净并行交换 | 字节级形状不变（仅规范化顺序） | yes | 部分（干净路径可过） |

**可执行常量**：合成结果需让严格校验器（Kimi 式：tool 必须紧跟对应 assistant 的 pending ids）通过。

---

### B. Anthropic tool pairing（`anthropic_tool_pairing_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestMessagesUnansweredCallGetsSyntheticResult` | Messages：assistant tool_use + user 文本 | user 消息内先 `tool_result`（is_error，interrupted 文案）再 text | yes | 缺 |
| `TestMessagesOrphanToolResultBecomesText` | 合法 A + orphan `gone` | orphan 变 text；不再发 tool_result | yes | 缺 |
| `TestMessagesOrphanToolResultWithoutACallBecomesText` | 仅 orphan + text | 单 user，orphan 为 text | yes | 缺 |
| `TestMessagesUnansweredCallAtTheEnd` | 以未答 call 结尾 | 末尾补合成 tool_result | yes | 缺 |
| `TestMessagesCleanExchangeUntouched` | 乱序 B,A + text | 保持结果顺序 B,A 与 text 相对位置 | yes | 部分 |
| `TestMessagesMendedExchangeKeepsForeignIDsEncoded` | 非法 charset id + orphan | mend 时 call/合成 result 同用 `anthropicOutID` | yes | 缺（G5） |
| `TestMessagesUpstreamAnswersABrokenToolExchange` | **Chat 客户端**坏交换 → Messages 上游 | 上游收到已 mend 体；200 | yes | 缺 |
| `TestMessagesSecondAnswerDropped` | 双答同 id | 仅 `"first"` | yes | 未知 |

**Anthropic 校验规则（测试内嵌）**：每个 `tool_result.tool_use_id` 必须对应前一 assistant 的 `tool_use`；每个 call 必须在下一 user 消息被答完。

---

### C. Responses pairToolItems（`pair_tool_items_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestPairToolItemsAnswersALoneCall` | Responses input：lone call / custom / 半答并行 | 在 call 后插 `function_call_output`/`custom_tool_call_output`（interrupted）；并行未答插在已有 outputs 后；干净字节不动；不改 caller buffer | yes | 缺 |
| `TestResponsesRelayAnswersALoneCall` | /v1/responses 中继 | 上游 body 含合成 output | partial（我们无 Responses 上游） | 不适用上游中继；**入站→Chat 仍要 mend** |
| `TestTranslatedToResponsesAnswersALoneCall` | Chat/Messages → Responses 上游 | 翻译后仍 mend lone call | no（反向：我们是→Chat） | 不适用 |
| `TestTranslatedToResponsesKeepsAPairedExchange` | 已配对 Chat | 不多插合成 output | partial | 部分 |

**Issue 锚点**：#1341 Volcengine / #1275 Chat pairToolMessages。

---

### D. Orphan tool outputs（`orphan_tool_output_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestStandaloneToolOutputResponsesRoutes` | Responses/Codex：standalone / custom_missing / empty_id | 配对保留；standalone 内容以 **user message** 交给上游；不发明空 call_id | yes | 缺 |
| `TestOrphanToolOutputsContentAndNoops` | 无 call_id 的多模态 output；空 output | 转 message content；空→`"Tool result received."`；幂等 | yes | 缺 |
| `TestCodexNativeStandaloneOutputUnchanged` | ChatGPT 原生后端 | **不改写** standalone | no | 不适用 |

---

### E. joinToolRuns（`join_tool_runs_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestJoinToolRunsMovesAnItemOutOfARun` | 两并行 calls + output + **resize notice message** + output | notice 挪到两 outputs 之后；内容保留；幂等 | yes | 缺 |
| `TestJoinToolRunsLeavesWholeExchangesAlone` | 整交换 / lone unanswered / 已相邻乱序 outputs / 非 JSON | 字节不变 | yes | 缺（无此层） |
| `TestResponsesRelayKeepsAToolRunTogether` | 中继 + 上游模拟严校验 | 上游看到整 run | partial | 缺于入站→Chat |
| `TestRelayedCodexImageBatchKeepsItsResultsTogether` | Codex 图像 batch | 同上 | yes | 缺 |
| `TestJoinToolRunsOnlyMovesWhatBreaksARun` | 仅打断 run 的项移动 | 精确移动 | yes | 缺 |
| `TestTranslatedToolRunKeepsItsRealResults` | 翻译路径 | 真实 output 不被合成替换 | yes | 缺 |
| `TestTextBetweenABatchsCallsStaysInItsStep` | calls 之间夹文本 | 文本保留在正确 step | yes | 缺 |
| `TestRelayedTextBetweenABatchsCallsIsAnswered` | 中继 | 上游可答 | partial | 缺 |

---

### F. Chat call_ids（`chat_call_ids_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestEmptyCallIDRelayedWithOne` | Chat：`id:""` + `tool_call_id:""`（#2611） | 铸同一非空 id；跨请求稳定（缓存前缀） | yes | 缺 |
| `TestEmptyCallIDReachesPluginWithOne` | 同上经 plugin | mend 在 fetch 前 | partial | 未知 |
| `TestEmptyCallIDTranslatedWithOne` | Chat→Messages/Responses | 两侧 call/result 同铸 id | yes（我们→Chat 对称问题） | 缺 |
| `TestChatCallIDsLeavesWhatHasIDs` | 已有 id | 字节不变；多空 call 按序配对；多余空 result 仍空 | yes | 未知 |
| `TestStreamedCallGivenAnID` | 上游流：首片无 id / 后片空 id / 自带 id | 首片铸 `call_`；后空 id **省略**；自带保留 | yes | 部分（出站 newId） |
| `TestWholeReplyCallGivenAnID` | 非流空 id | 补 `call_` 前缀 id | yes | 部分 |

---

### G. call_item_ids / Codex 长度 / Anthropic ids（`call_item_ids_test.go`, `codex_call_id_test.go`, `anthropic_ids_test.go`, `anthropic_call_ids_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestCustomToolCallHasCtcID` | 出站 custom | item `id` 前缀 `ctc_`；`call_id` 用模型侧 id | yes | **已有** `ctc_` |
| `TestMagpieModelOpenAICallIDs` | 历史含 `fc_` 的 tool_search/custom | 发 OpenAI 时改 `tsc_`/`ctc_`；search→function | yes | tool_search **拒**；ctc 映射部分 |
| `TestResponsesRelayCallIDs` | 含 compaction | 同上 | partial | 未知 |
| `TestCodexOwnModelCustomCallIDs` | ChatGPT Codex | 保留/补 `tsc_` | partial | 未知 |
| `TestCustomCallIDsUntouched` | 已合规 id | 不变 | yes | 未知 |
| `TestCodexRelayBoundsLongCallIDs` | call_id 86/87 字符 | 全部 ≤64；call↔output 同映射；跨请求稳定 | yes | **缺**（G6） |
| `TestAnthropicReplyID` | 上游 chatcmpl-… | 客户端见 `msg_…` | yes | 未知 |
| `TestAnthropicCallIDsSafeBothWays` | 上游 id=`Bash:0#…` | 客户端安全 charset；回 Chat 上游还原原 id | yes | **缺**（G5） |
| `TestAnthropicSafeCallIDsUnchanged` | 已安全 id / `mp_` 边界 | 不二次编码；往返恒等 | yes | 缺编解码层 |

---

### H. Reasoning / thinking（多文件）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestReasoningReplayed` | Responses 历史含 reasoning → Chat/Responses 上游 | DeepSeek 路径回放 text/summary；OpenAI host **不**发明文 reasoning | yes | **部分**（clps1 封条；非本网关明文可能丢） |
| `TestResponsesSealedReasoningGoesBackAsItCame` | encrypted_content | 同协议字节级回传 | **no** | 有损接受 |
| `TestResponsesReasoningTextStillLeftOut` | 外厂商 reasoning_text→OpenAI | 不发给 OpenAI | no/partial | 有损 |
| `TestResponsesStreamKeepsSealedReasoning` / `WholeReply…` / `StaysWithResponses` | sealed 流/整包 | 同协议保留；跨协议不泄漏 sealed | **no** | 有损 |
| `TestAnthropicSealedThinkingGoesBackAsItCame` 等 | thinking/redacted | 同协议字节级 | **no** | 有损；redacted 丢弃 |
| `TestClaudeSubscriptionKeepsSealedThinking` | subscription 桥 | 保留 sealed | **no** | 不做 |
| `TestParseChatReadsEveryReasoningSpelling` | Chat 入站 `reasoning_content`/`reasoning`/`reasoning_details` | 三种都解析为 Thinking + tool | yes | **部分**：`extractReasoning` 有三拼写；历史 assistant 入站全覆盖待核（Q2） |
| `TestParseChatTakesTheFirstReasoningSpellingSent` | 三者并存 | 优先 `reasoning_content` | yes | 部分（extract 同序） |
| `TestResponsesStreamToolThenHiddenThinking` | Anthropic 上游：tool 后 redacted/空 signed thinking → Responses 客户端 | 流完整 completed；隐藏 thinking 不出 reasoning item；可见 thinking 出 1 个 | partial（我们上游是 Chat） | 未知；防截断相关 |
| `TestSignedThinkingWithNoTextKeepsTheField` | 出站 Anthropic：有 signature 无 text | **必须** `"thinking":""` | yes | **待核**（G10） |

---

### I. Stream translation（`translate_stream_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestChatTranslationKeepsFirstChoice` | 多 choice 混 text/think/tool | **只取 choice 0** | yes | 部分 |
| `TestChatTranslationKeepsOnlyChoiceIndexedOne` | 仅 index=1 有内容 | 不取 1；结果空或忽略 | yes | 未知 |
| `TestChatTranslationAcceptsStringChoiceIndex` | `"0"` 字符串 index | 当作 0 | yes | 未知 |
| `TestChatTranslationUsageBeforeUnindexedChoice` | usage 先于无 index choice | 仍译出文本 | yes | 未知 |
| `TestChatTranslationUnindexedRoleBeforeIndexedChoice` | 无 index role + 有 index | 续同一 choice | yes | 未知 |
| `TestChatTranslationUnindexedChunksContinueIndexedChoice` | 后续无 index chunk | 续写 | yes | 未知 |
| `TestChatTranslationEquivalentNumericIndexes` | 0 与 0.0 | 等价 | yes | 未知 |
| `TestParallelToolCallIDs` | 并行三 call | 每个 function_call 的 call_id 与自身 args 匹配 | yes | 部分（有测 late id） |
| `TestReasoningSentUnderBothNames` | 同 delta 双字段 | 去重拼接一次 | yes | 部分（extract 取其一） |
| `TestStreamedCallStopsForTool` | Responses completed 空 output 但已有 function_call | stop=`tool` | yes | 未知 |
| `TestChatTranslationToolCallIDRepeated` | 每片重复同一 id | **一个** call，args 拼接 | yes | 部分 |
| `TestRepeatedToolCallIDOpensOneBlock` | →Anthropic | 一个 tool_use，整 JSON | yes | 部分（Anthropic 整块 finish） |
| `TestRepeatedToolCallIDKeepsParallelCalls` | index 0/1 | 两 call 分离 | yes | 部分 |

---

### J. Stream errors（`stream_error_shape|open|passing_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestMalformedStreamErrorsFailTheReply` | Anthropic/Chat 畸形 error 或异协议事件 → Codex Responses 客户端 | 结束为 `response.failed`，非空 completed（#1933） | yes | **缺**（静默丢） |
| `TestMalformedResponsesErrorsFailTheReply` | Responses error → Messages 客户端 | `error` 事件且无 `message_stop` | yes | 缺 |
| `TestMalformedStreamErrorFailsUnstreamed` | 非流 | HTTP≥400 + 上游错误文案 | yes | 未知 |
| `TestWellFormedStreamsStillComplete` | 正常/空 end_turn | `response.completed` | yes | 部分 |
| `TestStreamErrorKeptOpenFailsOverAtOnce` | 流错误后换 key | 立即 failover | **no**/partial | 多账号层；非协议适配核心 |
| `TestStreamErrorSaysItPasses` | 502/503/… 文案 | 对 Pi 可判定可重试；400/401/404 原文 | partial | 未知 |
| `TestGroupLastFailureInStreamSaysItPasses` | 组路由 | keepalive + 可重试文案 | no | 不适用 |
| `TestStreamedByteCapSaysRequestTooLargeToPi` | 流已开后 413 HTML | 错误含 `request_too_large` | partial | 未知 |
| `TestStreamErrorByteCapInEveryShape` | 三协议 413 | Chat/Anthropic type=`request_too_large`；真 context 过长保持 `context_length_exceeded` | partial | 未知 |

---

### K. Chat from Anthropic upstream（`chat_from_anthropic_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestChatFromAnthropicStreamsAsItComes` | Chat 客户端 ← Anthropic 上游分片 | **实时转发**，不 hoard 整包；间隙反映上游 pause | **no**（我们上游是 Chat） | 不适用 |

---

### L. Custom tools（`custom_tool_test.go`, `codex_custom_tools_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestCustomToolTranslatedWhereRefused` | Codex custom `exec` → 拒 custom 的 Responses | 降级为 function；回客户端仍 custom；下次直接翻译 | yes | **已有** custom↔function |
| `TestCustomToolRefusalInGroup` / `RefusalWordings` | 组内拒词 | 触发翻译策略 | partial | 未知 |
| `TestCodexCustomToolsTranslated` | code mode namespaced exec/wait | 出站 function；回程 custom_tool_call；input 原样 | yes | **部分**（有 custom/local_shell；namespace/code mode 未知） |
| `TestCodexCustomToolNamespaced` | namespace | 名称空间处理 | partial | 未知 |

---

### M. Prompt cache（`prompt_cache_test.go`）

| Test | Input | Expected | Chat-up | 本仓库 |
|---|---|---|---|---|
| `TestCodexThreadOnChatUpstreamCaches` | Codex `prompt_cache_key` + 多轮 | key 透传；前缀 messages **字节稳定**；usage→`cached_tokens` | yes | **部分**（key 有；前缀稳定依赖 mend 确定性） |
| `TestPromptCacheKeyRefused` | 上游 400 未知字段 | 剥 key 重试；非 key 错误不剥 | partial | 未知 |
| `TestChatUsageCache` | 各厂商 usage 字段 | 归一 CacheRead/Write | partial | 未知 |
| `TestAnthropicPromptCache` | →Anthropic | system/最后块自动 `cache_control: ephemeral`；thinking 不打标 | partial | **缺**（Q1） |

---

## Code Patterns（magpie 侧可执行模式摘要）

1. **统一 interrupted 文案**：`[The result of this tool call is unavailable: the turn was interrupted.]`（Chat tool 内容 / Anthropic `tool_result` JSON 字符串 + `is_error`）。
2. **三路径同构 mend**：`pairToolMessages`（Chat）≈ `pairToolItems`（Responses）≈ Messages `pairToolBlocks`。
3. **orphan 策略**：有内容则变 user/text；无 call 不发明；空 output 用占位 `"Tool result received."`。
4. **join 策略**：仅移动「打断未闭合 parallel run」的中间 message；幂等；不改 caller buffer。
5. **call_id**：空→稳定铸造；流式首片补、后片空省略；Anthropic 出安全 charset、入还原；Codex ≤64。
6. **流错误**：解码失败/异协议错误 → 显式 failed；禁止「无输出的 completed」。
7. **重复 id fragment**：同 id+同 index → 续写；新 id/新 name/新 index → 新 call。

---

## Caveats / Not Found

- 未拉取实现体（`pairToolItems`/`joinToolRuns`/`chatCallIDs` 等）的完整源码；规格以**测试断言与注释**为准。
- `search/code` API 对本仓库账号 404；文件经 `raw.githubusercontent.com/yetone/magpie/main/internal/gateway/` 获取。
- 「本仓库覆盖」基于 `parity-gap-matrix.md` + `lib/*adapter.js` / `protocol-common.js` 与测试名对照，**非本轮全量跑测证明**；标「未知」者需 implement/check 阶段补断言。
- Chat-upstream-only 网关：**不需要**实现 Responses↔Responses sealed 原样、subscription bridge、组 failover；但 **需要**在「入站三协议 → Chat」边界实现 pairing/id/流错误等 yes 项。
- `tool_search`：magpie 降级为 function；本仓库当前按托管工具拒绝——是否改降级属 PRD D1/D2，不在本文件裁决。
