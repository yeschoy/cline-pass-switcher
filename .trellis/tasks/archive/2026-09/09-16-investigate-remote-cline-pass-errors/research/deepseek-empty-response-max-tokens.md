# DeepSeek `empty response content` 与低 `max_tokens` 复现结论

## 事件

- NewAPI 页面时间：2026-09-18 17:20:22–17:20:23（UTC 09:20:22–09:20:23）。
- 模型：`pc/deepseek-v4.1-flash`，Switcher 解析为 `cline-pass/deepseek-v4.1-flash`。
- Switcher 请求：
  - `f04a61dc-05f8-4d41-84d1-f5dd108daa72`
  - `87f0a042-3606-489e-87b6-c39c0f1d63bf`
- 两次均为非流式、单次 DeepSeek provider attempt，最终 HTTP 500。

## 安全结构化证据

两次客户端请求及真实上游请求均包含：

- `max_tokens: 16`；
- 4 条消息：user → assistant tool call → tool result → user；
- assistant `content: null`，同时带 `bash` tool call；
- tool call arguments 为 `{}`；
- tool result 为非空字符串，长度与 trim 后长度均为 11；
- 首尾 user 内容也均为非空字符串；
- Switcher 只完成模型别名解析和 `providerOptions.gateway.order:["deepseek"]` 注入，没有改写 `max_tokens`。

Cline 上游真实响应为 HTTP 500：

```json
{
  "success": false,
  "error": "empty response content"
}
```

Switcher 将其规范化为：

```json
{
  "error": {
    "message": "empty response content",
    "type": "upstream_error"
  }
}
```

因此该事件不是已修复的本地 `400 messages.<index>.content must not be empty`，也不是空 tool result；请求已经越过 Switcher 输入边界并到达 Cline/DeepSeek。

## 对照与复现

- 同一时间窗口内，`max_tokens: 256` 的 DeepSeek 非流式请求成功，返回 `finish_reason: stop`，实际 `completion_tokens: 49`，assistant 文本非空；该请求正文更简单，只能作为容量量级对照，不能单独证明因果。
- 随后使用相同多轮 tool-call 历史，仅在 `max_tokens: 16` 与 `max_tokens: 256` 之间切换进行 A/B；操作者确认结果基本符合“16 触发空响应、256 正常”的判断。
- 现有 `server.js` 探测分类也把 `empty response content` 解释为请求已到达模型、推理耗尽输出额度而没有可见正文。

## 结论

根因基本确认是调用方给 tool-call continuation 设置的 `max_tokens: 16` 过低。DeepSeek 的内部推理和最终输出共享有限输出预算时，模型可能在产生可见 content 前耗尽额度，Cline 随后返回 `empty response content`。

## 建议

1. 调用方/NewAPI 不应把此类 Agent/tool continuation 固定为 16；普通验证至少使用 256，Agent 场景建议 512 或更高。
2. 保留原始 tool schema，并在客户端执行前拒绝缺少必填参数的 `bash {}`，避免无效工具轮次继续消耗上下文。
3. Switcher 默认不应静默抬高 `max_tokens` 或自动重放：这会改变调用方成本、延迟和输出契约。如需兜底，应做显式可配置策略并增加同账号、同 provider、幂等和计费测试。
4. 诊断时区分：
   - 本地输入 400：`messages.<index>.content must not be empty`；
   - 上游输出 500：`empty response content`，优先检查 `max_tokens`、工具历史和 finish/usage 事实。

本记录仅保留消息角色、长度、状态、Token 限额和安全错误结构，不包含提示词、账号名、凭据或 Header 值。
