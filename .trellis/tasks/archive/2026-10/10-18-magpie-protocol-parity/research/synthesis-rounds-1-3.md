# 深度调研综合（Round 1–3）

日期：2026-10-18  
任务：`10-18-magpie-protocol-parity`  
来源：`magpie-test-specs-round1.md` · `switcher-behavior-audit-round2.md` · `cline-upstream-risks-round3.md` · `parity-gap-matrix.md`

## 一句话

本仓库三协议主路径已能跑通 Codex/Claude 干净工具循环；与 magpie 的差距集中在**历史治愈、流式失败形态、id 卫生、Cline 模型 reasoning 回放**，而不是再造 IR 多上游。

## 纠正：早期 G1 表述

| 旧表述 | 实测 |
|---|---|
| 未答 tool call → 400 | **错误**。未答 open call **不 400**，只是**不合成** interrupted；真正 400 的是 orphan output / 缺 call_id / 重复 id |

## Agent 挂断风险 Top 10（综合三轮）

| 序 | ID | 行为缺口 | 主要受害方 |
|---|---|---|---|
| 1 | G1+G3 | 不合成 interrupted；无 join/乱序重排 | Codex/Claude 中断或并行后续聊 |
| 2 | G9+A14 | 畸形 SSE 静默丢；`[DONE]` 无 choice 仍可能空 `completed`；Anthropic `fail` 不关 block | Codex 静默结束；Claude 挂起 |
| 3 | G2 | orphan / 空 call_id → 400（magpie→user） | Codex 跨线程通知 |
| 4 | G5 | Anthropic id charset 无编解码 | Claude Code 非法 id |
| 5 | G4+G6 | 入站缺 id 400；无 ≤64 / 前缀映射 | 长会话 pairing |
| 6 | G8+Cline | 无 DeepSeek `reasonFirst`；Kimi `reasoning_details` / MiniMax `<think>` 薄 | cline-pass thinking 模型 |
| 7 | G7 | `tool_search` 当托管拒绝 | Codex tool_search |
| 8 | G10 | 非流 signed empty thinking 整块省略 | Claude 校验 |
| 9 | G11 | 无「同 id fragment 续写」；无 index 启发式可能错槽 | 交错工具流 |
| 10 | A8 | Anthropic `max_tokens` 无默认 | Claude 省略字段 → 上游 400 |

## 本仓库已扎实（勿重做）

- custom / local_shell ↔ function + fixture
- `clps1.` 封条当前环回传
- 托管工具 / 有状态字段显式 400
- Cline `{data:choices}` SSE 解包、非流式 unwrap、首包 wrapped error failover
- `stream_options.include_usage` 强制
- Chat 三路由透传；协议错误信封
- **产品策略**：不伪造 Cline Desktop 指纹（与 magpie `cline_client` 注入相反，保持本仓策略）

## Magpie 有、本期应谨慎或不做

| Magpie | 原因 |
|---|---|
| 真 sealed 同协议回传 | Chat 上游无源 |
| Affinity / foreign_seal | 多上游账户层 |
| Claude subscription bridge / Cache-Marks | 进程桥 |
| Cline Desktop 指纹头注入 | 与本仓安全边界冲突 |
| `ClinePin` / 免费日限额按模型休息 | 路由/配额产品另任务 |
| Gemini | 非三协议目标 |

## Cline 上游硬化要点（Round 3）

1. `unwrapChatPayload` 可考虑认 `success:false`（对齐 magpie 非流式），流式保持按帧。
2. 出站 `extractReasoning` 已覆盖三拼写；**入站历史**与 **tool 后 reasonFirst** 仍缺。
3. MiniMax `<think>` 拆条、Kimi `reasoning_details` 入站历史。
4. Anthropic usage：有 cache_read 减法；缺 `cache_creation_input_tokens`（P1）。

## 建议实现分期（供 PRD 冻结用，尚未批准）

### Slice A — 流式正确性（低争议）

G9、A14、G11 补测、G10、A8、A11

### Slice B — Tool 历史治愈（产品决策：heal vs 严格）

G1、G2、G3、重复 result 只留首次、thinking-only assistant 丢弃

### Slice C — ID 卫生

G4、G5、G6、`ctc_`/`tsc_` 与 tool_search（G7）

### Slice D — Cline thinking 模型

G8 reasonFirst（按模型/可探测）、MiniMax `<think>`、入站三拼写历史

### Slice E — P1 质量

Q1–Q6、A2–A4、A12；补测为主项优先

## 仍建议的下一轮深挖（可选 Round 4）

若继续调研再动手：

1. **拉取 magpie `pairToolMessages` / `pairToolItems` / `pairToolBlocks` 源码算法**，写成伪代码契约（避免只抄测试名）。
2. **对 cline-pass 各模型**（glm / kimi / deepseek / qwen / minimax）用真实或抓包样本验证 reasoning 字段与 tool 后约束。
3. **对照 Codex CLI / Claude Code 当前版本**对空 `completed`、thinking 字段、call_id 长度的客户端校验（版本敏感）。

## 文件索引

```
research/magpie-edge-capabilities.md
research/parity-gap-matrix.md
research/magpie-test-specs-round1.md
research/switcher-behavior-audit-round2.md
research/cline-upstream-risks-round3.md
research/synthesis-rounds-1-3.md          ← 本文件
```
