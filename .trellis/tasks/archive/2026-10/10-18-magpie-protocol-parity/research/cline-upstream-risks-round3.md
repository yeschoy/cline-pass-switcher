# Research: Cline 上游三协议适配风险（Round 3）

- **Query**: Cline-upstream-specific risks for three-protocol adapters（envelope / reasoning / tool stream / usage / Magpie 专有处理 / 硬化清单）
- **Scope**: mixed（本仓 `server.js` + `lib/*` + 测试 + 归档研究；GitHub `yetone/magpie` gateway/provider）
- **Date**: 2026-10-18
- **Task**: `.trellis/tasks/10-18-magpie-protocol-parity`

---

## Findings

### Files Found

| File Path | Description |
|---|---|
| `server.js:4770-4784` | 非流式上游 `unwrap()`：有 `data.choices`/`data.error` 则剥外壳 |
| `server.js:4756-4758` | `upstreamErrorOf`：`json.error \|\| json.data.error` |
| `server.js:3003-3017` | `parseRouting`：同样剥 `data.choices` 外壳后读 `provider_metadata` |
| `server.js:3288-3302` | `normalizeUsage`：多拼写 cache token 字段 |
| `server.js:4786-4810` | `injectPrefs`：planner/`providerOptions.gateway.only` 与 direct/`provider.only` |
| `server.js:5202-5220` | `attemptOnce` → `unwrap` → 适配器 `fromChat(safeOut)` |
| `server.js:5661-5806`（约） | 协议流：`createChatSseReader` + encoder（见 round2） |
| `lib/protocol-common.js:46-68` | `extractReasoning` / `unwrapChatPayload` |
| `lib/protocol-common.js:80-184` | SSE reader + Chat aggregator（tool index / usage） |
| `lib/protocol-common.js:220-232` | `mapChatUsage`（cached / reasoning tokens） |
| `lib/responses-adapter.js` | Responses↔Chat；`stream_options.include_usage`；`clps1.` 封条 |
| `lib/anthropic-adapter.js` | Anthropic↔Chat；同样 `stream_options` / 封条 |
| `test/protocol-common.test.js` | `{data:…}` SSE 解包、三拼写 reasoning、工具交错 index |
| `test/protocol-integration.test.js` | 流式 `reasoning_content` → Responses reasoning |
| `test/integration.test.js:440-457` | HTTP-200 wrapped error / 首包 SSE wrapped 可 failover |
| `.trellis/tasks/archive/2026-10/10-13-three-protocol-adapter/{prd,design,implement}.md` | 三协议设计契约（Cline Chat 上游） |
| `.trellis/tasks/archive/2026-09/09-18-response-chat-tool-protocol-error/research/switcher-responses-feasibility.md` | Responses-over-Chat 风险（reasoning / cache / Codex） |
| 本任务 `research/{magpie-test-specs-round1,switcher-behavior-audit-round2,parity-gap-matrix}.md` | Round1/2 差距矩阵 |
| Magpie `internal/gateway/cline_envelope.go` | `{success,data}` 非流式解包 |
| Magpie `internal/gateway/cline_envelope_test.go` | 成功剥壳 / `success:false`→502 / **流式原样透传** |
| Magpie `internal/gateway/cline_client_test.go` | 注入 Cline Desktop 请求头 |
| Magpie `internal/gateway/cline_pin.go` + `*_test.go` | DeepSeek → `providerOptions.gateway.only:["deepseek"]` |
| Magpie `internal/gateway/cline_free_limit_test.go` | 免费日限额按**模型**休息，非整账号 |
| Magpie `internal/gateway/plugin_cline_pin_test.go` | Cline 插件 + PinUpstream |
| Magpie `internal/provider/cline.go` | `ClineClient` / `IsCline` / `ClinePin` / 免费模型 |
| Magpie `internal/gateway/chat.go` | Chat 编解码、reasoning 回放、usage、MiniMax `<think>` |
| Magpie `internal/gateway/{chat_inbound_reasoning,chat_tool_reasoning,kimi_reasoning_details,reasoning_replay}_test.go` | Codex/Claude 译 Chat 时的 reasoning 契约 |

### Related Specs

- `.trellis/spec/backend/error-handling.md` — 错误信封 / 流失败（归档 check 引用）
- `.trellis/spec/backend/quality-guidelines.md` — Header 白名单（含 `HTTP-Referer`/`X-Title`；**禁止伪造 Cline 指纹**见 CPA 归档 PRD）
- `.trellis/spec/backend/client-key-guidelines.md` — 客户端密钥（间接相关）

---

## 1. Cline 响应信封 / SSE 与 vanilla OpenAI Chat 的差异

### 1.1 非流式 `{success, data}` 外壳

**Magpie 证据**（`cline_envelope.go` 注释与实现）：

- Cline API 在**非流式** JSON 下可能返回整份 Chat Completion 包在 `{"success":true,"data":{…chat.completion…}}`。
- 若不剥壳，客户端读不到顶层 `choices`（Discord「Alma's tool-model calls failed with Invalid JSON response」）。
- `{"success":false,"error":…}`：转成 `{"error":{"message":…}}`；若 HTTP 仍为 2xx 则抬到 **502**。
- **仅**对 `IsCline()` 且非压缩、Content-Type 含 `json`、**非** `event-stream` 的响应做剥壳；其他 provider 原样。

**本仓证据**：

| 层 | 行为 |
|---|---|
| `server.js` `unwrap()` | `json.data` 含 `choices` 或 `error` 时用 `data` 作为 body；错误路径规范化 status |
| `upstreamErrorOf` | 同时看 `json.error` 与 `json.data.error` |
| 适配器入站 `unwrapChatPayload` | 仅当 `event.data` 含 `choices` / `error` / `usage` 时剥一层 `data`（**不读 `success` 字段**） |
| 配额 API | `success===true && data.limits`（`server.js:1250`）— 另一套 Cline 管理信封 |

**差异要点**：

1. Magpie 显式认 `success` 布尔并在 false 时强制 502；本仓靠「有 `data.error` / 无 choices」+ `normalizeStatus`，语义接近但**不依赖 `success` 键**。
2. Magpie 测试明确：**流式**若 SSE 帧里仍带 `"success":true`，**原样透传**（不剥）。本仓 Chat 直通同样按帧透传；三协议路径靠 `unwrapChatPayload`，对 `{success,data:{}}`（无 choices）**不会剥**，聚合器看不到 choice。
3. Magpie 注释：译成 Chat 的请求（Codex Responses / Claude Messages）**强制 stream**，因此「走适配器时通常拿到 plain SSE」——与「翻译流量依赖流式、非流式外壳是直连 Chat 风险」一致。

### 1.2 SSE 与 vanilla Chat

| 行为 | vanilla OpenAI | Cline / 本仓 / Magpie |
|---|---|---|
| 帧形状 | `data: {choices:[{delta…}]}` | 偶发 `data: {"data":{choices…}}`（本仓 reader 解包） |
| `[DONE]` | 有 | 本仓 `createChatSseReader` 识别；Magpie 同 |
| 首包 HTTP 200 + 错误信封 | 少见 | 本仓集成测：首 SSE wrapped error **可 failover**（`integration.test.js:449-457`） |
| 流开始后错误 | 不可重试 | 本仓：更新账号规则，不重放（同测 `post-start-wrapped`） |
| `stream_options.include_usage` | 可选 | 本仓 Responses/Anthropic→Chat **强制**写入（`responses-adapter.js:304-306`，`anthropic-adapter.js:205`）；Magpie `buildChat` 流式同样写（`chat.go:460-461`） |

### 1.3 Provider 路由元数据（非 OpenAI 标准）

Cline planner 管道响应可带 `provider_metadata.gateway.routing`（`finalProvider` / `canonicalSlug` / `fallbacksAvailable`）；direct 管道顶层 `provider` 字符串（`server.js:2997-3017`）。三协议适配器不消费这些字段；统计/粘性在 `server.js` 链路上消费。vanilla OpenAI 无此结构。

---

## 2. Reasoning 字段拼写：Cline-pass 模型实际会返回什么

证据来源：Magpie `chat_inbound_reasoning_test.go` / `chat.go` / `kimi_reasoning_details_test.go` / `chat_tool_reasoning_test.go`；本仓 `extractReasoning`；归档 feasibility + 模型列表。

| 拼写 | 典型来源 | Cline-pass 相关性 | 本仓处理 |
|---|---|---|---|
| `reasoning_content`（string） | DeepSeek 官方 / 多数 thinking 模型回传要求；OpenCode 常发 | **高**（`deepseek-v4-*`、多数 Cline 回放路径） | 出站聚合优先；封条默认 `f=reasoning_content` |
| `reasoning`（string） | OpenRouter 风格 | 经 OpenRouter/direct 管道时可能出现 | 出站第二优先；封条可记 `reasoning` |
| `reasoning_details[]`（如 `type:"reasoning.text"`） | OpenRouter 结构化；MiMo/部分客户端带回 `index` | **Kimi** 上游可能 **400**（含 streaming `index` 或非法 type）；Magpie 会折成 `reasoning_content` 再发 | 出站：拼接 `reasoning.text`；**入站历史不读**明文三拼写（只认 `clps1.`） |
| 正文内 `<think>…</think>` | MiniMax 自有 Chat API（`minimax.io` / `minimaxi.com`） | `cline-pass/minimax-m3` 经 Cline 网关时**不一定**是内联形态；Magpie 仅对 MiniMax host 做 inline | **未实现**（round2 Q3） |
| Gemini `<thought>` | Google 兼容层 | 非 Cline-pass 核心路径 | 未实现 |

**优先级（本仓与 Magpie messageReasoning 一致）**：`reasoning_content` → `reasoning` → `reasoning_details` 文本。

**Codex/Claude 服务 Cline 时的特殊注释（Magpie）**：

- `chat_inbound_reasoning_test.go`：Chat 客户端若用后两种拼写把历史 thinking 送回，译到非 Chat 上游（Anthropic / Codex / Gemini）时曾丢失思维，工具第二轮起出错——故 parseChat 必须读全三拼写。
- `reasoning_replay_test.go`：Codex Responses 译到 DeepSeek Chat 时，须把 reasoning summary/`reasoning_text` 回写成 Chat `reasoning_content`；OpenAI 自家 host **禁止**明文 reasoning。
- `chat_tool_reasoning_test.go`：DeepSeek（含「host 不叫 DeepSeek 的 OpenCode Go 中继」）——带 `tool_calls` 的 assistant **必须**有 `reasoning_content`（可为空格占位 `" "`）；无 tool 的回复**不要**硬塞；Mistral **不要**塞。

本仓对应缺口（round2 G8 / Q2）：只回传本网关 `clps1.` 封条；无 `reasonFirst` 占位；不把 Chat 历史三拼写还原进上游。

---

## 3. Tool call 流式 quirks（Cline Chat 上游视角）

| Quirk | Magpie | 本仓 | 风险（Codex/Claude→Cline） |
|---|---|---|---|
| 按 `index` 分片聚合 | `chatDecoder` 跟踪 open tool | `applyToolDelta` 按 index Map | 交错 index 已测；无 index + 重复 id 续写未对齐 Magpie（G11） |
| 同 id 在多帧重复 | Magpie 用 `toolID` 续写 | 有 id 则覆盖当前槽 id，无「跨 index 合并」 | 参数错槽 |
| 只读 first choice | Magpie `choice` 钉首个 | `choices?.[0]` | 多 choice 丢弃 |
| 缺 call id | Magpie 铸造 | 出站铸造 `call_`/`toolu_`；入站历史缺 id → 400 | Codex hang / 下一轮 pairing（G4） |
| 未答 tool → 合成 interrupted | Magpie 有占位 tool 结果文案 | 不合成（G1） | 严格上游「No tool output」 |
| 并行 call + 夹杂文本 | Magpie `join*` | 不重排（G3） | Volcengine/严格 Chat 400 |
| Kimi：`tool_call_id` 必须能找到 | Magpie tidy / 合成 | 严格配对 400 | `cline-pass/kimi-k3` |
| DeepSeek：tool 轮必须带 reasoning | Magpie `noReasoning`/`reasonFirst` | 仅封条回放 | 400「reasoning_content must be passed back」 |
| 流式 malformed JSON | Magpie 有 failed 路径契约 | reader catch → 静默丢（G9） | Codex 空 completed |

归档 `09-18-…/switcher-responses-feasibility.md`：流式转换是最高风险；`response.completed.output=[]`、首包 SSE error、`[DONE]`≠ Responses completed——均已在本仓设计中部分覆盖，Cline 外壳叠加后风险更高。

---

## 4. Usage / cache token 字段

### 4.1 本仓

**统计路径** `normalizeUsage`（`server.js:3288-3302`）：

- input：`prompt_tokens` / `input_tokens` / `inputTokens`
- output：`completion_tokens` / `output_tokens` / `outputTokens`
- cache：`prompt_tokens_details.cached_tokens`、`input_tokens_details.cached_tokens`、`cache_read_input_tokens`、`cached_input_tokens`、`cachedInputTokens`
- 区分 **字段缺失** vs **显式 0**（`cacheFieldPresent`）；集成测对 `cline-pass/glm-5.3` 等显式零 usage 有断言

**适配器路径** `mapChatUsage`（`protocol-common.js:220-232`）：

- cached：`prompt_tokens_details.cached_tokens` ?? `input_tokens_details.cached_tokens`
- reasoning：`completion_tokens_details.reasoning_tokens` ?? `output_tokens_details.reasoning_tokens`
- **未读**：`prompt_cache_hit_tokens`、顶层 `cached_tokens`、`cache_read_input_tokens`、`cache_write_tokens`、Anthropic 风格 `cache_creation_input_tokens`

### 4.2 Magpie `cUsage.usage()`（`chat.go`）

额外归一化：

- `prompt_cache_hit_tokens`、顶层 `cached_tokens`
- Anthropic 名：`cache_read_input_tokens` / `cache_creation_input_tokens`（并从 `prompt_tokens` 扣减得到「非缓存 input」口径）
- `prompt_tokens_details.cache_write_tokens`（OpenRouter）
- 出站 Chat usage 可回写 `cache_write_tokens` + `reasoning_tokens`

### 4.3 与 Cline-pass 的关系

- Cline 文档/本仓定价快照模型（GLM/Kimi/DeepSeek/Qwen/MiniMax/MiMo）多走 OpenAI 风格 `prompt_tokens_details.cached_tokens`——统计层已覆盖。
- 三协议客户端看到的 usage 走 `mapChatUsage`，比统计层**窄**；若某 provider 只回 `prompt_cache_hit_tokens`，Responses/Anthropic 客户端侧 cached 可能为 null，而 Switcher 统计仍记到。
- 流式无最终 usage：本仓不伪造 Token（integration 测 kimi stream）；Magpie 同样依赖 `include_usage`。

---

## 5. Magpie 专为 Cline 处理、本仓没有（或策略不同）的部分

| Magpie 能力 | 本仓现状 | 说明 |
|---|---|---|
| `clineUnwrapped` 认 `success` + 2xx→502 | `unwrap` 靠 data/error，无 `success` 键 | 非流式接近；`success:false` 且无 `data.error` 仅字符串 `error` 时 Magpie 更完整 |
| **流式强制**译请求以避开非流外壳 | 适配器可非流；流式不剥 `success` | Magpie 测试：stream 帧带 success **故意不剥** |
| `ClineClient` Desktop 头（`X-CLIENT-TYPE: cline-desktop` 等） | **故意不伪造** Cline 指纹（CPA PRD）；透传客户端白名单头 | 影响 `cline-free/*`（403 product surfaces）；`cline-pass/*` 通常用 API key 即可 |
| `clinePin` / `PinUpstream` → `gateway.only:["deepseek"]` | `injectPrefs` 按账号/模型 `upstreams` 钉 provider，**不是** Magpie 的 DeepSeek 专用 PinUpstream UX | 功能重叠在「钉 upstream」，机制不同 |
| 免费模型日限额 **按模型 rest**（非整 key） | 账号/规则级 cooldown；未见 Magpie 同款「Daily free limit…23h 59m」按模型解析 | `cline-free` 非本产品核心，但若代理 free 模型会误伤同 key 其他模型 |
| Kimi：`reasoning_details`→`reasoning_content` 重试 | 无 | 经 Cline 到 Kimi 时历史带 details/index 可能 400 |
| DeepSeek `reasonFirst` / 空格占位 | 仅 `clps1.` 明文回放 | Codex/Claude 工具环高风险 |
| MiniMax `<think>` 编解码 | 无 | 视 Cline 是否转成独立字段 |
| Chat 入站三拼写 → Thinking part（跨协议） | 出站有；入站历史无 | Q2 |
| usage 多厂商 cache 别名（适配器层） | 适配器窄、统计宽 | 客户端 usage 可能偏瘦 |
| Cline 插件 `PinUpstream` 旁路写 body | 无插件路径 | N/A |

**Magpie 注释中与「用 Cline 服 Codex/Claude」直接相关的句子（摘录意译）**：

- 翻译请求按 **stream** 问 Cline，流式 body 是 plain（`cline_envelope_test.go`）。
- DeepSeek thinking：tool 轮必须回传 `reasoning_content`（`#1462` / `#1822`）。
- Codex Responses → Chat：无 reasoning item 的 function_call 仍要补占位 reasoning（`TestTranslatedToolTurnWithoutReasoning`）。
- Pin：Anthropic Messages / Responses **建成 Chat 后**同样带 `providerOptions`（`cline_pin_test.go`）。

---

## 6. 针对 Cline-pass 模型的适配器硬化清单（研究结论，非实现）

下列条目来自「Magpie 有而本仓缺 / 归档已标风险」的交叉，专指 **上游为 `api.cline.bot` Chat + `cline-pass/*`**、入站为 Codex Responses 或 Claude Messages 的场景。

1. **非流式外壳**：`fromChat` / `unwrapChatPayload` 路径对齐 Magpie——识别 `success:false`（含字符串 `error`）并映射协议错误；成功时保证客户端/编码器只见标准 `choices`。非流适配器勿假设永远无外壳。
2. **流式帧**：若观测到 SSE 内 `{success,data:{choices…}}`，在 reader 层剥壳（Magpie 当前不剥——依赖强制 stream；本仓若允许非 plain 流，需自 hardening）。畸形 JSON 勿静默丢至空 `completed`（G9）。
3. **DeepSeek 系（`deepseek-v4-*`）reasonFirst**：含 `tool_calls` 的上游 assistant 必须带非空 `reasoning_content`（可用封条文本或 `" "` 占位）；无 tool 的纯文本轮不要乱插。覆盖 Responses 与 Anthropic 回译。
4. **三拼写入站**：历史 assistant 除 `clps1.` 外，读 `reasoning_content`/`reasoning`/`reasoning_details`（顺序同 `extractReasoning`），再决定写回字段名。
5. **Kimi（`kimi-k*`）**：出站前去掉或折叠带 `index` 的 `reasoning_details`，改为 `reasoning_content`；保证 tool 消息配对完整。
6. **MiniMax（`minimax-m*`）**：若上游 content 含 `<think>`，出站拆到 reasoning；回译按厂商要求决定是否内联（Magpie 仅对官方 host）。
7. **GLM / Qwen / MiMo**：默认按 `reasoning_content` 优先；勿假设 OpenRouter `reasoning_details` 可原样回灌任意上游。
8. **`stream_options.include_usage: true`**：保持强制（已有）；统计与 `mapChatUsage` 对齐至少覆盖 `prompt_cache_hit_tokens` / 顶层 `cached_tokens`，避免 Responses 客户端与 Switcher 统计口径分裂。
9. **Tool 流**：同 id fragment 续写、未答 call 合成 interrupted、call_id 长度/字符集（Codex≤64、Anthropic charset）——对 Cline 后端各 provider 的严格校验同样生效（G1/G4/G5/G6/G11）。
10. **Provider pin**：DeepSeek 模型若需稳定 prompt cache，继续用现有 `upstreams`/`injectPrefs`；文档层对齐 Magpie「PinUpstream → only deepseek」的产品语义，避免与客户端自带 `providerOptions` 冲突（Magpie：已有 `providerOptions` 则不覆盖）。
11. **不要**为通过 `cline-free` 而伪造 Desktop 指纹（与项目安全/合规 PRD 冲突）；Cline-pass 硬化范围保持在协议与 reasoning/tool/usage。
12. **验收夹具**：按模型矩阵（glm / kimi / deepseek / qwen / minimax / mimo）各跑「工具调用 → tool 结果 → 终答」两轮，断言上游请求体含正确 reasoning 字段、无非法 `reasoning_details`、usage cached 字段不丢。

---

## Code Patterns（摘录）

### 本仓 SSE / 外壳

```64:77:lib/protocol-common.js
export function unwrapChatPayload(event) {
  if (!isPlainObject(event)) return event;
  if (event.data && isPlainObject(event.data) && (event.data.choices || event.data.error || event.data.usage)) return event.data;
  return event;
}
// …
  return [{ kind: 'delta', payload: unwrapChatPayload(event) }];
```

```4770:4783:server.js
function unwrap(json, httpStatus = 200) {
  const d = json?.data && (json.data.choices || json.data.error) ? json.data : json;
  if (d?.error && !d?.choices) {
    const msg = errText(d.error);
    const status = normalizeStatus(httpStatus, d, 502);
    return { status, upstreamStatus: httpStatus, normalizedStatus: status, body: { error: { message: msg, type: 'upstream_error' } }, routing: parseRouting(d || {}) };
  }
  // …
}
```

### Magpie Cline 非流剥壳（行为摘要）

- 输入：`{"success":true,"data":{chat.completion}}` → 输出 body = `data` 原始 JSON。
- 输入：`{"success":false,"error":"Insufficient balance"}` → HTTP 502 + `{"error":{"message":"Insufficient balance"}}`。
- 输入：SSE / 非 Cline / 有 Content-Encoding → 不动。

### Reasoning 提取顺序

```46:61:lib/protocol-common.js
export function extractReasoning(source) {
  // reasoning_content → reasoning → reasoning_details[].text (type reasoning.text)
}
```

---

## External References

- [yetone/magpie `cline_envelope.go`](https://raw.githubusercontent.com/yetone/magpie/main/internal/gateway/cline_envelope.go) — Cline `{success,data}` 剥壳
- [yetone/magpie `cline_envelope_test.go`](https://raw.githubusercontent.com/yetone/magpie/main/internal/gateway/cline_envelope_test.go) — 流式不剥壳；`success:false`→502
- [yetone/magpie `cline_client_test.go`](https://raw.githubusercontent.com/yetone/magpie/main/internal/gateway/cline_client_test.go) — Desktop 头
- [yetone/magpie `cline_pin.go`](https://raw.githubusercontent.com/yetone/magpie/main/internal/gateway/cline_pin.go) — DeepSeek pin
- [yetone/magpie `provider/cline.go`](https://raw.githubusercontent.com/yetone/magpie/main/internal/provider/cline.go) — `ClineClient` / `ClinePin` / free 模型
- [yetone/magpie `chat.go`](https://raw.githubusercontent.com/yetone/magpie/main/internal/gateway/chat.go) — reasoning 回放、MiniMax `<think>`、usage 归一化、`stream_options`
- [ClinePass 文档](https://docs.cline.bot/getting-started/clinepass) — 本仓模型/价格来源
- Magpie issues 交叉引用（测试注释）：`#1462` `#1822` DeepSeek tool+reasoning；`#1765` Kimi `reasoning_details`；`#1267` MiniMax `<think>`；`#1398` free limit 按模型

---

## Caveats / Not Found

- 未能在公开 raw 中找到「Cline 流式帧是否曾发过 `{success,data}`」的生产抓包；Magpie 测试用合成流证明**当前选择不剥流式外壳**。
- 各 `cline-pass/*` 在 Cline 网关后最终 provider 的 reasoning 形态依赖账号管道（planner vs direct），本轮未做 live 探测。
- `cline_free_*` / Desktop 头对本产品主路径（付费 ClinePass）优先级低； Harden 清单第 11 条标明范围。
- GitHub code search API 需认证；文件列表改用 git tree + raw 内容。
- 活跃 Trellis task 指针 `task.py current` 为空；输出按用户指定目录写入。
