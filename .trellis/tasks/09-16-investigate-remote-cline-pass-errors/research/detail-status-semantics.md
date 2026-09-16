# 生产详细日志状态语义核查

## 结论先行

用户在“详细日志”列表里看到的全是 `200`，在本次保留窗口内是事实，并非当前存在一批被隐藏的 `500`：截至 **2026-09-16 20:28:41 UTC**，现存 82 份详细 manifest 全部为 `request.status=200`、`request.result=success`，并与普通请求 JSONL 中同 requestId 的 82 条 `200/success` 一一一致。

但列表的展示确有信息缺口：它只显示 `request.status / request.state`，不显示已经由后端返回的 `request.result`。对 SSE 请求，HTTP 头一旦以 200 发出，流中稍后出现错误也不能把 HTTP 状态改成 500/502；这时合法且预期的数据组合会是：

- 详细日志：`request.status=200`、`request.result=failed`；
- 详细上游调用：`attempts[].status=200`（原始上游 HTTP 握手状态）；
- 普通请求日志：`status=4xx/5xx`、`result=failed`（最终语义化结果；当前保留实例为 400/429/500/502）。

当前详细保留区间没有这种失败样本；上述详细日志组合由已核对哈希一致的当前生产代码语义确定，保留普通日志中的 24 条历史流式失败仅旁证普通日志侧的最终状态与原始上游 HTTP 200，不能替代缺失的详细 manifest，也不把无关记录强行配对。

因此本次判断是：

1. **当前全是 200：真实反映当前详细日志窗口内没有最终失败。**
2. **SSE 先 200、流内后失败：属于预期 HTTP/SSE 语义。**
3. **详细列表不展示 `result`、状态筛选只筛 `request.status`：属于已确认的 UI 可观测性缺失。**
4. **本次 82 条可关联记录没有日志不一致。**
5. **没有证据表明 2026-09-14 的 `[DONE]` 后误判问题在当前版本复发。**

## 检查范围与生产基线

- 只读检查时间：**2026-09-16 20:20:37–20:28:59 UTC**。
- 目标：`ubuntu@167.114.158.4:49555`，容器 `cline-pass-console`。
- 当前镜像：`cline-pass-switcher:20260916-174357-529d642f4b8e-quota-forecast`。
- 容器启动：`2026-09-16 17:50:51.792135 UTC`；状态 `running/healthy`；重启 0；未 OOM。
- 主机检查时负载 `0.05/0.08/0.08`，可用内存约 56 GiB，根分区使用 50%，没有资源耗尽证据。
- 生产 `server.js`、`lib/detailed-log-capture.js`、`lib/detailed-log-store.js`、`public/index.html` 与本地当前文件 SHA-256 一致，因此以下代码语义适用于正在运行的生产版本。
- NewAPI 容器在本次检查开始前已于 `20:04:07 UTC` 启动；检查期间保持 `running/healthy`、重启 0、未 OOM。

## 字段语义与 UI 实际展示

### `request.status`

`DetailRoot` 包装 `res.writeHead()`，记录实际向下游提交的 HTTP 状态码。

- 非流式响应在最终结果已知后才 `writeHead`，因此通常直接显示最终 HTTP 400/500/502。
- SSE 在确认上游是可用事件流后立即提交 200；之后的 SSE error、上游传输中断或客户端断开都不能改写已发送的状态码。
- 若连接在任何 `writeHead` 前断开，值可能为 `null`。

### `request.result`

普通请求最终化时写入详细上下文，值为：

- `success`：最终成功；
- `failed`：最终失败，包括已发送 200 后出现的 SSE error 或流传输错误；
- `client_cancelled`：客户端在未观察到 `[DONE]` 或流内错误前取消。

前置 JSON/模型/空消息校验在 `recordChat()` 前返回，因此当前实现下详细 manifest 可记录 HTTP 400，但 `request.result` 仍为 `null`，且普通 requests JSONL 没有对应行。

### `attempts[].status`

详细捕获中的该字段是 Switcher 与 Cline 上游建立调用时观察到的**原始上游 HTTP 状态**：

- SSE 流内错误发生前已经收到上游 HTTP 200，所以详细 `attempts[].status` 仍是 200；
- 非流式原始上游 HTTP 500 则是 500；
- 尚未收到响应就发生网络错误时可为 `null`，并由 attempt state 标记 `transport-failed`。

这与普通 requests JSONL 中 `attempts[].status` 的语义不同：普通日志会把 SSE 流内错误改写为归一化后的 400/500/502，同时用 `upstreamStatus=200` 保留原始握手状态。

### `state`

`state` 表示**详细正文捕获完整性**，不是业务成功/失败：

- request：`open`、`complete`、`incomplete`、`resource-limited`、启动恢复后的 `interrupted`；
- attempt：`complete`、`interrupted`、`transport-failed` 等。

生产中 15 条流式请求均为 `result=success`，但 attempt state 均为 `interrupted`，对应 request state 为 `incomplete` 或 `resource-limited`。这直接证明不能用 state 判断业务是否失败；它只说明字节捕获是否自然完整。

### 生产 UI

`public/index.html` 当前列表实际显示：

```text
request.status / request.state · attemptCount 次调用
```

列表 API 已返回 `result`，但列表没有展示。点击“查看请求”后，完整 manifest 元数据 JSON 才能看到 `request.result` 和各 attempt 的 status/state。

状态筛选只匹配 `request.status`。因此未来若出现 `200/failed` 的 SSE 记录，筛选 500/502 不会找到它；应筛 `result=failed`，但当前详细日志 UI/接口没有 result 筛选。

## 当前详细 manifest 聚合

保留范围：**2026-09-16 18:10:28.741–20:24:29.063 UTC**。7 天 / 1 GiB 是保留上限，不代表当前一定存在 7 天数据；现存最早 manifest 只到 18:10。

| 项目 | 数量 |
|---|---:|
| manifest | 82 |
| `request.status=200` | 82 |
| `request.result=success` | 82 |
| `attempts[].status=200` | 82 |
| request state `complete` | 67 |
| request state `incomplete` | 11 |
| request state `resource-limited` | 4 |
| attempt state `complete` | 67 |
| attempt state `interrupted` | 15 |
| 无效 manifest | 0 |
| 400 / 500 / 502 manifest | 0 / 0 / 0 |

默认第一页取**最新 50 条**，这 50 条同样全部为 `200/success`；其中 request state 为 35 complete、11 incomplete、4 resource-limited。页面按时间倒序并通过“下一页”游标翻页；改变筛选条件后还必须点击“刷新 / 筛选”。

普通 requests JSONL 在同一详细窗口内也正好是 82 条：67 条非流式 `200/success`、15 条流式 `200/success`。按 requestId 关联后：

- 匹配 82，未匹配 0；
- `result` 不一致 0；
- status 不一致 0。

所以本次“详细日志全是 200”的首要原因不是分页漏掉当前失败，而是：**所有现存详细记录确实都成功，且历史失败发生在详细保留范围之前。**

## 普通请求/错误日志对照

### 普通 requests JSONL

保留范围：**2026-09-14 13:44:10.040–2026-09-16 20:24:30.252 UTC**，共 3,978 条：

| 最终状态 | 数量 |
|---|---:|
| 200 | 3,473 |
| 400 | 3 |
| 429 | 141 |
| 499 | 100 |
| 500 | 227 |
| 502 | 34 |

最终结果：3,473 success、405 failed、100 client_cancelled。

当前 Switcher 容器启动后共有 93 条：92 条 `200/success`、1 条流式 `499/client_cancelled`、**0 条 failed**。最后一条 failed 是 `2026-09-16 16:31:38.949 UTC`，早于当前容器启动和现存详细 manifest 起点。

### 流式最终失败

保留普通日志中有 24 条流式最终失败：

- 最终状态：400×3、429×1、500×1、502×19；
- 每条只有一次上游调用；
- 每次 `upstreamStatus` 都是 200；
- 普通日志中的 attempt status 被归一化为对应的 400/429/500/502。

这证明这些请求是“HTTP 200 已开始后，在 SSE 内容中得到错误”。对应详细 manifest 已不在当前保留区间，不能做逐 requestId 的 manifest 对照；依据当前生产代码，它们若被详细捕获，应是 `request.status=200`、`request.result=failed`、详细 `attempt.status=200`，普通日志为最终 400/429/500/502。

### 非流式 500/502

- 非流式最终 500：226 条，全部是单次调用，普通日志 attempt status=500、upstreamStatus=500。按当前代码，详细日志应显示 `request.status=500`、`request.result=failed`、`attempt.status=500`。
- 非流式最终 502：15 条，全部是单次调用，普通日志 attempt status=502、upstreamStatus=0，属于收到 HTTP 响应前的网络类失败。详细 attempt status 可为 `null`，state 为 `transport-failed`，最终 request status 为 502。

这些失败均没有落在当前详细 manifest 窗口内，因此上述详细显示是由当前生产代码确认，不冒充为当前 manifest 实测样本。

### 前置空消息 400

当前代码在调用上游前检查空消息：

- 最终 HTTP/详细 `request.status=400`；
- `attemptCount=0`；
- `request.result=null`（因为尚未进入 `recordChat()`）；
- 普通 requests JSONL 不写入该请求。

当前详细保留区间没有 400，故没有生产实例可进一步区分空消息、非法 JSON 或非法模型。普通日志中的 3 条流式 400 都是 `upstreamStatus=200` 的 SSE 流内错误，不是前置空消息校验，不能混为一谈。

### 错误 JSONL 的计数单位

错误 JSONL 保留范围为 `2026-09-13 12:42:44.498–2026-09-16 16:31:38.949 UTC`，共 1,310 条、1,108 个 requestId；状态 400×3、429×150、500×446、502×711。它按“失败的上游尝试”计数，不等于 405 个最终失败请求，并且其保留起点早于 requests JSONL。当前容器启动后没有新增错误尝试。

## NewAPI 安全证据

目标渠道为 ID 71，地址 `http://cline-pass-console:3123`。只查询了 PostgreSQL 中的时间、类型、stream 标志、status_code、stream_status 和请求 ID 存在性，没有输出正文、Key 或凭据。

### 当前详细窗口

在 `2026-09-16 18:10:28.741 UTC` 之后，NewAPI 该渠道有：

- 67 条非流式消费记录；
- 15 条流式消费记录，全部 `stream_status={status: ok, end_reason: done}`；
- 0 条渠道错误记录。

这与 Switcher 同窗口的 67 条非流式成功、15 条流式成功在时间窗口和数量上完全一致，但由于没有共享请求 ID，只能作为聚合级交叉验证，不能宣称逐条配对。

当前 Switcher 容器启动后，NewAPI 该渠道有 75 条非流式消费、17 条流式 done/ok、1 条流式 client_gone，且无渠道错误；与 Switcher 的 92 success + 1 client_cancelled 同样在聚合上吻合。

### NewAPI 的 200 与流状态

NewAPI 保留的流式消费记录中存在三种结束状态：

- `done/ok`：3,273；
- `client_gone`：103；
- `scanner_error`：2。

HTTP 200 只说明流式响应头已提交/请求已进入消费阶段，之后出现 `client_gone` 或 `scanner_error` 时 HTTP 状态仍可能保持 200，这是协议限制。相比之下，NewAPI 的 `stream_status=done/ok` 不是单纯“握手成功”，而是其流扫描器观察到正常结束；当前详细窗口的 15 条 done/ok 与 Switcher 的 15 条流式 success 相符。但 `done/ok` 只覆盖 NewAPI 自身的观察边界，在没有共享请求 ID 时不能证明某一条 Switcher 记录或最终客户端也已正常完成。

当前 NewAPI 容器访问日志中全局 `/chat/completions` 有 7 条 HTTP 200 和 1 条 403，但访问日志不带可安全关联到渠道 71 的共享 Switcher ID，不能拿这 7 条去强行对应某 7 个 manifest。

NewAPI 渠道日志的 `upstream_request_id` 未填充；5,548 个 NewAPI request ID 与 3,978 个 Switcher requestId、82 个详细 requestId 的精确交集均为 0。因此本报告只做时间窗口/数量/状态聚合关联。

## 证据等级判断

### 已确认

1. 当前生产容器和主机健康，没有重启、OOM 或资源故障。
2. 当前 82 份详细 manifest 全部是真实 `200/success`；与普通请求日志逐 requestId 一致。
3. 详细列表只显示 status/state，不显示 result；状态筛选也只按 HTTP status。
4. 24 条历史流式最终失败的原始上游 HTTP 都是 200，最终语义状态为 400/429/500/502。
5. 当前版本识别 `[DONE]`；当前详细窗口 15 条流式请求在 Switcher 为 success，在 NewAPI 为 done/ok，没有旧版 close-after-DONE 误判复发证据。
6. NewAPI 与 Switcher 没有共享 ID，不能做逐条关联。

### 由当前生产代码确认的语义（当前窗口缺少对应失败 manifest）

1. SSE 流内错误会形成详细 `200/failed` + 普通日志语义化 `4xx/5xx failed` 的组合；当前保留普通日志中的实例为 400/429/500/502，而非只有 500/502。
2. 非流式原始 HTTP 500 会在详细 request/attempt 上都显示 500。
3. 前置空消息会显示详细 HTTP 400、无 attempt、result null，且普通 requests JSONL 无记录。

### 尚需验证

只有在生产自然出现新的 SSE 流内错误、非流式 500 或前置空消息 400 后，才能用同一 Switcher requestId 对当前 manifest 与普通 JSONL 做生产实例级复核。本任务不主动发送失败请求，因为那会改变生产日志状态。

## 最小改进建议（仅建议，未修改）

1. **优先修 UI，不改 HTTP 语义**：在 `public/index.html` 的详细列表中显示 `HTTP ${status} / ${result} / 捕获 ${state}`，按 result 着色；把当前“状态码”明确命名为“HTTP 状态”。
2. 在 `lib/detailed-log-store.js` 的查询参数中增加 `result` 筛选，并在 UI 增加 success/failed/client_cancelled 筛选。验证方式：构造本地 SSE 先 200 后 error，用 `result=failed` 能找到，而 `status=500` 不会错误声称找到。
3. 在 `lib/detailed-log-capture.js` 的 attempt 元数据中同时保存并展示 `httpStatus` 与归一化 `outcomeStatus`，或在 UI 明确提示“attempt status 是原始上游 HTTP”。避免与普通 requests JSONL 的归一化 attempt status 混淆。
4. 将前置校验统一走一个最终化辅助路径，为详细日志设置 `result=failed`；若产品希望普通请求日志覆盖本地 400，再显式记录 `attemptCount=0` 的本地拒绝。不要通过伪造上游 attempt 来补齐。
5. 若需要 NewAPI 逐条关联，设计并安全传递一个共同 trace/request ID，并让 NewAPI 写入 `upstream_request_id`；在此之前继续只做时间窗口聚合。

## 只读与状态不变证明

检查前后均为：

- Switcher 容器 ID `884878fd…7807`，启动时间不变，running/healthy，重启 0，OOM=false；
- NewAPI 容器 ID `c8d5d79…dbbc9`，启动时间不变，running/healthy，重启 0，OOM=false；
- `/opt/cline-pass-switcher/data/config.json` SHA-256 前后均为 `da99749a…dd46e`。

本次未调用 POST/DELETE 管理接口，未发送测试业务请求，未修改配置、数据、日志、容器或镜像，未重启/部署/清理；未读取或输出 Key、代理凭据、请求正文或响应正文。
