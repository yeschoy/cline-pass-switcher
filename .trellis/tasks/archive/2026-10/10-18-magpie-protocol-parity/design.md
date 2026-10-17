# 参考 magpie 完善三协议适配边角 — 技术设计

## 1. 边界

```text
入站 Responses / Anthropic
  -> toChat（校验 + 映射）
  -> [NEW] protocol heal / id hygiene / reasoning replay（纯函数）
  -> 现有 handleChat（租约 / Provider / 统计 / 日志）
  -> fromChat / StreamEncoder
```

- Chat 三路由：`adapter = null`，**不**跑 heal（避免改变透传字节）。
- 新逻辑仅存在于 `lib/*` 纯函数；`server.js` 只改流式终态判定与（如需）`max_tokens` 缺省接线。
- 不新增依赖；不碰账号池 / sticky / 指纹。

## 2. 模块划分

| 文件 | 职责 |
|---|---|
| `lib/tool-pairing.js` **新** | Chat messages heal：`pairToolMessages`、`withoutSilentAssistants`、`joinSplitAssistantCalls`；常量 `INTERRUPTED_TOOL_RESULT` |
| `lib/responses-pairing.js` **新** 或并入 responses-adapter | `joinToolRuns`、`orphanedToolOutputs`、`pairToolItems`（对 input[]）；再 `items → chat messages` |
| `lib/protocol-ids.js` **新** | `boundCallId`（≤64 稳定映射）、`anthropicOutId`/`anthropicInId`、缺 id 铸造、流式 `mendCallId` |
| `lib/protocol-common.js` | SSE：corrupt 事件；tool delta 同 id 续写；可选 `success:false` 识别（仅适配器路径） |
| `lib/responses-adapter.js` | toChat 前跑 Responses pairing；`tool_search` 降级；空 completed 防护；encoder fail |
| `lib/anthropic-adapter.js` | toChat 前/后 Chat heal；thinking 字段；fail 关 block；`max_tokens` 默认；id charset |
| `server.js` | 流终态：corrupt / 无有效输出 → `encoder.fail`；Chat 分支不动 |

导出保持现有 adapter 形状；heal 在 `toChat` 内部调用，对 `handleChat` 透明。

## 3. Slice A — 流式正确性

### 3.1 Corrupt SSE

`parseSseEvent`：JSON 失败时 yield `{ kind: 'corrupt', raw }`（或 reader 累计 `corruptCount`），不再吞成 `[]`。

`createChatSseReader` / server adapter 分支：若出现 corrupt 且最终无合法 finish → `encoder.fail`。

### 3.2 禁空 `response.completed`

`createResponsesStreamEncoder.finish`：若从未打开任何 output item、无 text/tools/reasoning、且无明确 `finish_reason` 来自合法 choice → 改走 `fail('empty response')`。  
`[DONE]`  alone 不足以为成功。

### 3.3 Anthropic fail 收尾

`fail()`：若有 open block → `content_block_stop`；若已 `message_start` → 发 `error` 事件；**不**发 `message_stop`（对齐客户端 R2 / magpie）。若当前实现依赖 message_stop 做清理，以「error 后不再发成功终态」为准并补测。

### 3.4 Thinking 字段

非流 `contentFromSnapshot`：只要需要 signature（withSignature / 有封条），始终输出 `{ type:'thinking', thinking: text || '', signature }`。

### 3.5 Tool 流聚合

`applyToolDelta`：若 delta 带已见 `id`，归入该 id 槽，忽略冲突 index；无 id 时保持现有 index 启发式。

### 3.6 `max_tokens` / arguments

- Anthropic toChat：`max_tokens` 缺省 → `4096`。
- 出站 Chat tool `arguments`：`''` → `'{}'`；Anthropic `input` parse 失败兜底 `{}`。

## 4. Slice B — Heal 相位

对 **Responses** `input`：

```
joinToolRuns → orphanedToolOutputs → pairToolItems
  → convert to chat messages → pairToolMessages（幂等）→ …
```

对 **Anthropic** messages：先转为 Chat messages（现有逻辑），再：

```
joinSplitAssistantCalls → withoutSilentAssistants → pairToolMessages
```

（若在 block 层实现 `pairToolBlocks` 等价，须与 Chat 层二选一避免双 mend；**推荐统一在 Chat messages 层 mend**，Anthropic/Responses 都先落到 Chat 再 heal。）

**推荐统一路径（简化）：**

```
protocol-specific convert → chat.messages
  → joinSplitAssistantCalls(messages)
  → withoutSilentAssistants(messages)
  → pairToolMessages(messages)
  → id hygiene (Slice C)
  → reasoning replay (Slice D)
```

Responses 特有的 `joinToolRuns` / orphan 在 **convert 之前**对 `input[]` 执行（因 item 类型更丰富），convert 后再跑 Chat 层 pair（幂等）。

常量：

```js
export const INTERRUPTED_TOOL_RESULT =
  '[The result of this tool call is unavailable: the turn was interrupted.]';
```

算法伪代码权威来源：`research/magpie-pairing-algorithms-round4.md`。

## 5. Slice C — ID 与 tool_search

### 5.1 `boundCallId(id, map)`

- 合法且 `length ≤ 64`：原样。
- 否则：稳定短 id（如 `call_` + base64url(sha256(id)).slice(0, 27) 使总长 ≤64）；同一 map 双向登记，output 侧同映射。

### 5.2 Anthropic charset

- Out：`/^[\w-]+$/` 以外 → `mp_` + base64url(utf8(id))（去 padding），保证字符集。
- In：`mp_…` → 还原；非此前缀原样。

### 5.3 缺 id 铸造

- 入站 call 无 id：`call_<random or hash(position+name+args)>` 写入 map，匹配的 output 无 id 时按序消费。
- 流式：首片无 id 则铸造；后续同 index 空 id 不覆盖；真实 id 若在 **首个 added 事件前**到达则采用真实 id。

### 5.4 `tool_search`

- 移出 `HOSTED_TOOLS`。
- → Chat function，参数按 magpie/Codex 常见 schema（design 实现时对照 `/tmp/magpie-gw` custom/tool_search）；`toolMap` 记 `tool_search`。
- 回译：item type `tool_search_call`，item id `tsc_` 前缀（与 `ctc_`/`lsc_` 并列）。

## 6. Slice D — Reasoning replay

在 heal + id 之后、返回 chatBody 之前：

| 条件 | 动作 |
|---|---|
| `model` 匹配 `/deepseek/i` | 对每条含 `tool_calls` 的 assistant：若无 `reasoning_content`/`reasoning`/可提取 details → 设 `reasoning_content: ' '` |
| kimi / mimo（model 匹配） | 确保历史 assistant 在 tool 轮有可提取 reasoning；`reasoning_details` 折成 `reasoning_content` 字符串，删除 details |
| glm | 仅折三拼写到 `reasoning_content` 若存在明文；不插入 `' '` |
| content 含 `<think>…</think>` | 拆出 think → `reasoning_content`，清洗 content（MiniMax 启发式，全模型可用） |
| 已有 `clps1.` 封条还原 | 优先于占位；占位不覆盖非空文本 |

不按 host 判断（上游恒为 Cline）；仅按 **请求 model 字符串**。

## 7. 兼容与风险

| 风险 | 缓解 |
|---|---|
| Heal 改变曾依赖 400 的客户端 | README 声明；干净路径字节/结构稳定测 |
| 空格占位被非 DS 模型厌恶 | 仅 deepseek 名插入 |
| boundCallId 碰撞 | sha256 截断 + map；测长 id 成对 |
| fail 无 message_stop 导致客户端挂起 | 以 R2 为准；集成测 Claude 形 fail |
| 双 mend 破坏干净交换 | Responses 先 item mend，Chat pair 必须幂等 |

## 8. 测试策略

- 单测：`test/tool-pairing.test.js`、`test/protocol-ids.test.js`；扩展 `responses-adapter` / `anthropic-adapter` / `protocol-common`。
- 集成：`protocol-integration.test.js` 增加 malformed SSE、interrupted heal、anthropic charset、deepseek 占位（可用 mock upstream）。
- 不改 Chat 既有断言。

## 9. Rollback

- 纯逻辑变更：回滚 commit 即可；无 DATA_DIR / schema 变更。
- 功能开关：本期不做；若需可后续加 `PROTOCOL_HEAL=0`（非本期）。
