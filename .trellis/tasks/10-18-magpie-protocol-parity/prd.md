# 参考 magpie 完善三协议适配边角

## Goal

对照 [yetone/magpie](https://github.com/yetone/magpie) 的 Codex / Claude Code 边角处理，在本仓库「Chat 上游上的有损三协议子集」上落地 Slice **A+B+C+D**（含 magpie 式 tool 历史 **heal**），使中断、乱序、缺 id、流式失败、thinking 回传等场景可续聊或显式失败，而不再造 IR 多上游。

## Decisions（已确认）

| ID | 决定 |
|---|---|
| D1 | 本期范围 = **A + B + C + D**；E（P1 质量项）仅允许「为 A–D 必需的补测」，不单独立项扩 scope |
| D2 | Slice B 采用 magpie **heal**：合成 interrupted、orphan→user、乱序重排；干净交换 **字节级不变** |
| D3 | `tool_search` 从托管拒绝改为 function 降级并回译（属 Slice C） |
| D4 | 不注入 Cline Desktop 指纹；不做真 sealed / affinity / foreign_seal / Gemini / IR 重写 |
| D5 | interrupted 合成文案与 magpie 字节一致：`[The result of this tool call is unavailable: the turn was interrupted.]` |

## Background

- 基线：归档 `10-13-three-protocol-adapter`；`lib/{protocol-common,responses-adapter,anthropic-adapter}.js`
- 调研：`research/synthesis-rounds-1-3.md`、`research/synthesis-round4.md` 及 Round1–4 明细
- 上游仍为 Cline Chat Completions；Responses / Anthropic 有损子集定位不变

## Requirements

### 共性

- R0 Chat Completions 三路由请求/响应/SSE/统计/日志行为不变。
- R1 托管执行类工具（除 `tool_search`）与有状态 Responses 字段的拒绝清单保持；未知顶层字段仍忽略。
- R2 不引入新运行时依赖；不持久化 response；不执行工具；普通日志无正文；`inboundProtocol` 不变。
- R3 README「三协议」节更新 support/reject/heal/有损说明（不引用 magpie 品牌为依赖）。
- R4 质量门：`npm test`、`node --check`（触及模块）、`git diff --check`。

### Slice A — 流式正确性

- RA1 畸形 Chat SSE JSON 不得静默丢尽后当成功；须能驱动协议失败（Responses `response.failed` / Anthropic `error`）。
- RA2 禁止在「无有效 choice / 无有效 output 且无明确成功终态」时发空 `response.completed`（Codex R1 / Magpie #1933）。
- RA3 Anthropic 流式 `fail` 须先关闭已开 content block，再发 `error`；失败路径不发误导性完整成功收尾（对照客户端 R2；与 magpie「fail 后无 message_stop」对齐处写入 design）。
- RA4 有 signature 的 thinking 块非流式也必须带 `"thinking"` 键（可 `""`）（R7）。
- RA5 Chat 流聚合：只取 first choice；同 tool call id 的 fragment 续写同一槽；补测。
- RA6 Anthropic `max_tokens` 缺省时填安全默认（4096）或在 toChat 前协议 400（design 选定一种并测）。
- RA7 function/tool arguments 空串按 `"{}"` 规范化（出站 Chat / 回译边界按 design）。

### Slice B — Tool 历史 heal

- RB1 入站 toChat 前对 Chat messages 跑 heal（相位对齐 magpie：joinSplitCalls 等价 → joinToolRuns（Responses）→ orphan→user → pair 合成 interrupted → 清理 silent/thinking-only assistant）。
- RB2 未答 call → 合成 tool 结果，文案 = D5。
- RB3 orphan / 空 call_id 的 output → user 文本（可与前一 user `\n\n` 合并）；不造假 call。
- RB4 重复 result 只保留首次；乱序 result 按 call 声明序；夹杂 message 按 joinToolRuns 语义重排。
- RB5 已干净的交换再 heal **不改变语义形状**（idempotent；测试断言结构稳定）。
- RB6 原「orphan / 缺 call_id → 400」行为改为 heal；仍拒绝无法理解的未知 item type / 托管工具等。

### Slice C — ID 卫生 + tool_search

- RC1 入站缺 call_id：稳定铸造（同请求内 call↔output 一致），不再 400。
- RC2 流式：空 id 铸造后 mend；已发出的 call_id 不因晚到上游 id 撕裂（与现测一致处保留；design 写清不可回写已发事件的限制）。
- RC3 Anthropic `tool_use.id` / `tool_result.tool_use_id`：出站仅 `[A-Za-z0-9_-]`，入站可逆还原（R6）。
- RC4 Responses `call_id` 出站 ≤64，call↔output 同映射、跨请求稳定（R4）。
- RC5 `tool_search` ↔ Chat function 往返；item 种类/前缀按现有 custom 模式扩展（`tsc_` 等与 design）。

### Slice D — Cline thinking 模型

- RD1 模型名含 `deepseek`（及 design 列出的等价判定）：含 `tool_calls` 的 assistant 及 tool 轮后续 assistant 缺 reasoning 时写入占位（Magpie 用单个空格 `" "`），字段名 `reasoning_content`。
- RD2 Kimi / MiMo：历史回传保证 `reasoning_content`（或三拼写折入）；勿把带 `index` 的 `reasoning_details` 原样打到严格上游。
- RD3 GLM：回传历史明文 reasoning；**不**误套 DeepSeek 空格占位。
- RD4 MiniMax：若 content 含 `<think>…</think>` 则拆到 reasoning 出站；经 Cline 未见标签则 no-op。
- RD5 现有 `clps1.` 封条当前环回传保留；与 RD1–RD4 合成规则在 design 中定义优先级。

## Acceptance Criteria

- [x] AC1 Chat Completions 现有测试不改断言即通过。
- [x] AC2 Slice A：畸形 SSE / 空 completed 路径 → Responses `failed` 或等价失败；Anthropic fail 关闭 open block；signed empty thinking 含 `thinking:""`；相关单测+至少一条协议集成测。
- [x] AC3 Slice B：未答 call / orphan / 乱序 / 干净 idempotent 四类 fixture（Responses + Anthropic 或共享 Chat heal 层）单测通过；集成路径可续聊（零错误租约浪费）。
- [x] AC4 Slice C：charset 往返、call_id≤64 成对、缺 id 铸造、`tool_search` 降级回译单测通过。
- [x] AC5 Slice D：DeepSeek 形 tool 轮必有 `reasoning_content`（含占位）；Kimi/MiMo/GLM/MiniMax 按矩阵有测或明确 skip+理由。
- [x] AC6 统计/日志仍各计一次；无正文；`inboundProtocol` 过滤仍可用。
- [x] AC7 `npm test`、触及模块 `node --check`、`git diff --check` 通过。
- [x] AC8 README 三协议节已更新 heal / tool_search / 失败形态说明。

## Out of Scope

- 真 `encrypted_content` / `redacted_thinking` 同协议字节回传
- Affinity / foreign_seal / Claude subscription 桥 / Cache-Marks
- Gemini、服务端工具执行、Responses 有状态 API
- Cline Desktop 指纹注入、`ClinePin`、按模型免费日限额
- 全面 Go IR 重写；P1 项 Q1 自动 cache_control、Q4 forVendor 等（除非实现 A–D 必须）

## Notes

- 另有 `10-18-request-log-target-vs-actual`（in_progress）；本任务独立。
- 若单 PR 过大，可按 Slice 拆子任务，但本期以本目录为唯一需求源。
