# 账号池并发容量评估与改进建议

## Goal

量化 Cline Pass Switcher 当前账号池在明确工作负载、成功率和延迟条件下可承受的并发，区分本地准入上限与真实上游吞吐，并提出有证据、按收益和风险排序的改进建议。

## Background / Confirmed facts

- `server.js` 的账号级 `maxConcurrent=0` 表示不设本地上限；有限值通过租约计数准入，先检查并发，再预留 RPM。能否选中账号还受启用状态、所属 client key、冷却/保护、Quota、路由模式、缓存池活跃成员和等待预算影响（`server.js:1437-1508,1609-1720,1773-1809`）。
- 直连默认每协议 256 sockets、每个代理 Agent 默认 32 sockets；这些是连接池设置，不等价于可用账号并发（`server.js:3141-3158`）。
- 已归档的 `09-27-high-concurrency-path-investigation/research/method.md` 与 `measurements.md` 测了短时本地合成波次、429、SSE 和诊断成本；明确不代表持续容量或生产账号池能力。避免重复把历史数值当作本次实际容量。
- 多 client-key 账号池彼此隔离，缓存池目标按 owner 独立作用，不能将所有账号的配置值简单相加当作一个密钥可用容量（`.trellis/spec/backend/client-key-guidelines.md`）。

## Requirements

- 用户已指定先通过独立管理员控制台导入三条指定上游账号，备注均为 `09-28下午`，其余设置沿用最近同类账号，再评估**导入后的**真实账号池。不安排隔离压测；导入以外不修改生产调度/路由/诊断配置。350 RPM 只作为压测器的整池发送速率上限。**不预设并发峰值为 32**，而是逐级上探直到可归因的饱和或安全护栏；350 RPM 的均匀流量并不自动产生高并发。明确实际入口/所属 client-key 池、模型、流式/非流式、请求大小、响应时间、成功率与持续时间；指标必须区分同时在途请求数、成功吞吐、已完成请求吞吐和本地/上游 429。
- 首轮 `cline-pass/glm-5.3-flash` 的 dry-run 因两次上游 HTTP 500、可见多次尝试而熔断，没有 RPM 结果。用户随后明确改选 `cline-pass/deepseek-v4.1-flash`，该模型需独立预检与计费测量，不能与首轮混合统计。
- 用户已明确接受“客户端可见 429 或多次尝试响应才熔断”的剩余风险；不声称可在服务端内部首次上游 429 的瞬间停止。用户已批准第一轮护栏：整池发包速率 ≤350 RPM、计费请求总量 ≤900、运行 ≤5 分钟、同时在途紧急安全上限 64（不是目标峰值）；首个 429 或账号保护、健康异常按计划停止。只输出授权的安全聚合投影；受限远端进程可为验证身份和运行护栏而在内存中解析固定生产配置，绝不输出、导出、保存或提交生产密钥、配置原文、请求正文、代理凭据或账号身份。确认可用模型/密钥的安全取得方式后才对付费上游逐级加压；不修改生产配置。用户随后指定使用其提供的客户端密钥；脚本须通过本地无回显交互将该密钥仅传入远端进程 stdin，在私有进程内核对 owner，绝不能将聊天中的密钥复制到工具命令、源码、参数、环境、报告或测试。若不是 Legacy 池密钥，当前脚本必须拒绝而非替换成配置中的其他密钥。
- 已有合成调查只用于设计测试与归因，不替代本次真实账号池证据；本任务不重复开展隔离压测。
- 以代码路径、可复现实验和历史调查为依据，区分本地准入、连接/代理、上游限流/额度、SSE 长连接、同步持久化/诊断成本；给出排序建议及未证实假设。任何业务代码优化、扩容、部署均不默认包含在本任务。

## Acceptance Criteria

- [ ] 经独立管理员会话导入三条指定账号，仅新增所需账号字段；原有账号、模式、活跃选择、规则、管线与所有其它配置保持不变。读回核对名称、备注、归属及非密钥设置，避免输出/持久化密钥到任务记录；若无管理员会话或存在未保存草稿，则停下处理。
- [ ] 给出真实测试入口/所属账号池、运行版本、按观测自适应上探的负载矩阵、有限总请求/时间/紧急并发保护与熔断阈值；紧急上限不冒充测得的峰值，仅在确定上述边界后触发授权范围内的付费请求。
- [ ] 给出不同并发档位的成功率、有效成功 RPS、延迟分位（注明样本限制）、峰值实际在途数、局部/上游错误及 CPU/事件循环/内存的可核查摘要；明确容量判定所依赖的 SLO，并说明不能外推之处。
- [ ] 确认所测 owner 池的本地准入上限与实际可持续并发的区别；若缺少授权凭据或观测、达到安全预算前尚未观察到拐点，明确给出下界及未验证范围，不把它误报为绝对最大值。
- [ ] 产出按影响、证据、风险与代价排序的改进建议；重用已有研究而不虚构收益。清点本次临时产物，清理前征求用户同意（Trellis 日志保留）。

## Narrow root-cause diagnosis sub-phase (not a capacity run)

After both non-stream dry-runs stopped on HTTP 500/two attempts, the operator clarified the intended **client alias** is `pc/deepseek-v4.1-flash` (resolved target `cline-pass/deepseek-v4.1-flash`) and requested a streaming self-test. The bare `pc` is not an alias. Historical `max_tokens=16` empty-content failures and this task's `max_tokens=8` suggest a hypothesis, not a diagnosis of these HTTP 500 rows (no exact empty-content error was observed). Add a separately invoked read-only alias/route preflight, then at most **two sequential** requests with the same alias, prompt and `max_tokens=256`: non-stream followed by SSE only if the first succeeds once. Require a meaningful streamed delta plus `[DONE]`, no error event, and one attempt each. Preserve Legacy-key private stdin binding, continuous guards, first-visible-429/fanout/protection stop and the original 350 RPM ceiling; tighten diagnostic limits to two sends, at most eight reserved paid attempts, 120 seconds and one in-flight. No RPM ramp or capacity claim follows from this sub-phase; review locally before any independently authorized paid run.

## Operational gate

- 真实入口、可用凭据、owner 池和模型必须先由授权的只读安全投影确定；若无法确定，停止并请用户指定，不从生产配置明文推断，也不发计费请求。
- 预检发现所选生产模型允许一次 Provider 重试；服务端内部的上游 429 可能被重试成客户端 200，且进程内临时额度保护尚无实时只读投影。当前生成器能对**客户端可见**的首个 429、首个多尝试响应、持久化保护与容器健康停止，并以每请求最多四次尝试预留 ≤900 上游尝试，但无法在内部上游 429 出现的瞬间熔断。用户已在本轮明确接受按客户端可观测响应熔断；仍须完成导入后的凭据绑定、健康/路由/后台流量只读预检，且密钥只能通过本地无回显交互进入远端进程，不能复制聊天明文到工具命令。
