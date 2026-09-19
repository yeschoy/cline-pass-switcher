# 内容错误规则与统一编辑器设计

## 1. 持久/API schema

保留既有：

```js
accountErrorRules: {
  "429": { action: "cooldown", cooldownMs: 1800000 }
}
```

新增独立顶层字段，避免改变旧 map 形状并提高旧版本/旧客户端兼容性：

```js
accountContentErrorRules: [
  {
    contains: "quota exceeded",
    statusMin: 400,   // statusMin/statusMax 同时存在或同时省略
    statusMax: 499,
    action: "cooldown",
    cooldownMs: 300000
  }
]
```

规则严格 exact-shape：

- 最多 100 条；数组总 JSON ≤ 64 KiB；
- `contains` trim 后 1–500 字符，拒绝控制字符；
- 状态范围要么都省略，要么都是 100–599 且 min ≤ max；
- action 为 `ignore/cooldown/ban`；只有 cooldown 允许/要求 `cooldownMs` 1–2,592,000,000；
- 未知字段拒绝。

startup normalizer 对非法 persisted 新字段安全降级为空并记录配置警告，管理 POST 必须严格拒绝且不写。`GET /api/accounts` 返回两个字段。POST 省略 `accountContentErrorRules` 时保留当前服务端值；显式提供时完整替换。README/config example 同步。

## 2. 统一失败文本和匹配

新增一个 owner helper：

```js
normalizeFailureForRules(errorValue, sensitiveValues, maxChars)
accountActionFor({ normalizedStatus, failureText })
```

数据流：

```text
HTTP/SSE/transport failure
 -> existing unwrap / normalizeStatus
 -> errText preserves nested error object and redacts configured secrets
 -> safeReason(..., current request message values)
 -> flatten whitespace + bounded prefix
 -> lowercase once
 -> ordered content-rule includes check
 -> first match action OR existing exact status rule
```

只在失败状态执行。非 JSON/无安全结构的错误继续使用现有通用诊断，不把 raw response body带入匹配。匹配不记录全文、keyword 或片段；现有 trace/error logs 仍只使用批准的安全 reason/action 投影。

规则 matcher 的 worst case 受 100 × 500 + bounded failure text 限制。配置保存后可预编译 lowercase keyword/range 到运行时只读 cache；cache 由 `config.accountContentErrorRules` 唯一派生，不持久化为第二 owner。

## 3. lifecycle integration

- 非流式：`attemptOnce()/unwrap` 产生的规范化失败文本随 result 传给 `accountActionFor`。
- 首包前 SSE：完整首事件/错误 envelope 归一后执行同一 matcher，可沿既有最多一次换号路径。
- 首包后 SSE：observer 保存 bounded safe normalized error；finalizer 执行 matcher并可持久 cooldown/ban，但 `chain.started` 路径永不 replay。
- transport/proxy/network：仅匹配现有通用规范化诊断；客户端取消不调用 matcher。
- content `ignore` 返回明确 action 并跳过 status fallback；provider chain 仍按现有 ignore/unmatched 行为继续。

## 4. 前端单一草稿 owner

新增局部 `ERROR_RULE_DRAFT`：

```js
{
  statusRules: structuredClone(ACCS.accountErrorRules),
  contentRules: structuredClone(ACCS.accountContentErrorRules)
}
```

`loadAll()` 是唯一 hydration 点。`collectAccounts()` 从该 draft 生成两个 API 字段。账号表 redraw、搜索、抽屉、批量和导航不 hydrate 它。

### 可视化表

- 状态规则行：状态码、动作、cooldown；状态码唯一。
- 内容规则行：关键词、可选 min/max、动作、cooldown、上移/下移、删除。
- 新增按钮先创建本地合法默认行；所有输入先验证再 mutation。
- 使用 `textContent`/escapeHtml、原生 input/select/button、明确 label 和 aria-live。

### 高级 JSON

可折叠 `<details>` 中展示统一 shape：

```json
{
  "statusRules": {},
  "contentRules": []
}
```

打开/刷新时记录 draft generation 和文本 snapshot。编辑 JSON 不实时写 draft；“应用到草稿”先完整严格验证，再一次性替换 draft。若 visual generation 已变化则拒绝 stale apply，要求从当前草稿刷新。非法文本原样保留用于修正；关闭折叠不自动应用。这样 textarea 是 editor snapshot，不是第二 source of truth。

## 5. 预设兼容

现有 `ERROR_RULE_PRESETS` 只计算 `statusRules` diff：

- merge/replace/clear 语义保持；
- contentRules 始终保留并在预览中明确“内容规则不变”；
- confirm 更新 `ERROR_RULE_DRAFT.statusRules` 后继续通过普通完整账号 save；
- cancel 不改变 draft。

原始调度 JSON 继续包含 `accountErrorRules`；为避免同一字段有两个 UI owner，应改为从 `ERROR_RULE_DRAFT.statusRules` 读取/写入，并把新 `accountContentErrorRules` 加入其 exact shape，或明确将错误规则从原始调度 editor 移出。推荐前者，保持现有“完整调度草稿”能力和一次保存。

## 6. 测试与回滚

- integration：strict validation、startup normalization、old-client preserve、all action/order/range/fallback、nested error、stream phases、cancel、no secret persistence。
- account-draft VM：单一 draft、visual edits、advanced invalid/stale/apply、preset preservation、raw scheduling round-trip、完整 save。
- ui-contract/browser：native semantics、focus、keyboard reorder、aria-live、desktop/390px、长关键词滚动。

回滚时旧 `accountErrorRules` 不变。独立新字段被旧二进制作为未知顶层 config 保留；不得用旧 UI 的 destructive config rewrite 验证回滚而未先备份。
