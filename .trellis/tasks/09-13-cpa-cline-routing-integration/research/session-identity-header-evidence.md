# Codex / Claude 会话与 Header 证据

## NewAPI 现有实现

来源：`/Users/lyh_god/GolandProjects/newapi-saas/setting/operation_setting/channel_affinity_setting.go`

### Codex

NewAPI 默认 Codex channel affinity 在 `/v1/responses` 使用请求体 `prompt_cache_key`。其真实 Header 透传模板包括：

```text
Originator
Session_id
Thread_id
Session-Id
Thread-Id
X-Client-Request-Id
User-Agent
X-Codex-Beta-Features
X-Codex-Turn-State
X-Codex-Turn-Metadata
X-Codex-Window-Id
X-Codex-Parent-Thread-Id
X-OpenAI-Subagent
X-OpenAI-Memgen-Request
X-ResponsesAPI-Include-Timing-Metrics
X-OpenAI-Internal-Codex-Responses-Lite
```

源码明确不默认透传 `X-Codex-Installation-Id` 与 `X-OAI-Attestation`。

### Claude

NewAPI 默认 Claude channel affinity 在 `/v1/messages` 使用 `metadata.user_id`。真实 Header 透传模板包括：

```text
X-Stainless-Arch
X-Stainless-Lang
X-Stainless-Os
X-Stainless-Package-Version
X-Stainless-Retry-Count
X-Stainless-Runtime
X-Stainless-Runtime-Version
X-Stainless-Timeout
User-Agent
X-App
Anthropic-Beta
Anthropic-Dangerous-Direct-Browser-Access
Anthropic-Version
```

本任务还需允许 Claude Code 的 session/agent/parent-agent Header，因为它们是账号粘性的强身份来源。

## cpa-strategy 已验证身份抽取

来源：

- `/Users/lyh_god/GolandProjects/cpa-strategy/internal/affinity/identity.go`
- `/Users/lyh_god/GolandProjects/cpa-strategy/internal/affinity/identity_test.go`

已验证身份 Header 集包含：

```text
X-Claude-Code-Session-Id
X-Claude-Code-Agent-Id
X-Claude-Code-Parent-Agent-Id
Session-Id
Session_id
Thread-Id
X-Codex-Turn-Metadata
X-Codex-Parent-Thread-Id
X-Http-Session-Id
X-Session-ID
X-Session-Affinity
X-Slot-Session-Id
X-Conversation-Id
X-Thread-Id
X-Parent-Session-ID
X-Parent-Session-Affinity
```

行为证据：

- Codex 的 `Session_id`、`Thread_id` 和 `X-Codex-Turn-Metadata.thread_id` 可归一成同一会话身份。
- `X-Codex-Turn-Metadata` 还可携带 `parent_thread_id`、`parent_session_id`、`parent_conversation_id`。
- Claude 可从 `X-Claude-Code-Session-Id` 或 `metadata.user_id` 中的 session 信息识别会话。
- `X-Client-Request-Id` 改变不应改变会话；单独出现时不得建立粘性。
- 普通 `metadata.user_id` 不应被当成会话。
- 所有身份只保存 HMAC 指纹；测试确认序列化结果不含原始 session。
- 消息兜底从稳定开场上下文派生，后续对话追加不改变身份。
- 过长或含控制字符的显式 ID 应拒绝。

## 本任务采用的结论

- Codex 与 Claude 使用不同优先级，不能只按一个通用 Header 顺序取首值。
- 有可信 parent thread/agent 时以父标识作为 HRW 路由键；否则使用当前会话。
- 允许列表中的真实会话/功能 Header 继续透传，但 Authorization、Proxy-Authorization、Cookie、逐跳 Header、Installation ID、Attestation 始终禁止。
- 请求体字段保持客户端/NewAPI 提供的真实值；消息 HMAC 只用于 switcher 选号，不伪造或注入上游客户端身份。
