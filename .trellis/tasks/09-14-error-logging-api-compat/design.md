# 技术设计：错误日志与 API 兼容修复

## 1. 范围与边界

本任务修改同一个请求生命周期在后端、JSONL 投影、控制台和集成测试中的表达。四项需求共享 `handleChat()`、`record()` 和日志 UI，不拆分并行子任务，避免多个实现同时修改相同文件与行为契约。

预计受影响：

- `server.js`：消息边界校验、`/v1/responses` 明确响应、SSE 完成识别、取消语义、日志投影。
- `public/index.html`：请求结果与上游失败尝试的明确说明和结果展示。
- `test/integration.test.js`：协议路径、输入边界、SSE 完成/取消/错误及日志统计回归。
- `test/ui-contract.test.js`：日志口径与安全渲染静态契约。
- `.trellis/spec/backend/*`、`.trellis/spec/frontend/*`：实现后同步新增的可执行契约。

不改 `lib/jsonl-log-store.js` 的存储、分页、压缩和保留机制，不迁移或重写现有 JSONL。

## 2. 请求入口顺序

请求数据流保持单一信任边界：

```text
HTTP 请求
  → 现有 proxyKey 鉴权
  → /v1/responses 明确 501（不选账号、不访问上游）
  → Chat body 限长、JSON 解析、对象/model 校验
  → messages content 校验
  → 会话身份提取与账号租约
  → 上游 provider chain
  → 统一最终日志/统计
```

### 2.1 `/v1/responses`

只为 `POST /v1/responses` 增加显式分支，返回：

```json
{
  "error": {
    "message": "OpenAI Responses API is not supported; use /v1/chat/completions instead",
    "type": "unsupported_api",
    "param": null,
    "code": "unsupported_api"
  }
}
```

HTTP 状态为 501，仍受现有 `/v1/*` 鉴权保护。不读取或转换请求正文，不进入 `handleChat()`、账号选择、日志统计或上游传输。

### 2.2 空消息校验

在 `handleChat()` 完成 JSON/model 校验后、调用 `extractSessionIdentity()` 和 `acquireAccountLease()` 前执行一个局部校验函数。它只负责“是否为空”，不尝试实现完整 OpenAI schema 转换：

- 字符串必须包含非空白字符。
- `null`、缺失 content、空数组、仅含空白文本/空对象的数组视为无内容。
- content 数组只要包含非空文本，或包含携带非空负载的非文本 part，即视为有内容；非文本 part 原样交给上游做协议校验。
- `role: assistant` 且存在非空 `tool_calls` 或合法 legacy `function_call` 时，允许 content 为空。
- 保留现有 `messages: []` 行为；本任务不扩大为“messages 必须非空”的新限制。

首个无效字段返回 400：

```json
{
  "error": {
    "message": "messages.6.content must not be empty",
    "type": "invalid_request_error",
    "param": "messages.6.content",
    "code": "invalid_request_error"
  }
}
```

错误只包含路径，不包含正文或序列化 message；拒绝发生在账号选择、上游请求、请求日志和统计之前。

## 3. SSE 生命周期和最终结果

### 3.1 Observer 状态

扩展现有 `createSseObserver()` 的有界状态，记录是否观察到完整 `data: [DONE]` 事件。仍按现有 64 KiB 单事件上限解析，不缓存整条流。

Observer 输出至少包含：

```js
{ usage, provider, canonical, error, normalizedStatus, done }
```

### 3.2 单一 finalizer 决策表

现有幂等 `finalize()` 继续拥有监听器清理、租约释放、统计和日志提交。结果按以下优先级确定：

| 条件 | 请求状态 | result | 错误尝试 | 统计/健康 |
|---|---:|---|---|---|
| 观察到 SSE error event | 归一化错误状态 | `failed` | 保留真实 terminal attempt | 错误；按现有健康规则 |
| 上游传输 error | 502 | `failed` | 保留传输失败 attempt | 错误；按现有健康规则 |
| 下游 close 且已观察 `[DONE]` | 200 | `success` | 无新增错误 | 成功；保留已观察 usage |
| 下游 close 且未观察 `[DONE]` | 499 | `client_cancelled` | 不写错误日志 | 计请求但不计错误/usage/健康结果 |
| 上游正常 flush | 200 | `success` | 无错误 | 成功；保持兼容（不强制旧上游必须发送 `[DONE]`） |

`observed.error` 优先于 `done`，避免错误事件后附带 `[DONE]` 被误记成功。下游关闭时仍销毁未结束的上游 body，但 finalizer 的幂等标记保证随后 error/flush 不会重复提交。

### 3.3 非流式取消

`runChatChain()` 已标记 `clientDisconnected`。非流式结束路径将其投影为 `499 / client_cancelled`，并传递给统计和日志层：

- 账号租约照常释放。
- 不返回/记录伪造的上游 502。
- 即使 abort 导致 trace 内部产生传输状态，也不为该取消请求生成错误日志。
- 已发生的客户端取消不进入账号错误规则和健康惩罚。

## 4. 日志契约

请求记录新增可选、向后兼容的 `result`：`success | client_cancelled | failed`。`status` 继续保存最终请求结果状态；客户端取消为 499。`errorCategory` 仅描述真实上游/代理错误，客户端取消保持 null。

`record()` 接受显式最终结果，不再只依赖 `info.error ? 502 : 200` 推断：

- 新记录始终写 `result`。
- `client_cancelled` 强制 499，并跳过该请求的 error-log attempt 投影。
- `success` 为 200；真实失败继续使用归一化状态。
- 请求日志仍一请求一条；错误日志仍一失败尝试一条。

请求日志查询允许 `result` 过滤；历史记录缺少字段时仍由原存储逻辑正常读取，不补写、不迁移。控制台对旧记录用状态推导显示标签，但不声称能纠正旧版 502 的真实语义。

## 5. 控制台表达

共享日志板块不复制 DOM 和加载逻辑：

- 请求板块标题/说明明确为“最终请求结果（每个请求一条）”。
- 错误板块标题/说明明确为“上游失败尝试（同一请求可能多条）”。
- 请求状态单元显示 `status + result`；错误状态单元显示 attempt status/upstream status。
- 新增文本继续使用 `textContent` 或静态 HTML；服务端字段仍经 `escapeHtml()`，详情只展示既有安全投影。
- 历史记录无 `result` 时按状态显示 `success` 或 `legacy_failed`，并在说明中标注旧数据可能缺少结果标识。

不改变日志分页、清空、游标、筛选代次和共享状态所有权。

## 6. 兼容性与数据安全

- JSONL 是追加兼容：新增字段不会破坏旧行；不执行 migration。
- 不改变日志文件数量/年龄/容量上限和 cursor identity。
- 400/501 错误不包含请求正文、密钥、Header、代理信息或账号信息。
- `/v1/chat/completions` 的账号、模型别名、provider 重试、usage、管道和代理传输行为保持原状。
- 不引入依赖或新配置项。

## 7. 发布与回滚

本任务只在本地质量门和复核通过后交付结果。生产部署需单独确认。

若获准部署：沿用现有不可变 release、部署前 data/config/metadata/logs 备份、compose 备份、健康检查和旧镜像回滚流程。发布后重点对照 NewAPI 对应渠道：正常 `[DONE]` 应为 `done/ok` 且 Switcher request log 为 200/success；主动取消应为 499/client_cancelled；现有数据文件校验值保持不变。
