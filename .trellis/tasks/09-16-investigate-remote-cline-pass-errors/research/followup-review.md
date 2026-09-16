# 当前生产跟进报告独立复核

## 结论

复核截止：2026-09-16T05:45:45Z。

在修正持续性结论、NewAPI 旁证措辞和 `dropped` 计数语义后，`current-production-followup.md` 的原冻结快照统计通过复核。原报告的核心数学关系均可独立重算；未发现秘密泄漏或远程变更。

复核期间生产日志自然新增了 2 个真实网络类 502，但没有新增空消息 400。它们发生在原冻结快照之后，不应回写进原快照的 851/775/73/3 或 100/100/0；报告现已将其作为独立复核窗口补充。

## 通过项

### 1. Switcher 原冻结快照数量

按 `2026-09-15T20:59:18Z < ts <= 2026-09-16T05:32:19Z` 只读重算：

- 普通请求 851 = 成功 775 + 最终失败 73 + 客户端取消 3。
- 状态分布：200×775、499×3、500×62、502×11。
- 错误日志 73 条、73 个唯一 requestId，与 73 个最终失败一一对应。
- 73 条错误分类为：
  - `empty response content`：52；
  - `stream error after response started`：11；
  - 其他上游 500：10。
- 上述分类满足 52 + 11 + 10 = 73；其中 upstreamStatus=500 为 62 条，upstreamStatus=200 为 11 条。
- 当前容器启动后至原冻结快照：100 个普通请求、100 成功、0 最终失败、0 客户端取消、0 错误尝试。
- 请求和错误 JSONL 无效行均为 0。

### 2. 空消息输入 400

只读取详细 manifest 元数据，并以 NewAPI 固定短语布尔匹配旁证：

- 上次快照后至原冻结快照：49 个 HTTP 400。
- 当前容器启动后：48 个。
- 当前容器内时间范围：2026-09-16T05:10:35.498Z 至 05:30:00.461Z。
- 48 个均为 `POST /v1/chat/completions`、`state=incomplete`。
- 复核窗口 `05:32:19Z–05:45:45Z` 的详细 manifest 400 为 0；NewAPI `must not be empty` 错误也为 0。

因此，“原冻结快照前仍在出现”成立；“复核时又新增空消息 400”不成立。

### 3. 部署、容器、额度与基础设施

复核值与原报告一致：

- Release：`20260916-050450-b1f2170ef4a8`
- Commit：`b1f2170ef4a8ea14d62e9eef3fc058630c294cc8`
- Image ID：`sha256:39e8e1461b94811bcc72ee45dace953e5e2ab5f98655cb72b2e8ad8b568442a4`
- 容器 ID：`68cb9017589db3e546e5c2d4c50943770f6b451d22bdd10302ef81eade945f20`
- StartedAt：`2026-09-16T05:07:50.933967089Z`
- 状态：running / healthy；RestartCount=0；OOMKilled=false。
- 容器标准输出 2 行，异常关键词聚合为 0。
- 主机可用内存约 55.6 GiB，根分区使用率 46%，无资源耗尽证据。
- 9 个账号额度均为 fresh、无额度错误；额度池为 hot×8、warm×1。
- 账号近期健康评分为 available×7、degraded×2；这是请求结果统计投影，与额度 freshness 和容器健康不是同一口径。

原冻结窗口内 429、proxy、network 均为 0，因此额度、代理或网络不是该窗口 73 个失败的主要解释。复核后新增 2 个 network 错误，故报告已把“network 为 0”严格限定到原冻结窗口；当前证据仍不足以将两次短时中止上升为基础设施或持续网络故障。

### 4. NewAPI 仅作为旁证

NewAPI 使用 PostgreSQL `BEGIN READ ONLY` 聚合，渠道 ID 71：

- 上次快照后至 NewAPI 原查询快照：111 条错误、83 个唯一 NewAPI requestId。
- 安全分类：空上游响应 52、空消息输入 49、其他 500 为 10，总数 111。
- `upstream_request_id` 非空数为 0，无法与 Switcher UUID 逐条关联。
- 同窗口流式 consume 544 = `done/ok` 540 + `client_gone` 3 + 其他 1。
- Switcher 11 个 SSE 错误覆盖的整体时间段内，NewAPI 有 59 条流式 consume，全部为 `done/ok`。

最后一项只能说明同时间段的下游记录形态，不能证明 11 个 Switcher 请求包含在这 59 条中，也不能证明对应最终客户端成功。修正后的报告没有把 NewAPI 当作这 11 个 SSE 错误的根因或逐请求结论。

### 5. 详细日志 `dropped`

源码和只读设置投影确认：

- 原报告快照：`failures=0`、`corrupt=0`、`lastFailure=null`、`captureDropped=0`、`dropped=10`。
- `dropped` 会在并发上限、队列上限、generation/时效/ID 校验、open manifest 状态、单条/总容量准入等边界拒绝存储或发布操作时累加。
- 因而它是操作级累计数，不等于唯一请求数，也不是写失败数；存储异常由 `failures` 直接计数。
- 复核时 `dropped` 已自然增至 27，而 `failures=0`、`corrupt=0`、`captureDropped=0` 仍不变，进一步说明这些字段不能混为同一口径。

### 6. 秘密与只读边界

- 身份文件只检查存在、0600 和 gitignore；未读取其内容。
- 未输出账号 Key、代理 Key、Authorization、Cookie、代理 URL 凭据、请求正文或响应正文。
- 详细正文 `.txt` 未打开；只读取 manifest 元数据。
- NewAPI 仅执行只读事务；未调用 POST/DELETE 管理接口。
- 未重启、部署、清理或修改配置、数据、容器、镜像和日志。

复核前后以下状态一致：

- 容器 ID、Image ID、StartedAt、RestartCount、OOMKilled；
- `config.json` SHA-256：`f6ba3d7ec6702a87dc4d46849611c9a0a425fc52d2b39216ee213e6d0750368b`；
- `compose.yml` SHA-256：`18c6931b96932217e9f895d787be9bc0e111e3a9fcea6de3e6c3067eaf93cacb`；
- `deployment.json` SHA-256：`6a38d06563e6210dcc965e4566e47650f19c5df6a5d0c1fef16333bd7834ee24`。

## 已修正

1. 将“上游/运行时错误已经停止”“链路已恢复”等持续性措辞改为“截至原冻结快照存在无失败观察窗口”。
2. 补入复核窗口新增的 2 个 network/aborted 502，避免把原冻结快照误当作当前实时状态。
3. 将 NewAPI 的 59 条 `done/ok` 明确为同时间段旁证，禁止与 11 个 SSE 错误作逐请求对应或客户端成功推断。
4. 将 `dropped=10` 改为存储/发布操作级累计拒绝数，不再表述为 10 个详细捕获或 10 个请求。
5. 把网络错误为 0、100/100 成功和 48 个空消息 400 均限定到明确截止时间。
6. 修正一处“结束核对于”的文字错误。

## 复核时新增错误

原 Switcher 冻结点后至 05:45:45Z：

- 普通请求 56：成功 53、最终失败 2、客户端取消 1。
- 2 个失败均为流式 502、upstreamStatus=0、category=network、attemptIndex=0。
- 时间：05:34:13.796Z、05:36:40.318Z。
- 模型分别为 `cline-pass/deepseek-v4-flash`、`cline-pass/deepseek-v4.1-flash`。
- 两条安全原因均分类为传输中止；未输出原始原因正文。
- NewAPI 原查询快照后同期有 2 条“其他错误”记录，仍无 upstream requestId，不能声称逐条对应。
- 空消息输入 400 新增为 0。

## 残余风险

1. 生产日志会继续自然追加；本复核结论只覆盖到 2026-09-16T05:45:45Z。
2. 两个 network/aborted 502 缺少更下游的共享 requestId，无法确认具体传输中止点、客户端感知或是否同一网络事件。
3. 11 个 SSE envelope 错误仍无法与 NewAPI 逐 requestId 对照；59 条同期 `done/ok` 不能替代该证据。
4. 49 个空消息 400 的原始生成方仍未知；未读取正文，因此不能区分原始客户端输入与协议转换结果。
5. 10 个其他上游 500 和 703 个历史孤立错误 requestId 的既有证据缺口仍未消除。
