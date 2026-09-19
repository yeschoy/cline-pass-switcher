# Codex / Claude Chat 会话键与日志契约研究

## 结论

1. 当前 Switcher 已识别多种 Codex/Claude 会话标识用于本地账号 HRW；普通请求日志只保存 `sessionSource`，不保存键值。
2. 普通日志禁止保存原始 session/thread/conversation、`prompt_cache_key`、HMAC fingerprint 或消息内容；该边界必须保持。
3. 可以安全新增“采用了哪一类键、是否给上游提供 prompt key、最终 cache usage 是否明确命中”的枚举/布尔，而不记录键值。
4. 用户明确不修改 NewAPI；因此只能改善直接 Chat 请求和已透传到 Switcher 的字段。生产 `/v1/messages` 已丢字段时仍会退化为 `message_hmac`。

## 当前项目证据

- 身份提取：`server.js:1342-1398`。
- Codex 优先级：parent header/turn metadata → body `prompt_cache_key` → session/thread header → current turn metadata。
- Claude 优先级：parent agent/header metadata → session/agent header → current metadata。
- fallback：首个 system/developer + 首个 user 内容 HMAC；无内容则 round-robin。
- 请求日志：`server.js:1255-1284` 只投影 `sessionSource`；控制台详情 JSON可见该字段，但主表不直接显示。
- 日志规范：`.trellis/spec/backend/logging-guidelines.md:13,59-103` 明确禁止 raw session 与 HMAC fingerprint，只允许 source label 和安全 Header 名。
- 既有集成测试：`test/integration.test.js:300-360` 覆盖 generic、Codex parent-child、Claude parent-child 和 Header allowlist。

## 客户端与上游证据

### Codex

OpenAI Codex 源码（`openai/codex`, `codex-rs/core/src/client.rs`）当前行为：

- `prompt_cache_key()` 保留显式 override；否则 root 使用 response metadata 的 session ID；内部 subagent 可使用 source + parent thread。
- 请求 body 设置 `prompt_cache_key`。
- session headers 同时携带 session/thread 信息。

相关合并 PR：<https://github.com/openai/codex/pull/33035>

- 默认 prompt cache key 从 thread ID 改为 session ID；
- 保留显式 override；
- root/subagent 即使 thread ID 不同也使用同一 session-based cache key。

### Claude Code

Probe-backed 社区证据（用于字段发现，不作为官方 API 保证）：

- <https://github.com/router-for-me/CLIProxyAPI/issues/4452>
- Claude Code 2.1.x 可发送 `X-Claude-Code-Session-Id`，并在 `metadata.user_id` JSON 中携带相同 `session_id`。
- parent/root session 应优先于 agent/request ID。

Claude→OpenAI Responses 转换案例：

- <https://github.com/musistudio/claude-code-router/issues/1688>
- 转换器若丢失 Claude session，multi-channel upstream 会失去 affinity；在 caller 未提供时映射到 `prompt_cache_key` 可恢复稳定路由。
- 不应使用 agent ID 或 request ID替代根 session，也不应覆盖 caller `prompt_cache_key`。

### OpenRouter

<https://openrouter.ai/docs/guides/best-practices/prompt-caching>

- provider sticky 支持 body `session_id`、`x-session-id`，再回退到 `prompt_cache_key`/开场消息哈希；
- 手工 `provider.order` 优先，会关闭 provider sticky；
- sticky provider 不可用时才 fallback；
- session 有 inactivity TTL，不能由 Switcher 本地保证。

### Cline usage

<https://docs.cline.bot/api/chat-completions>

- 最终 usage 的 `prompt_tokens_details.cached_tokens` 是缓存读取证据。
- 因此日志三态只能来自明确字段：`>0=true`、`0=false`、缺失/非法=`null`。

## NewAPI 边界（只读既有证据）

`.trellis/tasks/archive/2026-09/09-17-improve-cache-hit-scheduling/research/newapi-session-path.md` 已确认：

- `/v1/chat/completions` 可保留 caller body `prompt_cache_key`，但渠道不把 Session/Thread Header 同步进去；
- `/v1/messages` 转换不保留 Claude `metadata`，也不生成 prompt/session key；
- 用户已决定本任务不改 NewAPI。

## 推荐安全投影

```js
{
  sessionSource,                    // 兼容粗粒度枚举
  affinityKeyType,                 // prompt_cache_key/session_id/.../message_hmac/none
  affinityConfidence,              // explicit/fallback/none
  upstreamPromptCacheKeySource,    // caller_prompt_cache_key/caller_session_id/derived_codex/derived_claude/none/invalid
  upstreamPromptCacheKeyApplied,   // 仅表示 body 中有可用字段，不表示远端采用
  providerOrderOverridesSticky,    // 手工 order 的已知语义
  cacheHit                          // true/false/null，来自明确最终 usage
}
```

禁止字段：key value、截断 key、hash prefix、fingerprint、raw session、message excerpt。即使 hash 不可逆，也可能成为稳定跨请求标识，仍违反普通日志边界。
