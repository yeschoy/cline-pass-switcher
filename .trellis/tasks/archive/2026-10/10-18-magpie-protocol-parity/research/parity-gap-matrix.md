# 本仓库 vs Magpie：差距矩阵

本仓库基线：归档任务 `10-13-three-protocol-adapter`；实现 `lib/{responses,anthropic}-adapter.js`、`lib/protocol-common.js`。  
综合更新：Round 1–3 → 见 `synthesis-rounds-1-3.md`。

## 本仓库已有（不必重做）

| 能力 | 现状 |
|---|---|
| Responses/Anthropic → Chat → 回译 | 有损子集已上线 |
| custom / local_shell ↔ function | 已实现 + 单测 |
| 推理封条 `clps1.` + 当前工具循环回传 | 已实现；非法/轮次外丢弃 |
| 图片 URL/data URL | 已实现 |
| 托管工具 / 有状态字段显式 400 | 已实现 |
| orphan output / 缺 call_id / 重复 id | **400**（与 magpie heal 不同） |
| 未答 open call | **不 400、不合成**（Round 2 纠正） |
| 流式 typed SSE / Anthropic 事件序 | 已实现；Anthropic tool 整块 finish 发出 |
| Cline `{data:choices}` 解包 / 首包 wrapped failover | server + reader 已有 |
| `prompt_cache_key` / Claude identityHints | 会话层已有 |
| Codex/Claude 两轮工具循环 fixture | 适配器单测 + 集成测 |
| 不伪造 Cline Desktop 指纹 | 有意与 magpie 不同 |

## P0 缺口（相对 magpie，Agent 易挂）

| # | Magpie 行为 | 本仓库 | 影响 |
|---|---|---|---|
| G1 | 未答 tool call → 合成 interrupted | **不 400、不合成** | 中断续聊上游「No tool output」 |
| G2 | orphan / 空 call_id → user message | **400** | Codex 跨线程通知 |
| G3 | joinSplitCalls / joinToolRuns 重排 | 无 | 严格 Chat「No tool output」 |
| G4 | 缺 call id 铸造 + 流式 mend | 出站可 newId；入站缺 id→400 | pairing 错配 |
| G5 | Anthropic id charset 编解码 | 原样透传 | Claude 非法 id |
| G6 | call_id ≤64 / ctc_/tsc_ 映射 | 无 | 长 id / custom 历史 |
| G7 | tool_search ↔ function | HOSTED 拒绝 | Codex tool_search |
| G8 | DeepSeek reasonFirst | 仅 clps1. 当前环 | thinking 模型 400 |
| G9 | 空/畸形流 → failed | SSE JSON 静默丢；可能空 completed | Codex 静默结束 |
| G10 | signed empty thinking:`""` | 非流空推理省略整块 | Claude 校验 |
| G11 | 同 id fragment 续写 | 无跨槽合并 | 交错工具错槽 |
| A14 | fail 先关已开 block | Anthropic fail 只发 error | Claude 挂起 |
| A8 | Anthropic max_tokens 默认 | 无默认 | 省略→上游 400 |

## P1 / 增量（质量）

| # | 能力 | 本仓库 |
|---|---|---|
| Q1–Q6 | cache_control / 入站三拼写历史 / MiniMax think / forVendor / ThinkOff / 补测 | 见 round2 |
| A1–A13 | stop/usage/parallel/system 合并/空 assistant/arguments `{}`/重名工具等 | 见 round2 |

## 明确不做

- 真 sealed 同协议回传；Affinity / foreign_seal；Claude subscription 桥
- Gemini；托管 web_search 执行；Cline Desktop 指纹注入；全面 IR 重写

## 建议实现切片（待 D1/D2）

| Slice | 内容 |
|---|---|
| A | G9、A14、G10、G11、A8、A11 — 流式正确性 |
| B | G1、G2、G3 — tool 历史治愈（需产品确认 heal） |
| C | G4、G5、G6、G7 — id 卫生 + tool_search |
| D | G8 + MiniMax/Kimi 入站 — Cline thinking |
| E | P1 / 补测 |

## 可选 Round 4

1. magpie pairing 算法伪代码（不仅测试名）
2. 各 cline-pass 模型 reasoning/tool 实测抓包
3. Codex/Claude 客户端当前版本校验规则
