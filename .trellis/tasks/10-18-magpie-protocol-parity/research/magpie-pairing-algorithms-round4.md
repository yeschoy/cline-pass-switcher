# Research: Magpie Tool Pairing Algorithms (Round 4.1)

- **Query**: 从 `/tmp/magpie-gw/` 与 `/tmp/magpie-tests-r1/` 抽取可执行 pairing 算法（伪代码级，可 JS 重实现）；映射到 cline-pass-switcher；Slice B/C 实现顺序
- **Scope**: internal（magpie 源码 + 本仓库 adapter）
- **Date**: 2026-10-18

## 1. Executive Summary — 共享心智模型

Magpie 在三条协议路径上对「tool 交换」做 **mend（治愈）**，共享同一套语义，只是载体不同：

| 路径 | 交换载体 | 主 mend | 合成文案常量 |
|---|---|---|---|
| Chat 出站 | `messages[]`（assistant.tool_calls ↔ role=tool） | `pairToolMessages` | `"[The result of this tool call is unavailable: the turn was interrupted.]"` |
| Responses 入站/出站 | `input[]`（`*_call` ↔ `*_output`） | `pairToolItems`（前置 `joinToolRuns` / `orphanedToolOutputs`） | 同上 |
| Anthropic Messages 出站 | content blocks（`tool_use` ↔ `tool_result`） | `pairToolBlocks` | 同上（`interruptedTool`）；合成块 `is_error: true` |

**共享语义（三路径同构）：**

1. **未回答的 call** → 在「本轮交换结束处」插入合成 interrupted 结果（文案字节级固定）。
2. **孤儿 result**（无对应 pending call / 空 call_id）→ **不造假 call**；Chat 变 user message，Responses 变 user message，Anthropic 变 text block。
3. **重复 result** → 只保留第一次。
4. **已干净的交换** → **字节级不变**（`string(got) == keep` / `bytes.Equal`）；idempotent（再跑一次不变）。
5. **乱序 / 并行** → Chat 按 call 声明顺序重排 tool 消息；Responses 把打断 run 的夹杂项挪到整批 results 之后。

**推荐 pass 顺序（逻辑相位，不是文件顺序）：**

```
Phase 0  IR 合并并行拆分          joinSplitCalls          （Chat build 前）
Phase 1  Responses 跑整洁          joinToolRuns            （先重排）
Phase 2  孤儿 output               orphanedToolOutputs     （无 call_id → user）
Phase 3  配对治愈                  pairTool*               （合成 interrupted）
Phase 4  静默 assistant 清理       withoutSilentAssistants （Chat；可在 pair 前）
Phase 5  ID 卫生（Slice C）        chatCallIDs / streamCallIDs.mend /
                                   anthropicOutID·InID /
                                   boundCallIDs / callItemIDs / plainItemIDs
```

Codex→ChatGPT 路径上 ID 链为：`plainItemIDs(boundCallIDs(callItemIDs(body)))`（`codex_backend.go:163`）。

> **Caveat（调用点）**：`/tmp/magpie-gw` 为截断树；`joinToolRuns` / `orphanedToolOutputs` / `chatCallIDs` 的定义与测试齐全，但部分 attempt/relay 调用文件不在树内。顺序依据函数注释、`buildChat`/`buildAnthropic`/`buildResponses` 内联调用，以及 `/tmp/magpie-tests-r1` 集成测试期望。

---

## 2. Algorithms（可重实现伪代码）

### 2.1 `joinSplitCalls` — IR 合并拆开的并行 calls

- **文件**: `/tmp/magpie-gw/ir.go:108-125`
- **调用**: `buildChat` 在遍历 messages 前：`turns := joinSplitCalls(r.Messages)`（`chat.go:310`）
- **Inputs**: IR `[]Message`（role + Parts）
- **Outputs**: 新 `[]Message`（原切片不改）
- **目的**: 连续两条 assistant，且前一条已有 ToolCall 时，把后一条 Parts 并入前一条，避免 pair 在「下一条 assistant」处关闭交换、把第一批 calls 误合成 interrupted（#1275）

```
function joinSplitCalls(ms):
  out = []
  for m in ms:
    if out非空 and m.role=="assistant"
       and out[-1].role=="assistant"
       and hasCalls(out[-1].Parts):
      out[-1].Parts.appendAll(m.Parts)
    else:
      out.append(copy(m))
  return out
```

- **Edge**: 仅合并「前条有 call」的连续 assistant；user 打断则不合并。
- **Invariant**: 无可合并对时结构等价（拷贝 Parts）。

---

### 2.2 `pairToolMessages` — Chat 交换治愈

- **文件**: `/tmp/magpie-gw/chat.go:536-649`
- **调用**: `buildChat` 末尾，在 `withoutSilentAssistants` 之后：`msgs = pairToolMessages(msgs)`（`chat.go:454-455`）
- **Inputs**: Chat `[]map`（role / tool_calls / tool_call_id / content）
- **Outputs**: 治愈后的 messages
- **常量**: interrupted 文案见上表

```
function pairToolMessages(msgs):
  out = []
  pending = []          # 当前交换的 call id，按声明顺序
  order = {}            # id → 声明下标
  answered = {}
  tools = []            # 暂存待排序的 tool 消息

  flushTools():
    stableSort(tools, by order[tool_call_id])
    out.appendAll(tools); tools = []

  flushPending():
    flushTools()
    for id in pending:
      if not answered[id]:
        out.append({role:"tool", tool_call_id:id,
                    content: INTERRUPTED})
    pending, order, answered = [], {}, {}

  toolAsUser(m):
    text = m.content as string; if blank: text = "Tool result received."
    if out[-1].role == "user" and out[-1].content is string:
      out[-1].content += "\n\n" + text
    else:
      out.append({role:"user", content:text})

  for m in msgs:
    switch m.role:
      case "assistant":
        calls = m.tool_calls or []
        if calls empty:
          if pending非空 and emptyAssistant(m): continue  # 丢弃，交换保持打开
          flushPending(); out.append(m)
        else:
          flushPending(); out.append(m)
          for i,c in calls: pending.append(c.id); order[c.id]=i
      case "tool":
        id = m.tool_call_id
        if id not in order:
          flushPending(); toolAsUser(m)   # 孤儿 / 迟到
        else if answered[id]:
          continue                       # 重复，丢弃
        else:
          answered[id]=true; tools.append(m)
      default:
        flushPending(); out.append(m)
  flushPending()
  return out
```

**`emptyAssistant(m)`**（`chat.go:660-668`）：无 tool_calls，且 `reasoning_content` 与 `content` 去空白后皆空。

- **Edge cases**（`/tmp/magpie-tests-r1/chat_tool_pairing_test.go`）:
  - 并行结果乱序 → 按 call 声明序输出 tool 消息，user 文本在 tools 之后
  - 跨多条 user 的 results → 仍挂在同一 pending 交换下（依赖 builder 先把 tools 放在 user 文本前；pair 再排序）
  - 孤儿 / 空 tool_call_id → user；可与前一条 user 合并 `\n\n`
  - 迟到 result（交换已因中间 user 关闭）→ 先对旧 call 合成 interrupted，迟到内容并入后续 user
  - 交换内 thinking-only assistant → 丢弃，真实 result 仍配对
  - 交换外 silent assistant → 由 `withoutSilentAssistants` 处理（#2599）
- **Invariant**: 干净交换字节稳定；idempotent；每 id 最多一对 call/answer（`idsUsedOnce`）。

---

### 2.3 `withoutSilentAssistants` / `silentAssistant`（配对邻域）

- **文件**: `chat.go:671-758`
- **调用**: pair 之前
- **行为**: 删除「无 content/tool_calls/function_call/refusal/audio/prefix/partial」的 assistant；若因此出现相邻 user，用 `\n\n`（或 parts 拼接）合并。
- **与 pair 关系**: 交换内 empty assistant 由 pair 丢弃；交换外由本函数丢弃。

---

### 2.4 `joinToolRuns` — Responses 批内重排

- **文件**: `/tmp/magpie-gw/responses.go:506-636`
- **Inputs / Outputs**: Responses JSON body 的 `input[]`；无改动则 **原 body 字节返回**
- **快路径**: body 不含 `_call"` → 原样返回

```
function joinToolRuns(body):
  items = decode input; if fail: return body
  result(it) = it.call_id != "" and type endsWith "_output"

  # 反向扫描：call 是否被后面的 output 回答
  ahead = {}
  answeredLater = [false]*n
  for i from n-1 downto 0:
    if result(items[i]): ahead[call_id]=true
    elif items[i].call_id != "": answeredLater[i] = ahead[call_id]

  modelsOwn(it) = type in {reasoning} or (message+assistant) or type endsWith "_call"

  out=[], kinds=[], held=[], moved=false
  open={}, answering=false, first=0

  for i, raw in input:
    it = items[i]
    if result(it):
      if open[call_id]: delete open[call_id]; answering=true
    elif it.call_id != "":
      if answeredLater[i]:
        if open empty: first = len(out)
        open[call_id]=true
    elif open非空 and (answering or not modelsOwn(it)):
      held.append(raw); moved=true; continue          # 挪到 run 结束
    elif open非空 and it.type=="message":
      # assistant 文本（及紧前 reasoning）插到 first 之前
      from = len(out)
      while from>first and kinds[from-1].type=="reasoning": from--
      seg = out[from:] + [raw]
      insert out/kinds at first; first += len(seg); moved=true; continue
    out.append(raw); kinds.append(it)
    if open empty:
      out.appendAll(held); held=[]; answering=false
  out.appendAll(held)
  if not moved: return body
  else rewrite input and remashal
```

- **Edge**（`join_tool_runs_test.go`）:
  - results 间 `image_resize_notice` / developer note → 移到整批 results 后，相对顺序保持
  - call 间 reasoning 保留；assistant message（± 前 reasoning）挪到本 run 第一个 call 前（#2100）
  - 带 `call_id` 的项永不移动
  - 无后续 result 的 lone call **不构成 run**（留给 pairToolItems）
  - 交换之间的 note 不动；结果在 call 之前的怪序不动
- **Invariant**: 无移动 → 原 body；已整洁 → idempotent。

---

### 2.5 `orphanedToolOutputs` — 无 call_id 的 output → user message

- **文件**: `responses.go:638-719`
- **Inputs / Outputs**: Responses body；无改动则原 body

```
function orphanedToolOutputs(body):
  out=[], pending=[], inCalls=false, hadResults=false, changed=false
  flush(): out.appendAll(pending); pending=[]

  for raw in input:
    item = decode(raw) or {flush; inCalls=false; out.append(raw); continue}
    isOutput = type in {function_call_output, custom_tool_call_output}
    if not isOutput or call_id != "":
      switch type:
        *_call / tool_search_call:
          if hadResults: flush()
          inCalls=true; hadResults=false
        *_output / tool_search_output:
          hadResults=true
        default:
          flush(); inCalls=false
      out.append(raw); continue

    # 孤儿 output：转 user message
    text, images = toolOutput(item.output)
    content = input_text/input_image parts; empty → "Tool result received."
    message = {type:"message", role:"user", content}
    if inCalls: pending.append(message)   # 避免插在 calls 与 results 之间
    else: out.append(message)
    changed=true
  flush()
  if not changed: return body
  rewrite
```

- **Edge**: 并行 calls 之间的孤儿 → pending 到 results 之后；空 output → 占位文案；带图像保留；idempotent。
- **Invariant**: 已有 call_id 的 output、非 JSON、无 tool → 字节不变。OpenAI native Codex 路径可不改写 standalone（测试 `TestCodexNativeStandaloneOutputUnchanged`）。

---

### 2.6 `pairToolItems` — Responses 未回答 call → 合成 output

- **文件**: `responses.go:721-790`
- **调用**: `buildResponses` 返回前 `return pairToolItems(b)`（`responses.go:1239`）；relay 路径亦 mend（测试）
- **快路径**: 无 `_call"` → 原 body

```
function pairToolItems(body):
  items = decode; answered = {}
  for each item: if type in {function_call_output, custom_tool_call_output}
                 and call_id: answered[call_id]=true

  exchange(t) = toolCallItem(t) or toolResultItem(t)
  # toolCallItem: function_call | custom_tool_call | tool_search_call
  # toolResultItem: function_call_output | custom_tool_call_output | tool_search_output

  out=[]; synthetic=[]
  for i, raw in input:
    out.append(raw)
    it = items[i]
    if it.type in {function_call, custom_tool_call} and call_id and not answered[call_id]:
      kind = function_call_output or custom_tool_call_output
      synthetic.append({type:kind, call_id, output: INTERRUPTED})
      answered[call_id]=true
    # 在「当前 exchange 段」末尾冲刷合成结果
    if synthetic非空 and exchange(it.type)
       and (i+1==n or not exchange(items[i+1].type)):
      out.appendAll(synthetic); synthetic=[]

  if len(out)==len(input): return body   # 无插入
  rewrite
```

- **Edge**（`pair_tool_items_test.go`）:
  - lone call → 合成紧跟其后（或在本 run 末）
  - 并行 c1 未答、c2 已答 → 顺序：`call_c1, call_c2, out_c2, out_c1_synth, next`
  - `previous_response_id` 上仅有「外键」output → **字节不变**（不造 call）
  - custom_tool_call → custom_tool_call_output
  - `tool_search_call` 计入 exchange 边界，但本函数不为 tool_search 合成（仅 function/custom）
- **Invariant**: 干净交换 / 乱序但已齐 / 无 tool → 原 body。

---

### 2.7 `pairToolBlocks` — Anthropic Messages 治愈

- **文件**: `anthropic.go:1012-1088`；常量 `interruptedTool` 于 `:807`
- **调用**: `anthropicBody` 在 push 完 messages 后：`msgs = pairToolBlocks(msgs)`（`:884`）
- **注意**: build 时 call/result id 已经过 `anthropicOutID`（`:850,:864`）

```
function pairToolBlocks(msgs):
  out=[]; pending=[]; open={}; answered={}

  synthetic(id) = {type:"tool_result", tool_use_id:id,
                   content: json.Marshal(INTERRUPTED), is_error:true}

  closeExchange():
    blocks = [synthetic(id) for id in pending if not answered[id]]
    if blocks: out.append({role:"user", content:blocks})
    clear pending/open/answered

  for m in msgs:
    if m.role == "assistant":
      closeExchange()
      for b in m.content: if tool_use: pending.append(b.id); open[b.id]=true
      out.append(m); continue

    # user
    kept=[]; rest=[]
    for b in m.content:
      if b.type != "tool_result": rest.append(b); continue
      if not open[b.tool_use_id]:
        rest.appendAll(resultSaid(b)); continue   # 孤儿 → text/images
      if answered[b.tool_use_id]: continue        # 重复
      answered[b.tool_use_id]=true; kept.append(b)
    for id in pending:
      if not answered[id]: kept.append(synthetic(id))
    out.append({role:"user", content: kept+rest})
    clear pending/open/answered

  closeExchange()
  return out
```

**`resultSaid(b)`**（`:1090-1105`）：Content 为 JSON 字符串 → text（空则 `"Tool result received."`）；为 block 数组则原样；否则占位 text。

- **Edge**: 合成 result 在 user 消息内、位于用户文本之前；`is_error: true`；孤儿变 text；干净交换结构不变。
- **Invariant**: well-formed → 与输入等价（注释："built exactly as it was"）。

---

### 2.8 `chatCallIDs` / `placedCallID` — 入站缺 id 确定性铸造

- **文件**: `/tmp/magpie-gw/chat_call_ids.go:10-79`
- **Inputs / Outputs**: Chat request body；全部已有 id → **原 body 字节**
- **算法**:

```
function chatCallIDs(body):
  at = -1; open = []   # 本 assistant 轮新铸的 id，待无 tool_call_id 的 tool 按序领取
  editMessages(body, keys=["tool_calls"], fn(m)):
    at++
    role = m.role
    if role == "assistant":
      calls = m.tool_calls; if empty/fail: return false
      open = []
      for i,c in calls:
        if callID(c.id) != "": continue
        id = placedCallID(at, i, fn.name, fn.arguments)
        c.id = id; open.append(id)
      if open empty: return false
      m.tool_calls = calls; return true
    if role == "tool":
      if open empty or callID(m.tool_call_id) != "": return false
      m.tool_call_id = open[0]; open = open[1:]; return true
    return false

function placedCallID(msg, i, name, args):
  sum = sha256( str(msg)+"."+str(i)+"\0"+name+"\0"+args )
  return "call_" + hex(sum[:12])   # 24 hex chars
```

- **`callID(raw)`**: 非 string / null → `""`
- **Edge**: 只铸造缺 id 的 call；后续无 id 的 tool 按 open 队列领取；有 id 的 tool 不碰 open。
- **Invariant**: 全有 id → 字节不变；同位置同内容 → 跨请求 id 稳定（保 prompt cache）。

---

### 2.9 `streamCallIDs.mend` / `wholeCallIDs` — 出站流式 / 整包补 id

- **文件**: `chat_call_ids.go:81-139`
- **流式**（首片可随机 `call_`+newID；后续空 id 字段删除，防客户端覆盖）:

```
type streamCallIDs = map[[choice,index] → bool]

function mend(s, choice, rawToolCalls):
  calls = decode(raw)
  for k,c in calls:
    idx = c.index ?? k
    key = (choice, idx)
    if key not yet seen:
      mark seen
      if callID(c.id)=="": c.id = "call_"+newID(); changed
    else if has id field and callID(c.id)=="":
      delete c.id; changed
  return changed ? remarshal(calls) : (raw, false)
```

- **整包** `wholeCallIDs(msg)`: 对 message.tool_calls 中空 id 各赋 `"call_"+newID()`。
- **与 chatCallIDs 差异**: 入站历史用 **确定性** placedCallID；出站流用 **随机** newID（会话内由客户端回放）。

---

### 2.10 `anthropicOutID` / `anthropicInID` / `safeCallID` / `rawCallID`

- **文件**: `anthropic.go:1358-1403`
- **Mark**: `"mp_"`；安全字符: `^[A-Za-z0-9_-]+$`

```
function safeCallID(mark, id):
  if id matches safe and not hasPrefix(mark): return id
  return mark + base64url(utf8(id))   # RawURLEncoding, no pad

function anthropicOutID(id):
  if id=="": return id
  return safeCallID("mp_", id)

function anthropicInID(id): return rawCallID("mp_", id)

function rawCallID(mark, id):
  if not hasPrefix(mark) or not safe(id): return id
  raw = base64urlDecode(id[len(mark):])
  if decode fail or empty or invalid utf8 or safeCallID(mark, raw)!=id: return id
  return raw
```

- **用法**: 出站 Messages 写 `tool_use.id` / `tool_result.tool_use_id` 用 Out；入站 parse Anthropic 回 IR 用 In（`anthropic.go:167-170`）；流/回放给 Anthropic 客户端也用 Out。
- **Invariant**: 已安全且非 `mp_` 前缀 → 双向恒等；编解码往返稳定、无会话状态。

---

### 2.11 `callItemIDs` — Responses item `id` 前缀校正

- **文件**: `codex_backend.go:1858-1904`
- **前缀表**: `tool_search_call→tsc_`, `custom_tool_call→ctc_`

```
function callItemIDs(body):
  if body 不含 "tool_search_call" 且不含 "custom_tool_call": return body
  for each input item:
    if type in map and id 非空 and not hasPrefix(wanted):
      if id contains "_": id = wanted + afterFirstUnderscore
      else: id = wanted + id
      # call_id 字段不动
  if unchanged: return body
```

---

### 2.12 `boundCallIDs` — call_id 长度 ≤64

- **文件**: `codex_backend.go:1981-2028`
- **快路径**: 无 `"call_id":"..."{65+}` → 原 body
- **变换**: 对每项 `call_id` 调用 `provider.BoundCallID(id)`；call 与其 output **同映射**（确定性，跨请求稳定）

> **Caveat**: `provider.BoundCallID` 实现不在 `/tmp/magpie-gw` 树内。测试（`codex_call_id_test.go`）约束：结果 len≤64、非空；同一长 id 的 call/output 相等；≤64 的短 id 不变；两次请求映射一致。

---

### 2.13 `plainItemIDs`（ID 邻域，Slice C）

- **文件**: `codex_backend.go:1927-1979`
- 非法字符的 `id`：reasoning 整项丢弃；其它项把非法字符替换为 `_`（`unsafeToolID`）；`call_id` 不动。
- Codex ChatGPT 链：`plainItemIDs(boundCallIDs(callItemIDs(body)))`。

---

### 2.14 合成 interrupted 文案（三路径字节一致）

```
INTERRUPTED = "[The result of this tool call is unavailable: the turn was interrupted.]"
```

- Chat / Responses：tool / output 的 **content/output 字符串** 即为该句。
- Anthropic：`tool_result.content` 为 **JSON 编码后的字符串**（`"\"[The result...]\""`），且 `is_error: true`。

---

## 3. Mapping Table — cline-pass-switcher 宿主

当前仓库：**严格拒绝**坏交换（`lib/responses-adapter.js` `convertInputItems` 对缺/错 call_id 直接 `fail`）；出站用 `newId`（随机）。下列为各 pass 应落入的文件/函数（按现有结构，**描述映射，不改代码**）。

| Magpie pass | 建议宿主（JS） | 相位 | Slice |
|---|---|---|---|
| `joinSplitCalls` | 新 `lib/tool-pairing.js` → `joinSplitAssistantCalls(messages)`；或在 `anthropicToChat` / 未来 IR 层入口 | Phase 0 | B |
| `joinToolRuns` | `lib/responses-adapter.js`：`responsesToChat` **之前**对 `body.input` 调用；或抽到 `lib/tool-pairing.js` | Phase 1 | B |
| `orphanedToolOutputs` | 同上，紧接 join；改写后再进 `convertInputItems` | Phase 2 | B |
| `pairToolItems` | Responses→Chat：join/orphan 后、`convertInputItems` 前；若保留 Responses 出站则对称 | Phase 3 | B |
| `pairToolMessages` | Chat 直通与三协议 `toChat` 之后、发上游前：可挂 `server.js` `handleChat` 或 `lib/tool-pairing.js` `pairToolMessages` | Phase 3 | B |
| `pairToolBlocks` | `lib/anthropic-adapter.js`：今日路径是 Anthropic→Chat，治愈应落在 **Chat 侧 `pairToolMessages`**；若未来 Chat→Anthropic 出站再在 `chatToAnthropic` 前/后做 blocks 版 | Phase 3 | B |
| `withoutSilentAssistants` | `lib/tool-pairing.js` + Chat 出站前 | Phase 4 | B |
| `chatCallIDs` / `placedCallID` | `lib/protocol-common.js`（`createHash`）+ Chat 入站/出站前 | Phase 5 | C |
| `streamCallIDs.mend` / `wholeCallIDs` | `lib/protocol-common.js` `createChatAggregator` / `createChatSseReader` 旁路；或 adapter stream encoder 入口 | Phase 5 | C |
| `anthropicOutID` / `InID` | `lib/anthropic-adapter.js`：`convertAssistant` / `convertUserContent` / `chatToAnthropic` / stream encoder | Phase 5 | C |
| `boundCallIDs` | `lib/responses-adapter.js` 入站规范化 + 出站 `chatToResponses`；共享 `boundCallId()` in `protocol-common.js` | Phase 5 | C |
| `callItemIDs` / `plainItemIDs` | `lib/responses-adapter.js`（custom/tool_search 出站与历史回放） | Phase 5 | C |

**现有锚点：**

| 文件 | 现状 |
|---|---|
| `lib/responses-adapter.js` `convertInputItems` (~L78-185) | 严格 Map open/closed；无 heal |
| `lib/responses-adapter.js` `responsesToChat` | 入站入口 |
| `lib/anthropic-adapter.js` `anthropicToChat` / `convertUserContent` | tool_result→role=tool，无 orphan/pair |
| `lib/protocol-common.js` `newId` / `createChatAggregator` | 随机 id；流式会更新 id 但不删空 id 字段 |
| `server.js` `handleChat` | adapter.toChat 后转发 Chat 上游 |

---

## 4. Recommended Implementation Order（Slice B / C）

依据依赖与风险（先重排/孤儿，再合成，再 ID）：

### Slice B — Tool 历史治愈

1. **抽共享常量** `INTERRUPTED` + 抽 `lib/tool-pairing.js`（或等价）避免三处漂移。
2. **`pairToolMessages`（Chat 出站）** — 覆盖直通 Chat + 三协议 `toChat` 后的统一点；直接解除 Kimi/Volcengine「缺 tool 消息」类 400（G1）。
3. **`orphanedToolOutputs` 语义（Chat 侧：孤儿 tool→user）** — 已含于 `pairToolMessages.toolAsUser`；Responses 入站需在 `convertInputItems` **前**单独做，否则当前 `fail('tool output requires call_id')` 挡死（G2）。
4. **`joinToolRuns`（Responses 入站）** — 在 orphan/pair 之前；防止夹杂 message 把交换截断导致误合成 interrupted（G3）。
5. **`pairToolItems`（Responses 入站）** — join+orphan 之后；lone/并行未答 → 合成，再交给现有 `convertInputItems`（可逐步放宽严格校验）。
6. **`joinSplitCalls`** — 若 Anthropic/IR 出现拆开的并行 assistant，在 `anthropicToChat` 合并连续 assistant tool_use（或 Chat messages 合并）。
7. **`withoutSilentAssistants`** — thinking-only / 空 assistant（#2599 类）。

### Slice C — ID 卫生

8. **`chatCallIDs` + `placedCallID`** — 入站 Chat 历史缺 id（确定性，保 cache）（G4）。
9. **`streamCallIDs.mend` + `wholeCallIDs`** — 上游流缺 id；注意「后续 fragment 删空 id」（G4）。
10. **`boundCallIDs`** — 对齐 ≤64；需补齐/移植 `BoundCallID` 公式（实现不在本 dump）（G6）。
11. **`anthropicOutID` / `InID`** — Messages 边界非法字符（G5）。
12. **`callItemIDs` + `plainItemIDs`** — `ctc_`/`tsc_` 与非法 item id（G7）。

**测试锚点（确认用，非算法本体）：**

| 测试树 | 覆盖 |
|---|---|
| `/tmp/magpie-tests-r1/chat_tool_pairing_test.go` | pairToolMessages 全套 |
| `/tmp/magpie-tests-r1/pair_tool_items_test.go` | pairToolItems + 字节稳定 |
| `/tmp/magpie-tests-r1/join_tool_runs_test.go` | joinToolRuns 移动规则 |
| `/tmp/magpie-tests-r1/orphan_tool_output_test.go` | orphanedToolOutputs |
| `/tmp/magpie-tests-r1/anthropic_tool_pairing_test.go` | pairToolBlocks + 校验器 |
| `/tmp/magpie-tests-r1/chat_call_ids_test.go` | chatCallIDs 稳定铸造 |
| `/tmp/magpie-tests-r1/codex_call_id_test.go` | boundCallIDs 行为契约 |
| `/tmp/magpie-tests-r1/call_item_ids_test.go` | callItemIDs 前缀 |

---

## Findings — Files Found

| File Path | Description |
|---|---|
| `/tmp/magpie-gw/chat.go` | `pairToolMessages`, `emptyAssistant`, `withoutSilentAssistants`, `buildChat` 调用序 |
| `/tmp/magpie-gw/responses.go` | `joinToolRuns`, `orphanedToolOutputs`, `pairToolItems`, `toolCallItem`/`toolResultItem`, `buildResponses`→pair |
| `/tmp/magpie-gw/anthropic.go` | `pairToolBlocks`, `resultSaid`, `interruptedTool`, `anthropicOutID`/`InID`/`safeCallID`/`rawCallID` |
| `/tmp/magpie-gw/ir.go` | `joinSplitCalls`, `toolOutput` |
| `/tmp/magpie-gw/chat_call_ids.go` | `chatCallIDs`, `placedCallID`, `streamCallIDs.mend`, `wholeCallIDs` |
| `/tmp/magpie-gw/codex_backend.go` | `callItemIDs`, `boundCallIDs`, `plainItemIDs`, Codex ID 链 |
| `/tmp/magpie-gw/custom_tool.go` | custom tools 拒绝/翻译（配对邻域，非 pair 本体） |
| `/tmp/magpie-tests-r1/*pairing*`, `join_tool_runs_test.go`, `orphan_tool_output_test.go`, `chat_call_ids*.go`, `codex_call_id_test.go` | 行为确认与字节稳定断言 |
| `lib/responses-adapter.js` / `lib/anthropic-adapter.js` / `lib/protocol-common.js` / `server.js` | JS 宿主映射 |

### Related Specs / Prior Research

- `.trellis/tasks/10-18-magpie-protocol-parity/research/parity-gap-matrix.md` — G1–G4 / G3 join
- `.trellis/tasks/10-18-magpie-protocol-parity/research/magpie-test-specs-round1.md` — 测试名级规格（本轮补实现体）
- `.trellis/tasks/10-18-magpie-protocol-parity/research/synthesis-rounds-1-3.md` — Slice B/C 分期
- `.trellis/spec/` — 本轮未改；配对契约落在 task research

### External References

- 无（纯本地 magpie 源码抽取）

## Caveats / Not Found

1. `/tmp/magpie-gw` **无** `joinToolRuns` / `orphanedToolOutputs` / `chatCallIDs` 的 attempt/relay 调用源文件；集成测试证明 Responses relay 会跑 join；chatCallIDs 注释称「runs in attempt」。
2. `provider.BoundCallID` **实现缺失**；仅有行为契约（≤64、确定性、call/output 同映射）。
3. Active task via `task.py current` 为 none；本文件按用户指定路径写入 `10-18-magpie-protocol-parity/research/`。
4. 本轮只文档化算法与映射，不修改产品代码。
