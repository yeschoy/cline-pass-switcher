# 评估 Switcher 原生 Responses 兼容层

## Goal

评估在 cline-pass-switcher 内新增 `POST /v1/responses` 兼容支持的可行性、风险与合理边界，并判断它是否适合作为当前 NewAPI Responses → Chat 工具类型 400 的长期解决方案。

## Background

- 当前调用链为：Responses 客户端 → NewAPI 协议转换 → cline-pass-switcher Chat 路由 → Cline → Vercel/OpenRouter。
- 当前错误的外层状态为 Switcher 502，内层真实失败为 Vercel 400；错误指向转换后某个 `tools[].type` discriminator，不是账号或网络故障。
- Switcher 当前只支持三个 Chat Completions 路由。`POST /v1/responses` 在鉴权后固定返回 501，且不读取正文、不选择账号、不访问上游。
- Cline Pass 在本项目中经验证的模型入口是 `${upstreamBase}/chat/completions`；尚无证据证明其原生 `/responses` 路由可用，因此 Switcher 侧适配的现实方案是双向协议转换，而不是简单透传。
- OpenAI Responses 不只是 Chat 字段改名：它包含 typed input/output items、typed SSE events、server-managed state、reasoning items、provider-executed tools、background/retrieve/cancel 等 Chat 没有的语义。

## Requirements

- 比较三种方案：继续在 NewAPI 转换、Switcher 内实现 Responses-over-Chat 兼容层、向 Cline 原生 `/responses` 透传。
- 追踪 Switcher 的完整生命周期：鉴权、正文限制、模型别名、会话粘性、账号租约、供应商重试、流式首事件、取消、统计、普通日志与详细日志。
- 明确 Responses 请求、非流式响应和流式 SSE 各自的转换难点。
- 明确 function/custom 工具与 Responses 内置工具的支持边界；不允许把不支持的工具静默伪装为已执行。
- 明确 stateful/background/WebSocket 等无法由现有 Chat 上游等价实现的能力。
- 评估 MCP、reasoning/thinking、图像输入输出、prompt cache 与 usage/billing 在双向转换中的语义损失。
- 区分客户端展示 usage、NewAPI 计费、Switcher 统计、Cline 额度和真实供应商消耗，禁止把其中任一口径宣称为其他口径。
- 给出一个可测试的最小兼容子集，以及不应宣称“完整 OpenAI Responses 兼容”的原因。
- 当前阶段只做调查和设计，不修改业务代码、不访问生产请求正文或凭据。

## Acceptance Criteria

- [x] 说明当前 Switcher 不能通过简单新增路由完成 Responses 支持。
- [x] 列出请求转换、响应转换、SSE、工具、状态、重试/取消、统计与日志方面的主要风险。
- [x] 给出三种方案的取舍和推荐顺序。
- [x] 给出建议的 Responses 兼容子集和必须显式拒绝的能力。
- [x] 说明 MCP、thinking、图像、缓存和 Token 口径可能出现的降级或不一致。
- [x] 用户确认 Switcher 暂不适配 Responses，并关闭本任务。
- [x] 本任务以调查结论结束，无业务代码实施，因此无需 implement.md 或实现测试矩阵。

## Recommended Decision

**现阶段不在 Switcher 实现 Responses → Chat → Responses 兼容层，保留明确的 501。**

推荐顺序：

1. 在 NewAPI 现有协议 owner 中修复当前非 function/custom 工具类型的转换或显式拒绝，解决眼前 400；
2. 对 Cline 原生 `/responses` 做隔离、无生产凭据的受控能力探测；只有确认其原生支持所需工具、reasoning、vision、usage 和 streaming 后，才设计 Switcher 原生透传；
3. 仅当产品明确接受无状态、function/custom-only、缓存和计费非等价等限制，并且确有“客户端必须直连 Switcher”的需求时，才重新考虑可选的兼容子集。

这样避免在 Switcher 再创建一个会长期追赶 OpenAI/Codex 协议、却无法保证 MCP、reasoning、vision、cache 和 billing 语义的第二转换 owner。

## Out of Scope Unless Explicitly Chosen

- 完整 OpenAI Responses API 兼容声明。
- 在 Switcher 内实现搜索、文件检索、Code Interpreter、MCP、Computer Use、Shell 等工具执行器。
- 持久化 Responses 对象并实现 `previous_response_id`、Conversations、后台任务、恢复流或 `/responses/compact`。
- 修改或部署生产环境。

## Final Decision

Switcher 保持 501，不实现有损 Responses 适配。当前 NewAPI 工具转换错误如需继续处理，应另立任务并在 NewAPI 的协议转换边界修复。
