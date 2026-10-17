# Research: Cline-pass 分模型 reasoning / tool 矩阵（Round 4.2）

- **Query**: 为 Cline-pass 目录（glm / kimi / deepseek / qwen / minimax / mimo）收集 per-model reasoning 字段、tool-after-reasoning、think 标签、cache 字段与适配器动作证据
- **Scope**: mixed（本仓 + Magpie `/tmp/magpie-gw` + Magpie GitHub raw + 公开文档引用；**未**对 Cline 做带真实 key 的 live API 调用）
- **Date**: 2026-10-18

## 目录模型清单（本仓）

`server.js` 默认 `knownModels`（约 L95–110）：

| ID | 族 |
|---|---|
| `cline-pass/glm-5.3-flash`, `glm-5.3`, `glm-5.2` | GLM |
| `cline-pass/kimi-k3`, `kimi-k2.6`, `kimi-k2.7-code` | Kimi |
| `cline-pass/deepseek-v4-flash`, `deepseek-v4.1-flash`, `deepseek-v4-pro` | DeepSeek |
| `cline-pass/qwen3.8-max`, `qwen3.7-plus`, `qwen3.7-max` | Qwen |
| `cline-pass/minimax-m3` | MiniMax |
| `cline-pass/mimo-v2.5`, `mimo-v2.5-pro` | MiMo |

README 仅示例 `cline-pass/glm-5.2` 等前缀；完整列表以上述 `knownModels` + 参考价表为准。定价快照另含 `muse-spark-*`（非本轮六族矩阵）。

## Findings

### 矩阵总表

| 模型族 | reasoning field(s) expected | tool-after-reasoning required? | think tags? | cache fields | adapter action needed | evidence confidence |
|---|---|---|---|---|---|---|
| **DeepSeek**（`deepseek-v4*` / `v4.1*`） | 出站/回放优先 `reasoning_content`；亦可出现 `reasoning` / `reasoning_details`（OpenRouter 中继） | **是**（带 `tools` 的 thinking 模式：含 `tool_calls` 的 assistant 及 tool 结果后的 assistant 均须带回；Magpie 无明文时用空格 `" "` 占位） | 否（独立字段） | 官方直连可有 `prompt_cache_hit_tokens`；经 Cline 多为 `prompt_tokens_details.cached_tokens` | 对 model 名含 deepseek：`reasonFirst`/占位；Responses→Chat 回写 `reasoning_content`；勿向非 DS 上游硬塞 | **high**（官方 docs + Magpie 测 + 本仓缺口 G8） |
| **Kimi**（`kimi-k*`） | 官方/Moonshot：`reasoning_content`；OpenRouter 路径常见 `reasoning_details`（`reasoning.text` + 流式 `index`） | **是**（thinking 开启时，带 `tool_calls` 的 assistant 缺 `reasoning_content` → 400）；另需严格 tool 配对（`tool_call_id` 可找到） | 否 | OpenAI 风格 `prompt_tokens_details.cached_tokens`（本仓 pricing/integration 用 kimi） | 折叠/去掉带 `index` 或非法 type 的 `reasoning_details`→`reasoning_content`；tidy tool 序列；勿原样回灌 details | **high**（Moonshot docs + Magpie `kimi_reasoning_details` / `kimiValid`） |
| **GLM**（`glm-5.*`） | `reasoning_content`（Z.AI interleaved / preserved thinking）；OpenRouter 亦可 `reasoning` / `reasoning_details` | **建议回传**（interleaved：thinking 块须与 tool 结果一并保留）；Magpie 对非 deepseek 名的 `glm-5.2` **不**自动插 `" "` 占位 | 否 | `prompt_tokens_details.cached_tokens`（integration：`glm-5.3` 显式 0） | 三拼写提取；历史明文回放；勿误套 DeepSeek 空格占位；`clear_thinking`/effort 映射属上游参数层 | **med–high**（Z.AI docs **high**；经 Cline 是否原样透传 **med**） |
| **Qwen**（`qwen3.*`） | OpenRouter 测例用 `reasoning` / `reasoning_details`；`reasoning_content` 为别名 | OpenRouter：工具环建议原样保留 `reasoning_details`；官方直连 quirks 未经本仓 live 核验 | 否（未见本仓/Magpie 对 Qwen 的 `<think>`） | 定价表含 **cache write**（`qwen3.8-max` / `3.7-*`）；统计需 write 计数才完整计价 | 出站 `extractReasoning` 三拼写；回灌时勿把 OR `reasoning_details` 原样打到非 OR 上游；注意 cache_write | **med**（OR/Magpie inbound 测；无 Cline 抓包） |
| **MiniMax**（`minimax-m3`） | 官方：默认 content 内标签 **或** `reasoning_split`→`reasoning_content` / `reasoning_details`；须整包 assistant（含 thinking）回传 | **是**（interleaved thinking：完整 assistant 含 thinking/tool_calls） | **是**（`<think>…</think>`，当 split=false / 默认内联路径）；Magpie 仅对 host `*.minimax.io` / `*.minimaxi.com` 做 inline 编解码 | `prompt_tokens_details.cached_tokens`（定价有 cached-read；integration 有时无 details） | 若 content 含 `<think>`：拆到 reasoning 出站；回译是否内联取决于实际上游形态（经 Cline 未必是官方 host） | **med**（官方 docs **high**；Cline 中继形态 **low–med**） |
| **MiMo**（`mimo-v2.5*`） | `reasoning_content`；Magpie `#1765`：经中继可带 `reasoning_details`+`index`（再转 Kimi 会 400） | **是**（官方：历史含 tool 的 thinking 会话后续须完整回传 `reasoning_content`，否则 400） | 否（Chat）；Anthropic 兼容路径用 `thinking` 块 | `prompt_tokens_details.cached_tokens`（pricing/integration） | 按 `reasoning_content` 回放；若历史是 details→折成 content；勿把 MiMo details 原样送 Kimi 上游 | **med–high**（MiMo docs **high**；Cline 中继 **med**） |

### Files Found

| File Path | Description |
|---|---|
| `server.js` L95–110, L4789+, L995–1026, L3298+ | knownModels、`injectPrefs`、参考价、usage/cache 归一化 |
| `lib/protocol-common.js` L46–61, L220–232 | `extractReasoning` 优先级；`mapChatUsage` cached/reasoning tokens |
| `lib/responses-adapter.js` / `lib/anthropic-adapter.js` | `clps1.` 封条回放（当前环）；无 per-model reasonFirst |
| `test/integration.test.js` | kimi/glm/deepseek/mimo/minimax usage 与定价夹具 |
| `test/protocol-integration.test.js` | 流式 `reasoning_content`→Responses |
| `README.md` | `cline-pass/*` 前缀与接入说明 |
| `/tmp/magpie-gw/chat.go` | `chatReplaysReasoning`、MiniMax `<think>`、tool 轮 `noReasoning` 占位 |
| `/tmp/magpie-gw/chat_inbound_reasoning_test.go` | 三拼写解析（deepseek / openrouter qwen） |
| `/tmp/magpie-gw/reasoning_replay_test.go` | Responses/Chat DeepSeek 回放；OpenAI host 禁明文 |
| `/tmp/magpie-gw/chat_tool_pairing_test.go` | Kimi 式 tool 序列校验 `kimiValid` |
| Magpie GitHub `kimi_reasoning_details_test.go` | Kimi 拒 `reasoning_details`+index；折成 `reasoning_content`；MiMo→Kimi 场景 |
| Magpie GitHub `chat_tool_reasoning_test.go` | DeepSeek tool 轮必须 reasoning；glm 同中继不插占位；空格 `" "` |
| `.trellis/tasks/10-18-magpie-protocol-parity/research/cline-upstream-risks-round3.md` | Round3 拼写/缺口交叉 |
| `.trellis/tasks/10-18-magpie-protocol-parity/research/switcher-behavior-audit-round2.md` | G8 / Q2 / Q3 |
| `.trellis/tasks/archive/2026-09/09-24-model-provider-statistics/research/official-pricing-and-usage.md` | 各族 cache 计价口径 |

### Code Patterns

**本仓出站提取顺序**（与 Magpie `messageReasoning` 一致）：

```46:61:lib/protocol-common.js
export function extractReasoning(source) {
  // reasoning_content → reasoning → reasoning_details[].text (type reasoning.text)
  ...
}
```

**Magpie DeepSeek 回放判定**（host 含 deepseek **或** model 名含 deepseek）：

```258:266:/tmp/magpie-gw/chat.go
func chatReplaysReasoning(host, model string) bool {
	return strings.Contains(host, "deepseek") || strings.Contains(strings.ToLower(model), "deepseek") || host == provider.CommandCodePlanID
}
```

有 `tool_calls` 或紧跟 tool 结果、且无 think 文本时写入 `reasoning_content = noReasoning`（测例断言为单个空格 `" "`）。

**Magpie MiniMax 内联**（仅官方后缀 host）：

```274:279:/tmp/magpie-gw/chat.go
// MiniMax's own Chat API ... <think> tags ... (#1267)
inlineThink := strings.HasSuffix(host, "minimax.io") || strings.HasSuffix(host, "minimaxi.com")
```

**本仓相对 Magpie 的事实缺口**（描述现状，非建议）：

- 仅当 `clps1.` 封条在「当前工具循环」才写回 `reasoning_content`/`reasoning`；无 DeepSeek 空格占位、无 Kimi details 折叠重试、无 MiniMax `<think>` 拆装。
- `injectPrefs` 钉 `providerOptions.gateway.only`（任意 upstream），不是 Magpie `PinUpstream` 专钉 deepseek UX。

### External References

| 来源 | 与矩阵关系 | 置信度 |
|---|---|---|
| [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) | 带 `tools` 时须完整回传 `reasoning_content`，否则 400 | **high**（官方） |
| DeepSeek harness / n8n issues（2026） | 工具轮无 reasoning 仍可能 400；与 Magpie `" "` 占位动机一致 | **med**（社区） |
| LangChain 维护者注（2026-06）称直连 API 已放宽 | 与现行官方 docs「必须回传」及 Magpie 2026-10 测例冲突 → **以官方 docs + Magpie 测为准**，直连放宽不证明 Cline 中继 | **low**（争议） |
| [Kimi Thinking Models](https://platform.kimi.ai/docs/guide/use-thinking-models) | 多轮工具须保留 `reasoning_content` | **high** |
| [Z.AI Thinking Mode](https://docs.z.ai/guides/capabilities/thinking-mode) | GLM interleaved/preserved：`reasoning_content` 原样回传 | **high** |
| [MiniMax Tool Use & Interleaved Thinking](https://platform.minimax.io/docs/guides/text-m3-function-call) | 整包回传；`reasoning_split` 控制字段 vs `<think>` | **high** |
| [MiMo deep thinking / pass-back](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking) | 含 tool 历史须回传 `reasoning_content`，否则 400 | **high** |
| [OpenRouter Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) | Qwen 等：`reasoning` / `reasoning_details`；`reasoning_content` 别名 | **med**（OR；非 Cline 直证） |

### Related Specs / Prior Research

- `.trellis/tasks/10-18-magpie-protocol-parity/research/cline-upstream-risks-round3.md` — 拼写表与硬化清单
- `.trellis/tasks/10-18-magpie-protocol-parity/research/switcher-behavior-audit-round2.md` — G8 / Q2 / Q3
- `.trellis/tasks/10-18-magpie-protocol-parity/research/parity-gap-matrix.md` — G8 行
- `.trellis/tasks/archive/2026-10/10-13-three-protocol-adapter/design.md` — `clps1.` 与三拼写出站

## Caveats / Not Found

1. **未**使用真实 Cline Pass key 对 `api.cline.bot` 做 live 抓包；经 Cline 后字段是「厂商原样」还是「网关归一化」对 MiniMax `<think>` / OpenRouter `reasoning_details` 仍为 **med/low**。
2. `/tmp/magpie-gw` 缓存**缺少** `kimi_reasoning_details_test.go`、`chat_tool_reasoning_test.go`；本轮已从 GitHub raw 拉取正文核对（2026-10-18）。
3. Magpie `noReasoning` 常量定义文件不在本地网关缓存切片中；行为以 `chat_tool_reasoning_test.go` 断言 `" "` 为准。
4. Qwen 官方（非 OpenRouter）tool+reasoning 契约无本仓 fixture；矩阵行置信度低于 DeepSeek/Kimi。
5. `muse-spark-*` 在价表出现但不在默认 `knownModels` 六族范围，本矩阵未单列。
6. 公开文档置信度标签仅表示「文档/测例本身」；**不等于**「cline-pass 该 ID 在生产上一定如此」。
)
