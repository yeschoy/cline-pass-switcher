# NewAPI 流式/非流式测试诊断

日期：2026-09-13

## 现象

NewAPI 批量测试中部分模型流式成功、非流式返回 500 `empty response content` 或 429。

## 远程证据

- 当前生产模式为 `roundrobin`，批量测试的流式与非流式请求被分配到不同账号，不能直接视为同条件对照。
- 历史记录证明 `cline-pass/glm-5.3-flash`、`cline-pass/qwen3.8-max` 等模型存在非流式成功记录。
- 一次 429 的原始原因是对应账号达到 Cline Pass 周额度；当前未配置账号错误规则，因此该账号未自动冷却退出。
- 两次 500 的原始上游状态均为 500，短原因是 `empty response content`，不是 switcher 将合法 200 响应改写为 500。

## 受控对照

经用户批准，用同一账号和 `cline-pass/deepseek-v4-pro`、相同最小提示进行对照：

- 直接 Cline Pass 非流式：HTTP 200、JSON、1 个 choice、正常内容。
- 直接 Cline Pass 流式：HTTP 200、SSE、包含内容并正常 `[DONE]`。
- 通过 switcher `/api/test` 固定同一账号的非流式：成功，实际供应商 `openai-compatible-private`，规范化状态 200。

未记录账号 Key、代理 Key、提示内容或响应正文。

## 结论

当前服务支持非流式。截图中的失败是账号/额度/瞬时上游条件与 round-robin 分配差异，不是全局非流式实现缺失。后续独立日志应明确记录账号选择原因、账号 ID、流式类型、原始/规范化状态及供应商路径，避免再次把不同账号的批量结果误判为协议差异。
