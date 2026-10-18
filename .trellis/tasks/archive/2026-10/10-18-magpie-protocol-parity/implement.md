# 参考 magpie 完善三协议适配边角 — 执行计划

## 顺序原则

严格按 Slice **A → B → C → D**。每片：单测红 → 实现 → 单测绿 → 相关集成；片末 `node --check` + 聚焦 `node --test`。

权威算法：`research/magpie-pairing-algorithms-round4.md`  
客户端规则：`research/client-validation-rules-round4.md`  
模型矩阵：`research/cline-pass-model-matrix-round4.md`

---

## Slice A — 流式正确性

1. [ ] `protocol-common`：corrupt SSE 事件；`applyToolDelta` 同 id 续写；单测。
2. [ ] `responses-adapter`：`finish` 禁空 completed；单测（畸形/空 → failed）。
3. [ ] `anthropic-adapter`：`fail` 关 open block、不发成功 `message_stop`；signed empty thinking 含 `thinking:""`；`max_tokens` 默认 4096；arguments `""`→`"{}"`；单测。
4. [ ] `server.js` adapter 流终态：corrupt / 无有效输出 → `encoder.fail`；Chat 分支不动。
5. [ ] 集成：畸形上游 SSE → Responses failed / Anthropic error。
6. [ ] 门禁：`node --check lib/protocol-common.js lib/responses-adapter.js lib/anthropic-adapter.js server.js`；聚焦测试。

**Rollback**：还原上述文件；无数据迁移。

---

## Slice B — Tool heal

7. [ ] 新增 `lib/tool-pairing.js`：`INTERRUPTED_TOOL_RESULT`、`joinSplitAssistantCalls`、`withoutSilentAssistants`、`pairToolMessages`；`test/tool-pairing.test.js`（未答/orphan/乱序/重复/干净幂等）。
8. [ ] Responses：`joinToolRuns` + `orphanedToolOutputs`（可放 `lib/responses-pairing.js` 或 adapter 内）；convert 后调用 Chat heal。
9. [ ] Anthropic：convert 后调用 Chat heal；删除/放宽 orphan 400。
10. [ ] 适配器单测 + 必要时集成续聊。
11. [ ] 门禁：聚焦 pairing / adapter 测试。

**Rollback**：移除新文件并恢复 adapter toChat。

---

## Slice C — ID + tool_search

12. [ ] 新增 `lib/protocol-ids.js` + `test/protocol-ids.test.js`（≤64、anthropic charset 往返、缺 id 铸造）。
13. [ ] 接入 responses/anthropic toChat 与流式 encoder。
14. [ ] `tool_search` 移出 HOSTED，降级+回译+单测。
15. [ ] 门禁：聚焦 id / tool_search 测试。

**Rollback**：去掉 id 模块接入；`tool_search` 恢复 HOSTED。

---

## Slice D — Reasoning replay

16. [ ] `lib/reasoning-replay.js`（或 protocol-common 内）：按 model 族应用 RD1–RD4；与 `clps1.` 优先级按 design。
17. [ ] toChat 末尾调用；DeepSeek/Kimi/GLM/MiniMax 单测（MiniMax 无标签则测纯函数拆标签）。
18. [ ] 门禁：聚焦 reasoning 测试。

**Rollback**：移除 replay 调用。

---

## 收尾

19. [ ] README 三协议节：heal、tool_search、失败形态、thinking 占位说明。
20. [ ] 全量 `npm test`；`git diff --check`。
21. [ ]（可选）为 A–D 补 Q6 类 content_filter/json_schema 测，不扩 P1 功能。

---

## 验证命令

```bash
node --test test/protocol-common.test.js test/tool-pairing.test.js test/protocol-ids.test.js \
  test/responses-adapter.test.js test/anthropic-adapter.test.js
node --test test/protocol-integration.test.js
npm test
node --check lib/protocol-common.js lib/tool-pairing.js lib/protocol-ids.js \
  lib/responses-adapter.js lib/anthropic-adapter.js server.js
git diff --check
```

## Review gates

- 每 Slice 合并前：对应 AC 可演示；Chat 全量断言未改。
- 全完成后：对照 PRD AC1–AC8 勾选。

## 非目标（执行时勿做）

- affinity / 指纹 / sealed 真回传 / Gemini / 新依赖 / DATA_DIR schema
