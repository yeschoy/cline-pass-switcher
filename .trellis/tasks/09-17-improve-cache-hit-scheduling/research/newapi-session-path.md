# NewAPI → cline-pass-switcher 会话字段链路（只读、脱敏）

## 范围

- 生产渠道：ID 71，启用，目标 `http://cline-pass-console:3123`。
- 数据源：PostgreSQL `BEGIN READ ONLY` 安全投影、生产渠道路由形状、当前 NewAPI 源码。
- 未读取或输出渠道 Key、代理、认证 Header 值、请求/响应正文、用户/token/IP 或原始会话值。
- 未修改数据库、渠道配置、容器或服务。

脱敏聚合：

- `newapi-channel71-config.json`
- `newapi-channel71-routes.json`
- `newapi-channel71-traffic.json`

## 已确认配置

渠道 71：

- `pass_through_body_enabled=false`；
- `header_override` 为空；
- `param_override` 只有一条 `set max_tokens`，不引用 `prompt_cache_key`、session、thread、messages 或 content；
- 没有 system prompt 覆盖；
- 没有渠道代理；
- 4 条高级路由中与推理相关的两条为：
  - `/v1/chat/completions` → `/v1/chat/completions`，converter=`none`；
  - `/v1/messages` → `/v1/chat/completions`，converter=`anthropic_messages_to_openai_chat_completions`。
- 数据库没有持久化任何 `channel_affinity_setting.*` 选项，运行时使用代码默认规则。

## 当前流量

最近 24 小时渠道成功消费记录中：

- `/v1/messages`：615 条，全部为 `deepseek-v4.1-flash`（603 非流式、12 流式）；
- `/v1/chat/completions`：主要为 DeepSeek 系列，并包含少量其他模型。

最近 1 小时的渠道成功消费记录全部是 `/v1/messages` 的 `deepseek-v4.1-flash` 非流式请求（采集时共 16 条）。

## 代码链路结论

### `/v1/chat/completions`

NewAPI 的 `GeneralOpenAIRequest` 明确包含 `prompt_cache_key`，因此客户端若在请求体中提供该字段，常规序列化路径会保留它。但当前渠道没有把 Session/Thread Header 同步到 `prompt_cache_key`，也没有透传这些 Header。Switcher 最近 24 小时全部使用 `message_hmac`，说明实际到达它的 chat 请求没有可用的显式键。

### `/v1/messages`

生产路由将 Anthropic Messages 转为 OpenAI Chat Completions。当前转换器构造新的 `GeneralOpenAIRequest`，但没有把 `ClaudeRequest.Metadata` 复制到输出的 `metadata`，也没有生成 `prompt_cache_key`/`session_id`。

渠道没有配置 Claude/Codex 会话 Header 透传；默认 NewAPI affinity 规则也不能补齐这条链路：默认 Claude 规则要求模型匹配 `^claude-.*$`，而生产 `/v1/messages` 使用的是 `deepseek-v4.1-flash`。即便规则匹配，其默认模板也只透传一组客户端功能 Header，不会把 `metadata.user_id` 写入转换后的 body。

## 根因边界

### 已确认

1. 当前生产渠道不会为 cline-pass 请求主动生成显式会话键。
2. 当前渠道不会把 Session/Thread/Claude Code 会话 Header 透传或同步到请求体。
3. `/v1/messages` 转换会丢失原请求的 `metadata` 会话信息。
4. 以上事实与 Switcher 全部请求使用 `message_hmac` 完全一致。

### 不能直接下结论

- 不能把 41.68% 未命中请求全部归因于会话键丢失。Switcher 的消息 HMAC 在首个 system/user 内容稳定时仍可保持账号亲和。
- 不能从现有普通日志计算“新会话首请求”的正常冷启动占比，也不能按会话判断上游 provider 是否漂移。

## 对 Switcher 方案的影响

- 仅调整 Switcher 的账号模式无法恢复 NewAPI 转换前已经丢失的 `metadata.user_id`。
- Switcher 可以继续使用消息 HMAC 兜底，但若目标是提高请求级命中率，需要至少一种稳定、显式且不含正文的会话信号到达 Switcher。
- 若坚持只改 Switcher，能够直接控制的主要杠杆是：缩小同时承载新会话的活跃账号池、避免候选集频繁变化、保持既有会话账号不迁移，以及避免因并发上限产生溢出；显式会话字段仍需由调用链提供。
