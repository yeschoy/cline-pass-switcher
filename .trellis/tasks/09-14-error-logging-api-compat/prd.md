# 修复错误日志与 API 兼容问题

## Goal

让 Cline Pass Switcher 的请求/错误统计真实反映调用结果，减少无效报错，并补齐调用协议与输入边界，使运维人员能够区分正常完成、客户端取消、最终失败和上游尝试失败。

## Background

2026-09-14 对生产环境进行了只读排查，确认服务器资源、容器健康和启动日志均正常，但应用与 NewAPI 渠道日志存在以下问题：

- 生产容器 `cline-pass-console` 健康、零重启、无 OOM，问题不属于服务器资源故障。
- 近 24 小时应用请求日志中 939 个流式请求被记为 502；NewAPI 对应渠道同时记录 944 个 `done/ok`、仅 3 个 `client_gone`。
- 新容器启动后，NewAPI 的 28 个对应流请求全部为 `done/ok`，Switcher 却全部记成 502，证实正常流关闭路径存在误判。
- 错误日志按上游尝试记录，801 条错误尝试对应 603 个最终失败请求，当前界面没有充分区分两种口径。
- NewAPI 对应渠道近 24 小时另有 24 次 `POST /v1/responses` 返回 404。
- 真实上游失败主要包括 477 次流初始化失败和 126 次 `empty response content`；其中至少 60 次明确由 `messages.*.content` 为空触发。
- 本次部署保留了历史 JSONL 日志，因此部署后看到的总量不等于新版本启动后产生的错误。

## Requirements

### R1. Correct stream completion classification

- 正常完成的 SSE 流必须记录为成功，不能因下游在收到完成事件后关闭连接而误记为 502。
- 真正的客户端提前取消在请求日志中使用 `499` 和 `client_cancelled` 结果标识；不得写入上游错误日志，也不得计入错误统计或账号健康惩罚。
- 上游在首事件前失败、响应中返回错误事件或传输异常时，仍需保留真实失败状态。
- 每个请求只能完成一次日志与统计提交，并必须释放账号租约和事件监听器。

### R2. Distinguish request outcomes from attempt outcomes

- 请求日志展示最终请求结果；错误日志展示上游失败尝试。
- 控制台必须明确标注两种口径，避免将“错误尝试数”解释为“失败请求数”。
- 历史 JSONL 数据继续可读，不进行破坏性迁移或清空。
- 分页、过滤、日志上限和脱敏约束保持兼容。

### R3. Handle `/v1/responses` deliberately

- `POST /v1/responses` 返回稳定、可识别的 `501` 不支持响应，错误类型为 `unsupported_api`，并提示调用方改用 `/v1/chat/completions`。
- 本次不实现 OpenAI Responses API 与 Chat Completions 的协议转换。
- 响应格式和状态受集成测试保护，避免继续返回缺少语义说明的通用 `no route` 404。

### R4. Validate empty message content at the trust boundary

- 在账号选择和上游请求之前校验 `messages.*.content`，禁止空字符串、纯空白字符串、`null` 或不含有效内容的数组。
- 非法输入稳定返回 `400 invalid_request_error`，只报告字段索引/路径，不回显消息正文，也不自动删除、拼接或填充消息。
- 合法的 assistant 工具调用消息允许 `content` 为空；受支持的非文本内容部分不得仅因没有文本而被误拒绝。
- 错误响应不得包含消息正文、密钥、代理凭据或其他敏感数据。

## Constraints

- 不清空或改写生产现有日志、配置、账号、统计和路由数据。
- 不引入新依赖；优先复用现有解析、错误响应、日志和测试基础设施。
- 保持 `/v1/chat/completions`、管理 API、模型别名、账号管道、流式转发和 NewAPI 渠道兼容。
- 修改必须先在本地通过可运行测试；生产部署不自动执行，必须在展示本地结果后再次取得明确确认。
- 部署需沿用版本化 release、数据备份、健康检查和可回滚流程。
- 不处理与本项目渠道无关的 NewAPI、Sub2API 或其他服务器容器错误。

## Acceptance Criteria

- [x] 正常 SSE `[DONE]` 流在请求日志和统计中只记一次成功，NewAPI 正常关闭连接不会生成虚假 502。
- [x] 真正的客户端提前取消只产生一条 `499 / client_cancelled` 请求日志，不产生上游错误日志，也不计入错误统计或账号健康惩罚。
- [x] 上游首事件错误、流中错误、网络中断和非流式错误继续产生正确状态与安全诊断。
- [x] 控制台清楚区分“最终请求结果”和“上游失败尝试”，历史日志无需迁移即可展示。
- [x] `POST /v1/responses` 稳定返回 `501`、错误类型 `unsupported_api`，且不进入账号选择或上游转发。
- [x] 空消息内容在账号选择和上游请求前返回 `400 invalid_request_error`；合法工具调用和受支持非文本内容不被误拒绝，且错误不泄漏正文。
- [x] 相关集成测试覆盖正常流结束、客户端取消、错误流、日志口径、协议路径和输入边界。
- [x] `node --check server.js`、相关测试、全量测试和 `git diff --check` 通过；既有 quota scheduler 30ms 时序抖动已用同代码下完整通过和独立复现证据记录。
- [x] 本地质量门通过并完成变更复核；只有再次获得明确确认后才执行生产发布。
- [ ] 若获准发布，发布后容器健康、零重启，NewAPI 对应渠道验证成功，配置与数据文件校验保持不变。

## Out of Scope

- 修复 Cline/Vercel 模型本身的推理或容量故障。
- 修改 NewAPI 其他渠道、计费、用户令牌或全站重试策略。
- 清理生产历史日志、旧 release、旧镜像或构建缓存。
- OpenAI Responses API 与 Chat Completions 的协议转换。
- 自动删除、拼接或填充客户端消息内容。
- 未经单独确认的大规模协议转换框架或新增依赖。
