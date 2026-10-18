# Research: Codex CLI / Claude Code 客户端校验规则（Round 4.3）

- **Query**: Codex CLI 与 Claude Code 对 Responses / Anthropic Messages 网关的客户端侧校验规则；网关必须满足什么才不会被客户端静默成功、挂起或 400
- **Scope**: mixed（Magpie 测试/注释 + 公网 GitHub / OpenAI Responses API 约束 + 本仓适配器与既有 rounds）
- **Date**: 2026-10-18

## 版本与置信度说明

| 来源层级 | 含义 | 置信度 |
|---|---|---|
| **A** Magpie 测试注释 + 可执行断言（`/tmp/magpie-gw`、`/tmp/magpie-tests-r1`） | 以真实客户端复现或 wire 抓包驱动的契约 | **高**（行为经测试钉死；issue 号多为 yetone/magpie 追踪号，不是 openai/codex / anthropics/claude-code 上游号） |
| **B** Magpie issue 正文（如 #1933）附带 Codex CLI 版本与复现 | 点名客户端版本 | **高**（该版本）；**中**（跨版本外推） |
| **C** OpenAI Responses API / Anthropic Messages API 服务端 400 | 客户端回放历史时也会撞到 | **高**（API 契约）；客户端是否本地预校验因版本而异 |
| **D** 第三方网关/代理的同类修复 PR | 旁证同一约束在生态中反复出现 | **中** |
| **E** 本仓 Round 1–3 审计对「我们当前状态」的描述 | 以 `lib/*-adapter.js` 为准 | **高**（对照代码）；实现随时可变 |

**版本敏感点（务必重测）**：

- Magpie #1933 复现用 **codex-cli 0.162.0-alpha.17.2**：空 `response.completed` → exit 0、不触发 stream retry。
- Claude Code / Anthropic：`thinking` 字段必填、`tool_use.id` charset，随 Claude Code / SDK / API 校验层可能叠加（客户端解析失败 vs API 400）。
- `call_id` ≤64：OpenAI Responses **API** 层稳定拒绝；Codex 走 ChatGPT 自有后端时同样拒绝（Magpie #732）。
- Issue 编号若无仓库前缀，默认指 **yetone/magpie**（如 #1933/#1304/#1447/#732/#1786/#2372），勿与 openai/codex 同号混淆。

---

## Findings

### 规则总表

| ID | 客户端 | 规则 | 失败症状 | Magpie 处理 | 本仓当前状态 | 优先级 |
|---|---|---|---|---|---|---|
| R1 | **Codex CLI**（Responses SSE） | 流必须以明确失败结束：`response.failed`（或非 200 错误），**禁止**在上游已出错时发空 `response.completed`（`status:completed`、`output:[]`、usage 全 0） | Codex 把空 completed 当回合正常结束：exit 0、`turn.completed`、**不**走 stream retry（Magpie #1933；测于 codex-cli 0.162.0-alpha.17.2） | `TestMalformedStreamErrorsFailTheReply`：畸形/异协议 SSE → 终端 `response.failed`；`responses.go`/`chat.go`/`anthropic.go` 注释 #1933 | 畸形 SSE JSON **静默丢**（`protocol-common.js` parse catch → `[]`）；缺终态时仍可能 `finish`→空 `completed`（Round2 G9） | **P0** |
| R2 | **Claude Code** / Anthropic Messages 客户端 | 流失败须发 `error` 事件，且**不要**再发 `message_stop`（失败后「完整成功结束」会误导） | 客户端当成功结束或漏重试；与 R1 对称 | `TestMalformedResponsesErrorsFailTheReply`：要 `error` 且无 `message_stop` | Anthropic `fail` 路径存在，但畸形事件静默丢；空 end_turn 仍可能「成功完成」（Round2 G9） | **P0** |
| R3 | **Codex CLI** | 流被截断（unexpected EOF / stream disconnected before completion）视为失败；网关不得因编码器 panic 提前关流 | hang / 重试耗尽 / 无最终消息（Magpie #1786，tool 后接 hidden thinking） | `TestResponsesStreamToolThenHiddenThinking`：tool 后 redacted/空 thinking 仍完整 `response.completed` + 正确 function_call | 本仓无 Anthropic→Responses 隐藏 thinking 专用路径；直连 Chat 上游时风险较低，跨协议译法未测 | **P1**（跨协议时升 P0） |
| R4 | **Codex / OpenAI Responses**（含 ChatGPT 后端 + 任意 `openai_base_url`） | 历史中每条 `function_call` / `*_output` 的 `call_id` **≤ 64**；call 与 output **同 id**；跨请求映射稳定 | HTTP 400：`input[N].call_id … maximum length 64` / `string_above_max_length`（Magpie #732；生态大量旁证） | `boundCallIDs` + `TestCodexRelayBoundsLongCallIDs`（86/87 字符 → ≤64，成对、跨请求一致）；≤64 原样保留 | **无**长度截断/哈希映射（Round2 G6）；出站 `call_id` 跟 Chat id | **P0** |
| R5 | **Codex** custom / tool_search 历史 | 出站 custom 的 **item `id`** 用 `ctc_`（ChatGPT 认可种类）；`call_id` 仍为模型侧 id；compaction 等路径保留 `tsc_` 等原生前缀语义 | custom 历史不被后端接受 / pairing 断裂（Magpie `call_item_ids_test.go`） | `TestCustomToolCallHasCtcID`、`TestCodexOwnModelCustomCallIDs` | 出站已有 `ctc_`/`lsc_`/`fc_` item id；**无**长 id 与 `tsc_` 入站逆映射完整层 | **P1**（与 R4 联动） |
| R6 | **Claude Code**（及 Anthropic Messages API） | `tool_use.id` / `tool_result.tool_use_id` 仅 `[A-Za-z0-9_-]+` | Claude Code：**「The model's tool call could not be parsed (retry also failed)」**（Magpie #1304，Devin `Bash:0#…`）；API：**400 String should match pattern**（claude-agent-sdk#856 等） | `anthropicOutID`/`anthropicInID`（`mp_`+base64url）；`TestAnthropicCallIDsSafeBothWays` | **原样透传** Chat id，无 charset 编解码（Round2 G5） | **P0** |
| R7 | **Claude Code / Anthropic Messages**（及 OpenCode Go 等硬校验客户端） | 有 signature 的 `thinking` 块**必须**带 `"thinking"` 字段；可为空串 `""`，不可省略键 | 400：`messages.N.content.0.thinking.thinking: Field required`（Magpie #1447） | `aBlock.MarshalJSON` 对 thinking 强制写出字段；`TestSignedThinkingWithNoTextKeepsTheField` | 非流：无 reasoning 文本则**整块省略**；流式 start 有 `thinking:''`，但「仅 signature、无文本」非流契约 **NO TEST**（Round2 G10） | **P0** |
| R8 | **Claude Code / Anthropic API**（thinking enabled） | 工具环：最终 assistant 须以 `thinking`/`redacted_thinking` 开头；回传块须完整未改（含空 thinking + signature、redacted） | 400：Expected `thinking` or `redacted_thinking`, but found `tool_use`/`text`（claude-code#1179/#14264 等；官方 thinking-tool-workflows） | 保留多 thinking + redacted 分离（`reasoning_state_anthropic_test.go`）；出站强制 thinking 字段（R7） | 有当前环 thinking 回传；`redacted_thinking` 入站丢弃；空签名块省略风险（G8/G10） | **P0**（thinking 开时） |
| R9 | **Codex CLI** | 不得把 Anthropic 密封 thinking（signature / redacted）泄漏为 Responses 客户端可读 reasoning；可见摘要才可成 reasoning item | 错误展示 / 协议 panic / 流截断（与 #1786 同族） | Responses 路径过滤密封 thinking；仅 visible thinking → reasoning item | Chat 上游无 Anthropic 密封块时 N/A；若将来接 Anthropic 上游需对齐 | **P2**（当前 Chat-only） |
| R10 | **Codex / Claude / Pi**（流已开始后的错误文案） | 可重试错误文案须含客户端 deny/allow 列表可识别词（overloaded、429、502…）；配额类勿伪装成可重试 | 客户端结束回合不重试，或无限重试（Magpie #2372；Pi `isRetryableError` 文本判定） | `TestStreamErrorSaysItPasses` / `saysPassing` | 本仓有 `response.failed`/`error` 消息透传；**无** Pi/Codex 专用文案改写层（Round1 #19） | **P2** |
| R11 | **Claude Code** | 并行 tool_result 可跨多条 user 到达；网关/上游须能配对，客户端本身按 id 关联 | 错序导致上游 400 或模型混乱（客户端发送形态，非客户端校验失败） | `join`/`pair`/`TestChatToolResultsGatherAcrossUserMessages` | 严格顺序配对，无乱序重排（G1/G3） | **P0**（历史治愈，非纯「客户端校验」但影响存活） |
| R12 | **Codex** | orphan / 跨线程 standalone `function_call_output`（无匹配 call）客户端会发出；网关不应 400 掐断 | 跨线程通知被拒（Magpie orphan 测试） | orphan → user message | 缺 call_id / orphan → **400**（G2） | **P1** |
| R13 | **OpenAI Responses API / Codex 回放** | `function_call.name` 回放时建议 `^[a-zA-Z0-9_-]+`（API 400；生态 PR 旁证） | 400 invalid name pattern | Magpie 主要钉 call_id；name 未在本轮测试集中心 | 本仓透传 name | **P2** |
| R14 | **Claude Code 会话形** | 复合会话（多轮 tool、thinking-only 中断等）重放须仍通过 id 唯一、配对合法 | 会话损坏后整段不可续 | `TestChatSessionShapeStaysValid` 等 | 无 Claude 长会话 shape 测 | **P2** |

---

### 分规则详解

#### R1 — 空 `response.completed`（Codex #1933）

**规则**：对 Codex，`response.completed` + 空 output 会被当作**成功终态**，不会触发 stream retry。

**证据**：

- Magpie `stream_error_shape_test.go:14-18`：「Codex took #1933's response.completed with no output as its turn's end, exit 0, and never used its stream retry。」
- Magpie issue [#1933](https://github.com/yetone/magpie/issues/1933)：对照实验——空 completed 1 次 POST exit 0；标准 error 对象 2 次 POST 后 exit 1。消费者 **codex-cli 0.162.0-alpha.17.2**。
- Magpie `responses.go:1406-1416`：`response.failed` / status failed → `KError`，「never a whole reply (#1933)」。

**Magpie**：畸形 Anthropic/Chat 错误、异协议事件 → 译成 Codex 侧 `response.failed`。

**本仓**：见 Round2 G9；`protocol-common.js:76` JSON 失败返回空事件列表。

#### R4 — `call_id` ≤64

**规则**：Responses `input[*].call_id` 最大 64；成对一致。

**证据**：

- Magpie `codex_call_id_test.go` / `codex_backend.go:1984-1990`（#732）。
- 生态：nanobot#1634、pi-mono#1022、Roo-Code/Hermes/OmniRoute 等多处 clamp 到 64。

**注意**：这既是 **API** 校验，也是 Codex 把历史回放给 ChatGPT/兼容后端时的硬条件；网关出站与入站映射都必须成对。

#### R6 — Claude `tool_use` id charset

**规则**：仅 `[A-Za-z0-9_-]`。

**证据**：

- Magpie `anthropic.go:1358-1367`、`anthropic_call_ids_test.go`（#1304，`Bash:0#a65b…` → 客户端「could not be parsed」）。
- Anthropic API 同模式 400（claude-agent-sdk-python#856：`functions.AskUserQuestion:1`）。
- Claude Code 可能在**本地解析**阶段就丢弃非法 id（Magpie 描述），API 也可能在下一轮 400——两层都要防。

#### R7 — thinking 字段必填

**规则**：signed / display-omitted thinking 必须有 `"thinking": ""`。

**证据**：Magpie `thinking_block_test.go`、`anthropic.go:53-69`（#1447，OpenCode Go Claude 模型文案）。Claude 官方文档亦写明 display omitted 时 thinking 可为空串并带 signature，回传须完整。

#### R8 — thinking 开启时的块顺序

**规则**：thinking enabled 时，含 tool_use 的最终 assistant 须以 thinking/redacted_thinking 开头；回传不可剥块。

**证据**：Anthropic 文档 [Thinking in tool and multi-turn workflows](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows)；claude-code issues #1179、#14264、#12894。

**与 R7 关系**：R7 是单块 JSON 形状；R8 是多轮消息结构。网关两者都要满足。

---

### Files Found

| File Path | Description |
|---|---|
| `/tmp/magpie-tests-r1/stream_error_shape_test.go` | #1933 空 completed vs failed |
| `/tmp/magpie-tests-r1/codex_call_id_test.go` | #732 call_id ≤64 |
| `/tmp/magpie-tests-r1/anthropic_call_ids_test.go` | #1304 charset 双向 |
| `/tmp/magpie-tests-r1/thinking_block_test.go` | #1447 thinking 字段 |
| `/tmp/magpie-tests-r1/responses_hidden_thinking_test.go` | #1786 流完整性 |
| `/tmp/magpie-tests-r1/stream_error_passing_test.go` | #2372 可重试文案 |
| `/tmp/magpie-gw/anthropic.go` | MarshalJSON thinking；anthropicOutID/InID |
| `/tmp/magpie-gw/codex_backend.go` | `boundCallIDs` |
| `/tmp/magpie-gw/responses.go` | failed ≠ completed（#1933） |
| `lib/responses-adapter.js` / `lib/anthropic-adapter.js` | 本仓实现 |
| `lib/protocol-common.js` | SSE JSON 静默丢 |
| `.trellis/tasks/…/research/switcher-behavior-audit-round2.md` | G5/G6/G9/G10 状态 |
| `.trellis/tasks/…/research/magpie-test-specs-round1.md` | 测试规格索引 |
| `README.md` | Codex/Claude 接入说明（会话键，非协议边角） |

### Code Patterns

- Magpie 对「客户端硬校验」一律用**可逆、确定性、无状态**映射（call_id 绑定、`mp_`+base64url），保证 prompt cache 前缀与跨请求配对。
- Codex 对「失败形态」极敏感：**成功壳 + 空内容**比显式 error 更糟（不重试）。
- Claude 对「thinking / id 形状」极敏感：缺字段或非法字符 → 本地解析失败或 API 400。

### External References

- [yetone/magpie#1933](https://github.com/yetone/magpie/issues/1933) — Codex 空 completed / 不重试（含 CLI 版本）
- [OpenAI Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create) — API 侧 input 约束背景
- [Anthropic thinking tool workflows](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows) — thinking 回传规则
- [anthropics/claude-agent-sdk-python#856](https://github.com/anthropics/claude-agent-sdk-python/issues/856) — tool_use.id pattern 400
- [anthropics/claude-code#1179](https://github.com/anthropics/claude-code/issues/1179) 等 — thinking 块顺序 400
- 旁证：nanobot#1634、pi-mono#1022、Roo-Code#10763 — call_id 64

### Related Specs

- `.trellis/spec/` 本轮未新增协议校验专章；行为以 PRD + Round1–3 research 为准。
- 任务 PRD：`.trellis/tasks/10-18-magpie-protocol-parity/prd.md`（Codex/Claude 边角、禁止静默空成功）

## Caveats / Not Found

- **未**在本机检出 openai/codex 与 anthropics/claude-code 源码树；客户端「本地预校验 vs 仅依赖 API」边界依赖 Magpie 注释 + issue，**应用当前 Codex/Claude 版本重放 R1/R6/R7**。
- Magpie issue 号与 upstream 仓库 issue 号**不可互换**；表中已标注。
- R10 文案规则主要钉的是 **Pi**；Claude/Codex「曾因此再问」来自 Magpie #2372 叙述，精确正则可能随客户端版本漂移（置信度中）。
- `function_call.name` 字符集（R13）有生态 API 400 旁证，Magpie 本轮测试重心在 call_id，**未**找到 Magpie 对 name 的对等单测。
- 本仓「当前状态」取自 2026-10-18 Round2 审计 + 对 `lib/*.js` 的点查；若之后有未提交改动，以代码为准。
