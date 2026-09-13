# 实施计划

## 0. 开始前基线

- [ ] 读取 `prd.md`、`design.md` 和 Trellis backend/frontend/guides 规范。
- [ ] 确认工作区中现有 6 个未跟踪项均非本任务代码变更，不触碰根目录 SSH 私钥样文件。
- [ ] 备份本机实际 `config.json` 与 `metadata.json`（若存在），测试只使用临时 `DATA_DIR`。
- [ ] 运行 `node --check server.js`，确认基线可启动。
- [ ] 记录现有 `single`/`roundrobin`、全局 `perModel`、流式与非流式行为，作为兼容基线。

## 1. 配置契约与持久化

- [ ] 在 `server.js` 增加新配置默认值：`sticky` 模式、`concurrencyWaitMs`、`accountErrorRules`、账号 `id/maxConcurrent/perModel`。
- [ ] 编写唯一的模型路由规范化函数，供启动迁移、全局配置 API 和账号配置 API 共用。
- [ ] 启动时补齐旧账号稳定 id 与新字段；保留旧 `apiKey`、`upstream` 兼容镜像及全局 `perModel`。
- [ ] 规范化并校验状态码、动作、冷却时长、并发上限、等待时长及重试数。
- [ ] 将配置/元数据写入改成同目录临时文件后 rename，防止中断导致数据损坏。
- [ ] 在 `metadata.json` 初始化 `routingSecret` 与 `accountStates`；不通过 API 暴露 secret。

验证点：旧配置启动后不丢账号、密钥、全局路由和已知模型；新字段可持久化并在重启后恢复。

## 2. 会话识别与 Header 边界

- [ ] 定义 Codex、Claude、通用 Header 允许列表和始终禁止列表，避免散落重复常量。
- [ ] 实现大小写不敏感的 Header 读取、值长度/控制字符校验及安全复制。
- [ ] 实现 Codex 当前/父线程识别优先级，安全解析有界 `X-Codex-Turn-Metadata`。
- [ ] 实现 Claude session/agent/parent-agent 与 `metadata.user_id` 识别；拒绝普通 user id 冒充会话。
- [ ] 实现通用 session/thread/conversation 识别及首个 system/developer + 首个 user 消息 HMAC 兜底。
- [ ] 确保 `X-Client-Request-Id` 不会单独形成会话键，且不记录原始会话值/消息。
- [ ] 使用 Node 标准 `http`/`https` 封装 Cline 请求，固定覆盖账号 Authorization，只发送真实允许 Header，支持 JSON、SSE、AbortSignal 和超时。
- [ ] 保留公共 OpenRouter/文档抓取的现有 fetch 路径，不做无关传输重构。

验证点：mock 上游能看到允许 Header；看不到下游 Authorization、Proxy-Authorization、Cookie、逐跳 Header；请求未带 User-Agent 时看不到自动伪造的 `node` User-Agent。

## 3. 账号候选、HRW 与容量租约

- [ ] 将账号静态启用、封禁、冷却到期判断集中为一个候选函数。
- [ ] 冷却到期时自动恢复并持久化；封禁只允许管理 API 清除。
- [ ] 实现基于会话 HMAC 指纹与账号 id 的 HRW 排名，保证输入顺序无关和最小重映射。
- [ ] 保留 `single` 和 `roundrobin` 兼容行为，新增 `sticky`；无身份时回退 round-robin。
- [ ] 实现同步原子容量占用与幂等释放；所有错误/断开路径只释放一次。
- [ ] 实现 sticky 首选等待、超时次高账号临时溢出；round-robin 跳过满载；single 对已选账号只等待不做容量溢出；无容量时返回 429 + 有界 `Retry-After`。
- [ ] 确保流式租约持有到上游结束、错误或客户端断开。

验证点：同会话稳定、父子会话同账号、账号移除只重映射必要会话、并发计数不超卖且最终归零。

## 4. 固定账号供应商链与错误处置

- [ ] 将 `runChatChain`/单次尝试改为显式接收固定账号和上游 Header，删除供应商尝试内部的账号选择。
- [ ] 实现 `resolveModelConfig(account, model)`：账号 own-property 整项覆盖，否则完整继承全局。
- [ ] 在 `buildAttempts` 中统一使用规范化路由并按 `maxRetries` 限制外层尝试数；保留 direct/planner 注入逻辑。
- [ ] 建立上游结果结构，分别保留真实 HTTP 状态、规范化状态、脱敏消息和路由信息。
- [ ] 非流式错误不再在规则匹配前统一折叠 502；SSE 首包错误在输出前同样规范化。
- [ ] 实现全局规则动作：无规则、ignore、cooldown、ban，并记录最小必要状态。
- [ ] 只有 cooldown/ban 且未输出响应时允许一次换号；新账号重新解析自己的路由并从头执行，第二账号不再换。
- [ ] SSE 已开始后的错误只影响未来候选，不重放当前流。
- [ ] 集中脱敏账号 key、代理 key 和 Bearer 值后，才写错误、trace、历史或诊断 Header。

验证点：普通供应商重试的 Authorization 始终相同；429 冷却/500 封禁能改变后续候选；换号最多一次；重启后状态仍在。

## 5. 管理 API

- [ ] 扩展 `GET /api/accounts` 返回调度设置、静态账号、运行状态、当前并发和全局规则。
- [ ] 扩展 `POST /api/accounts`，在服务端完整校验并保留账号稳定 id/专属路由。
- [ ] 增加 `POST /api/accounts/recover`，按 id 手动清除封禁/冷却。
- [ ] 扩展 `GET /api/models?accountId=` 返回有效配置及 `global/account/inherited` 来源。
- [ ] 扩展 `POST /api/config` 的作用域、账号 id、保存专属配置及删除恢复继承操作。
- [ ] 让测试接口可选指定账号，以验证专属模型路由。
- [ ] 扩展历史/统计字段，保持旧消费者可读取原字段。
- [ ] 审核所有 `/api` 与 `/v1` 鉴权边界，确保新增管理端点沿用现有代理密钥保护。

验证点：无效 id、状态码、动作、时长、并发、模型配置均返回 400，不能写入损坏配置；未鉴权不能操作新增端点。

## 6. Web 控制台

- [ ] 在账号模式中加入 sticky，并增加 0～30000 ms 等待时间输入。
- [ ] 账号表增加每账号并发上限、当前并发、运行状态、短原因与恢复操作。
- [ ] 增加全局错误处置规则编辑器，支持状态码、ignore/cooldown/ban 和冷却时长。
- [ ] 在模型区增加全局/账号路由作用域选择器。
- [ ] 复用现有上游优先级、排除、严格/优先和排序控件，增加最大重试数。
- [ ] 账号继承状态下显示“复制全局”；专属状态显示“恢复继承”，避免隐式字段合并。
- [ ] 更新测试台以显示/指定账号路由视角。
- [ ] 新增动态文本全部 HTML 转义；为异步状态加入 `aria-live`，保持按钮与表单键盘可操作。

验证点：网页保存后刷新不丢配置；重命名账号不丢状态/绑定；复制与恢复继承行为明确；封禁账号可手动恢复。

## 7. 示例与文档

- [ ] 更新 `config.example.json`，展示新字段的安全默认值，不放真实密钥。
- [ ] 更新 README 的账号模式、账号级模型路由、并发/错误规则、Header 边界、状态恢复和 NewAPI 接入说明。
- [ ] 删除 README 中与实现不一致的旧 `maxRetries`/错误统一 502 等描述，保留 direct/planner 实测说明。
- [ ] 明确不提供设备/TLS/Cookie/Attestation 伪装及首期无 RPM。

## 8. 自动化验证

- [ ] 新增一个基于 `node:test` 的黑盒测试文件，使用临时 `DATA_DIR`、mock Cline 上游和 switcher 子进程。
- [ ] 覆盖 `single/roundrobin/sticky`、HRW、父会话、消息 HMAC、Header 允许/禁止列表。
- [ ] 覆盖账号专属路由、继承、普通供应商重试不换号、规则换号最多一次。
- [ ] 覆盖冷却/封禁持久化、手动恢复、并发等待/溢出/429。
- [ ] 覆盖流式、非流式、客户端断开及密钥脱敏。
- [ ] 在 `package.json` 增加 `test` 脚本。

执行：

```bash
node --check server.js
npm test
git diff --check
```

## 9. 真实缓存验收

自动化与控制台检查通过后再执行：

- [ ] 先向用户说明模型、账号范围与预计请求次数。
- [ ] 使用支持缓存的真实模型发送首次请求和一次相同长前缀请求。
- [ ] 记录两次路由账号、目标/实际供应商和 `usage.prompt_tokens_details.cached_tokens`。
- [ ] 不记录提示词正文、会话原值或任何密钥。
- [ ] `cached_tokens == 0` 时只结论为“路由稳定但未验证缓存命中”，不得根据配置宣称成功。

## 10. 最终质量门

- [ ] 按 `trellis-check` 检查 PRD/设计符合性、跨层数据流、输入校验、复用与一致性。
- [ ] 手工检查控制台：桌面宽度、窄屏、键盘操作、登录态、空账号、冷却/封禁状态。
- [ ] 搜索确认所有 Cline chat 调用都走统一账号/Header/错误路径，不残留供应商尝试内 `pickAccount()`。
- [ ] 搜索确认所有错误与观测输出都经过脱敏，且没有 session 原值持久化。
- [ ] 向用户报告自动测试结果、真实缓存结果、已知限制及尚未执行的外部验证。

## 高风险文件与回滚点

| 文件 | 风险 | 回滚点 |
|---|---|---|
| `server.js` | 配置迁移、流式生命周期、账号/供应商双层重试高度耦合 | 先完成纯配置/身份测试，再接入请求链；传输封装保持单一入口，必要时单点回滚 |
| `public/index.html` | 全局与账号配置视角可能导致保存错作用域 | API 契约和测试先稳定，再接 UI；每次保存携带显式 scope/accountId |
| `config.example.json` / README | 示例与真实 schema 漂移 | 最终从规范化函数字段逐项核对 |
| `metadata.json` 运行数据 | 错误迁移可能丢统计或账号状态 | 实现前备份；迁移只补字段并使用原子写入 |

不得修改 `.trellis` 任务以外的 Trellis 基础设施、`newapi-saas`、`cpa-strategy`、部署拓扑或根目录 SSH 私钥样文件。
