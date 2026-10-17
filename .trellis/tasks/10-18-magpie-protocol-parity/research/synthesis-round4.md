# Round 4 综合（1+2+3）

日期：2026-10-18  
明细：`magpie-pairing-algorithms-round4.md` · `cline-pass-model-matrix-round4.md` · `client-validation-rules-round4.md`

## 结论

调研已足够支撑冻结 PRD：实现应跟 magpie **mend 相位顺序**，优先满足 Codex/Claude **客户端硬校验**，再按 **cline-pass 模型族**打开 reasoning 回放。

## 4.1 Pairing — 必须落地的相位

```
0 joinSplitCalls → 1 joinToolRuns → 2 orphan→user → 3 pairTool*(interrupted)
→ 4 清 thinking-only assistant → 5 ID 卫生（charset / ≤64 / ctc_）
```

- 干净交换：**字节级不变**（idempotent）
- 合成文案固定：`[The result of this tool call is unavailable: the turn was interrupted.]`
- JS 宿主：`responses-adapter` / `anthropic-adapter` 入站 toChat 前；公共可抽 `lib/tool-pairing.js`

## 4.2 模型矩阵 — 适配器动作

| 族 | 必做 | 置信度 |
|---|---|---|
| DeepSeek | tool 轮 `reasonFirst`；无文本用 `" "` 占位 | high |
| Kimi | 严格 pairing + `reasoning_content`；折 `reasoning_details` | high |
| MiMo | 同 thinking 回传完整 `reasoning_content` | med–high |
| GLM | 历史明文回传；**勿**误套 DS 空格占位 | med–high |
| Qwen | 三拼写提取；注意 cache_write | med |
| MiniMax | 若见 `<think>` 则拆分；经 Cline 形态未 live 核 | med |

未做 Cline live 调用；实现后应用真实账号抽检 DeepSeek/Kimi。

## 4.3 客户端硬规则 → 本仓映射

| 客户端规则 | Gap | Slice |
|---|---|---|
| R1 禁空 `response.completed` | G9 | A |
| R2 Anthropic fail 勿假成功结束；A14 关 block | G9/A14 | A |
| R4 call_id ≤64 | G6 | C |
| R6 tool_use charset | G5 | C |
| R7 thinking 字段必填 | G10 | A |
| R8 thinking+tool 块序/回传 | G8/G10 | A+D |
| R11/R12 并行/orphan | G1–G3 | B |

Issue 号多为 **yetone/magpie**；Codex 空 completed 钉在 **0.162.0-alpha.17.2**，换版需重测。

## 推荐冻结范围（待用户确认）

| Slice | 内容 | 依据 |
|---|---|---|
| **A** | G9、A14、G10、G11、A8、A11 | R1/R2/R7 |
| **B** | G1–G3 heal（含固定 interrupted 文案） | 4.1 + R11/R12 |
| **C** | G4–G7（id + tool_search） | R4/R5/R6 |
| **D** | G8 + 模型矩阵（DS/Kimi 优先；MiniMax 条件开启） | 4.2 |
| **E** | P1 补测 / cache_control 等 | 可后续子任务 |

**不做**：真 sealed、affinity、指纹注入、IR 重写。
