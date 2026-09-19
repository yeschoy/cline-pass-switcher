# 排查 Cline 429 与上游重试路由

## Goal

基于请求 `bdbad1a0-18e9-40b4-87fd-3affb4bbcfe9` 的诊断记录和当前代码，明确 429 的来源层级、账号与 provider 实际尝试路径，并修正两级重试语义：每个 HTTP attempt 只钉住一个 provider，非账号错误在同账号按渠道健康度回退，只有明确账号级错误才允许冷却并替换账号。

## Background / Confirmed Facts

- 客户端请求模型为 `cline-pass/deepseek-v4.1-flash`，最终状态为 429。
- 请求级记录显示账号路径为 `账号5 -> 账号3`，共两次对 `https://api.cline.bot/api/v1/chat/completions` 的调用；两次 HTTP 状态都是 429。
- 两次 Cline 响应均为 `content-type: text/html; charset=UTF-8`、`content-length: 142`。当前材料只有 body ID，没有正文，因此不能把它严格定性为账号额度、Cline 边缘限流或实际 provider 限流。
- 最终诊断头为 `X-Cline-Target-Upstream: deepseek>fireworks`、`X-Cline-Actual-Upstream: unknown`、`X-Cline-Attempts: 2`、`X-Cline-Account: 3`。
- 当前实现先选定账号，再在该账号内执行 provider chain。匹配 `cooldown` / `ban` 的账号错误规则会立即终止该账号的 provider chain，最多更换一次账号；新账号从自己的 provider 链首项重新开始（`server.js:1570-1735`）。
- `X-Cline-Attempts: 2` 是所有真实上游 HTTP attempt 的总数，不等于两个不同 provider。结合两个账号各出现一次，现有证据更符合“账号5首个 provider 失败后切到账号3，再从首个 provider 重试”，不能证明执行了 fireworks。
- `X-Cline-Target-Upstream` 是路由目标列表；`X-Cline-Actual-Upstream` 只有在响应中可解析最终 provider 时才有值。`unknown` 不是 provider 切换证据。
- 生产配置的具体 `perModel` 和 `accountErrorRules` 未包含在材料中；但发生账号替换证明运行时已产生可移除账号的动作或部署版本存在等价逻辑。
- 当前 `preferred` 会通过 `order=[当前,...其余]` 让 Cline 网关在一次 attempt 内自行回退，无法精确观察和维护单 provider 健康度（`server.js:1442-1509`）。
- 当前 `META.models[model].upstreamStatus[provider]` 已按 `模型 × provider` 存储探测/部分错误状态，但不参与后端运行时 attempt 排序，成功、冷却、半开恢复和全不健康回退也没有完整契约（`server.js:830-892`）。

## Requirements

1. 区分三层 429：switcher 本地账号容量不足、Cline 网关 HTTP 429、Cline 内部实际 provider 限流；诊断不得把其中一层自动等同于另一层。
2. 请求与错误诊断必须能还原账号路径和 switcher 外层 provider attempt 路径，不把候选列表、目标列表或网关内部不可见行为当作实际 provider。
3. 429 归属分类必须保守：明确账号额度/套餐证据才能判为账号级，明确 routing/provider 证据可判为 provider 级，其余为 unknown。
4. unknown 429 默认按非账号错误执行：不冷却账号，在同账号继续下一个 provider；诊断保留 unknown 和受控证据字段，不记录原始响应正文。
5. 保留“优先+回退”模式，但其语义改为按用户选择的 provider 优先级由 switcher 外层逐次重试。每个真实 HTTP attempt 只注入当前 provider 的单元素 `only=[provider]`，不得通过 `order=[多个 provider]` 让 Cline 网关在一次 attempt 内回退。
6. 普通可重试错误和 provider/unknown 429 使用同一个账号，按健康路由后的 provider 顺序重试；同一账号内所有 attempt 必须保持相同 Authorization。
7. 只有明确账号级 429 且命中现有 `accountErrorRules` 的 `cooldown` / `ban` 才终止 provider chain 并替换账号；替代账号从自己的健康路由首项开始，现有最多替换一次的边界不变。
8. 按 `模型 × provider` 维护持久化渠道健康状态，不得把一个模型上的 provider 故障扩散到其他模型，也不得用账号级错误降低 provider 健康度。
9. 存在人工 provider 顺序时，该顺序在所有未冷却渠道中具有最高优先级：只临时绕过仍在冷却的渠道，不得再按 `ok/degraded/unknown` 标签重排其余渠道；冷却到期后渠道回到原人工位置接受半开探测，成功立即恢复。没有人工顺序时使用已探测列表的稳定顺序并应用相同冷却过滤。全部渠道不健康时 fail-open 到最早恢复、人工优先级最高的渠道，避免无请求可发。
10. provider 429 优先采用合法 `Retry-After`；缺失或非法时以 1 分钟为首次冷却基数并有界退避。5xx、网络错误和超时使用更短的有界退避；明确不可钉住使用长冷却。
11. 未显式配置 provider 时，如已有探测渠道则选择健康排序后的具名 provider；完全没有探测数据时允许一次 `auto/unattributed` 兼容兜底，且不得把结果归因到具体 provider。已知 provider 被全部排除时不得用 auto 绕过排除。
12. 诊断增强只允许持久化受控枚举、状态、时间、规范化 content type、字节数和脱敏原因；不得持久化请求消息、账号凭据或原始 HTML/JSON 响应正文。

## Acceptance Criteria

- [ ] 对该请求确定说明已切换账号，并对“是否从 deepseek 切到 fireworks”给出有证据边界的结论。
- [ ] 文档明确解释 `X-Cline-Target-Upstream`、`X-Cline-Actual-Upstream`、`X-Cline-Attempts` 与逐次日志的不同含义，并列出读取短期 response body、请求日志和错误日志进行最终取证的方法。
- [ ] planner、direct 和未知管道的每个具名 attempt 都只有一个 provider，测试证明不存在多 provider `order`，并证明人工顺序在未冷却渠道中不被健康标签重排、冷却渠道被绕过且同账号 Authorization 保持不变。
- [ ] provider 级和 unknown 429 在同账号进入下一 provider；明确账号级 429 才能按规则冷却并切换账号，且账号错误不改变 provider 健康度。
- [ ] 渠道健康以 `模型 × provider` 为键，覆盖失败降级、合法/缺失 Retry-After、模型隔离、冷却绕过、半开成功恢复、全不健康 fail-open 和重启持久化。
- [ ] 无显式 provider 时，已探测模型执行具名单 provider 健康路由；无探测模型只执行一次 auto/unattributed；全部排除不会回退 auto。
- [ ] 非流式、首包前流式错误和响应开始后的流式错误保持既有“不重复已开始响应”边界，并正确更新未来 provider 健康状态。
- [ ] 请求/错误日志能说明每次 429 的 scope/evidence/health action，且敏感数据与原始响应正文缺失测试通过。
- [ ] 变更不扩大到账号调度、会话粘性、账号配额抓取或并发租约策略。

## Out of Scope

- 未经明确授权访问或输出账号 Key、Authorization、消息正文等敏感数据。
- 在缺少证据时直接修改生产账号错误规则、冷却时长或账号池配置。
- 持久化 Cline 网关的原始 HTML/JSON 响应正文。
- 更改六种账号调度模式、账号健康/额度流水线或账号替换次数上限。
