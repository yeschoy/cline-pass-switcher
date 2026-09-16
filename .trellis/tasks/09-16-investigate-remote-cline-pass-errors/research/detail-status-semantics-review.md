# 详细日志状态语义独立复核

## 复核结论

截至 **2026-09-16 20:37:39 UTC**，对 `research/detail-status-semantics.md` 的独立复核完成。固定按原报告截止时间 **2026-09-16 20:28:41 UTC** 聚合后，核心数量、时间边界和状态语义均可复现，未发现需要改动结论或数量的问题。

唯一修正是收紧证据措辞：现存 24 条历史流式失败只能旁证普通日志侧“原始上游 HTTP 200、最终语义化 4xx/5xx”，不能替代已经不在保留区间的详细 manifest；详细 `200/failed` 组合由哈希一致的当前生产代码语义确定。报告同时补充了 NewAPI `done/ok` 只覆盖 NewAPI 自身观察边界，并非无共享请求 ID 时的端到端逐请求成功证明。

## 独立核验结果

### 1. 当前详细 manifest 与普通日志一致

固定截止到 20:28:41 UTC：

- 详细 manifest：82；无效 manifest：0。
- `request.status`：200×82。
- `request.result`：success×82。
- 详细 attempt：82；原始 HTTP status 200×82。
- request state：complete×67、incomplete×11、resource-limited×4。
- attempt state：complete×67、interrupted×15。
- 保留范围：18:10:28.741–20:24:29.063 UTC。
- 同范围普通 requests JSONL：82，均为 `200/success`；非流式 67、流式 15。
- 按 requestId：匹配 82、双方未匹配 0、status 不一致 0、result 不一致 0。

因此“当前详细列表全 200”不是分页或关联遗漏；现存 82 条确实都是成功请求。

### 2. 当前容器结果与失败时间边界

Switcher 当前容器自 17:50:51.792 UTC 启动。原报告截止前普通请求共 93 条：

- `200/success`：92；
- `499/client_cancelled`：1；
- `failed`：0。

普通请求日志最后一个失败为 **16:31:38.949 UTC**、最终状态 502，早于当前容器启动，也早于详细 manifest 起点 18:10:28.741 UTC。

### 3. UI 展示与筛选语义

生产文件与本地当前文件哈希一致：`server.js`、`lib/detailed-log-capture.js`、`lib/detailed-log-store.js`、`public/index.html`。

代码复核确认：

- 详细列表 API 返回 `result`，但列表文本只渲染 `status / state · attemptCount`。
- 查询允许字段没有 `result`；状态筛选只比较 `row.status`。
- 点击详情后，完整 manifest 元数据才包含 `request.result`。
- `state` 描述捕获完整性，不代表业务结果；生产中 15 条流式 success 的 attempt state 仍为 interrupted，与该语义一致。

### 4. SSE、非流式 500 与前置 400

代码路径确认：

- SSE 在接收到可用上游事件流后立即 `writeHead(200)`；详细 `request.status` 和详细 attempt status 均记录已提交/已收到的原始 HTTP 200。
- 后续 SSE error envelope 或传输错误会把普通请求最终化为 `failed`，并写入语义化状态。当前普通日志保留区内有 24 条流式失败：400×3、429×1、500×1、502×19；24 次 attempt 的 `upstreamStatus` 均为 200。
- 因此同一 SSE 请求可以合法形成“详细 `200/failed`、详细 attempt 200、普通日志最终 4xx/5xx failed”。当前详细窗口没有失败 manifest，不能声称已有同 ID 的生产实例。
- 非流式 500 共 226 条，attempt status/upstreamStatus 均为 500；按代码，详细 request/attempt 会显示 500，result 为 failed。
- 非流式 502 共 15 条，attempt `upstreamStatus=0`；按代码，详细 attempt status 可为 null、state 为 transport-failed，最终 request 为 502/failed。
- 非法 JSON、非法模型和空消息校验均发生在 `recordChat()` 前。详细捕获仍可记录 HTTP 400，但 `result=null`、attemptCount=0，普通 requests JSONL 无对应行。当前详细窗口没有此类 400 样本。

### 5. NewAPI `done/ok` 与 HTTP 200 的边界

对 PostgreSQL 使用 `BEGIN READ ONLY`，仅按渠道 71 查询时间、类型、stream 标志及 `stream_status` 聚合：

- 当前详细窗口：非流式消费 67；流式 `ok/done` 15；错误记录 0。
- 当前 Switcher 容器窗口：非流式消费 75；流式 `ok/done` 17；流式 `error/client_gone` 1；错误记录 0。
- 截止原报告时间的完整保留流式消费：`ok/done` 3,273、`error/client_gone` 103、`error/scanner_error` 2。

边界判断正确：HTTP 200 只表示响应头已提交，不能表达流内后续失败；`done/ok` 比 HTTP 200 更强，表示 NewAPI 流扫描器观察到正常结束。但数据库聚合本身不能证明 `client_gone/scanner_error` 各行的 HTTP 状态，也不能在无共享请求 ID 时把某条 NewAPI `done/ok` 当作某条 Switcher 或最终客户端的逐请求成功证明。

## 修正项

已仅修改当前任务报告 `research/detail-status-semantics.md`：

1. 将“24 条历史普通日志共同证明详细组合”改为“生产代码确定详细语义，历史日志仅旁证普通日志侧”。
2. 将代码确定但无同窗口 manifest 的语义从“高概率”改为“当前生产代码确认的语义”，并明确普通日志可能是 400/429/500/502，不只 500/502。
3. 补充 NewAPI `done/ok` 的观察边界，避免解读为端到端逐请求证明。

无其他待修问题。

## 只读与脱敏证明

- SSH 身份文件仅检查存在、0600 和 gitignore，未读取内容。
- 远程仅执行 Docker inspect、SHA-256、manifest/JSONL 安全字段聚合和 PostgreSQL 只读事务。
- 未读取详细正文 `.txt`、请求正文、响应正文、Key、Authorization、Cookie 或代理凭据。
- 未调用写接口，未修改配置、数据、日志、容器或镜像。
- 复核结束时 Switcher 仍为同一容器 ID、同一启动时间、healthy、restart=0、OOM=false；NewAPI 同样 healthy、restart=0、OOM=false；`config.json` SHA-256 仍为 `da99749a…dd46e`。
