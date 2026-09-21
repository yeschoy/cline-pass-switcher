# 普通日志、上游错误详情与日志热路径审查

## 最终决策状态（覆盖候选方案中的未决项）

- 新增独立`errorDetailLogging`，默认false；关闭时模型流量、ordinary字段/敏感数据面和默认错误列表保持现状。
- 开启时对每个真实失败attempt发起error-only捕获；5MiB/body等安全边界继续有效，“全部”指全部失败attempt而非无界字节。
- full与error同时开启时full优先，不重复发布。
- ordinary row只在intent存在时携带bounded profile/callId；group 404只能显示“过期/清空/容量丢弃/发布失败之一”，不能逐请求猜测原因。
- ordinary reason/row与pending queue都需先建立固定边界；CPU脱敏在主线程上只能描述为有界、延后、fail-open，不宣称真正non-blocking。
- shutdown顺序为stop intake -> wait active finalizers（stores仍开放）-> drain stores -> destroy connections/agents。

## 范围与结论

本报告是只读源码审查，覆盖 `server.js`、`lib/detailed-log-capture.js`、`lib/detailed-log-store.js`、`lib/jsonl-log-store.js`、`public/index.html`、相关测试、`.trellis/spec/backend/logging-guidelines.md`，以及归档任务 `09-14-detailed-request-logging`、`09-18-optimize-detailed-log-scan`、`09-19-optimize-ordinary-jsonl-logs`、`09-14-error-logging-api-compat`。

结论：

1. **上游错误响应 Header 与原始响应正文已经有保存路径，但仅在 `detailedLogging === true` 且请求属于详细捕获 allowlist 时保存。** Header 位于详细日志 root 的 `manifest.json -> attempts[].responseHeaders`；正文位于同 root 目录的 `<attempt.responseBody>.txt`，由 manifest 的 body descriptor 描述。两者在发布前按整个请求组统一学习凭据并脱敏。
2. **普通错误 JSONL 从设计上不保存 Header 值或响应正文。** 它只保存状态、归一化原因、规则/归因枚举、媒体类型和字节数。错误日志页只调用普通错误 API，所以看不到详细 Header/正文是数据源与 UI 契约共同导致的，不是渲染遗漏。
3. **现有详细日志页可以查看这些数据，但入口与错误日志页完全分离，默认关闭，且没有按 `requestId + attemptIndex` 的直接联动。** 列表还只突出 HTTP `status/state`，不突出 `result`；SSE 可能 HTTP 200 但最终 `result=failed`，进一步增加“看不到错误详情”的错觉。
4. **不能把 Header/正文直接加进普通错误 JSONL。** 这会违反当前严格敏感数据边界，并放大普通 append 的同步序列化、队列内存和 100 MiB 存储压力。
5. **性能基础已经比历史实现好很多，但仍有明确缺口：**普通 JSONL ready 后不扫历史、异步串行写入；详细 store 也已使用增量 inventory。不过普通 append 队列没有显式 pending 条目/字节上限；完整详细捕获仍在上传/流式热路径同步复制前 5 MiB，并重复解析/遍历 JSON；详细脱敏虽不被模型请求 `await`，但仍在同一 Node 事件循环中执行大块同步 CPU 工作；服务也没有 SIGTERM/SIGINT 日志 drain。
6. **推荐方案不是“强制开启完整详细日志”，而是复用同一个 `DetailedLogStore` 增加轻量 error-only capture profile：**只在真实失败尝试上保留经脱敏、严格截断的上游响应 Header/正文，不复制请求正文、成功正文或完整流；完整 `detailedLogging` 继续作为人工开启的全链路模式。错误日志 UI 通过 `requestId + attemptIndex` 按需跳转/读取详细 owner，普通 JSONL 仍只保留安全索引事实。

---

## 1. 当前数据流与实际落盘位置

### 1.1 普通请求/错误日志

生产只创建一个目录级 `JsonlLogGroup`，提供 requests/errors 两个 stream，目录为 `DATA_DIR/logs/`；请求上限 50,000，错误上限 10,000，合计 100 MiB（`server.js:96-104`）。

`record()` 构造两类严格投影（`server.js:1720-1783`）：

- request row：最终请求一条，含请求/实际模型、账号、provider trace 的有限状态事实、最终 `status/result/upstreamStatus` 等；
- error row：每个失败 attempt 一条，含 `requestId`、`attemptIndex`、账号/provider、`status/upstreamStatus`、`reason`、规则/归因枚举、`responseContentType`、`responseBytes`；
- 明确**没有** `responseHeaders`、原始 response body 或 body descriptor；
- append 以 `void Promise.all(writes)` fire-and-forget，不改变模型响应语义。

普通 error row 的确切允许字段在 `.trellis/spec/backend/logging-guidelines.md` “Request projection” 中被固定；同一规范的 “Sensitive-data boundary” 明确禁止任何 Header value 和 upstream response body 进入 ordinary JSONL。

落盘文件：

```text
DATA_DIR/logs/requests-*.jsonl
DATA_DIR/logs/errors-*.jsonl
```

### 1.2 详细日志中的上游 Header

当 `config.detailedLogging === true` 且 ingress route 命中 `detailRoute()`，HTTP server 创建 `DetailRoot` 并通过 `AsyncLocalStorage` 包裹 dispatch（`server.js:3057-3065`；`lib/detailed-log-capture.js:394-410`）。活跃 root 超过 128 时只丢弃诊断、继续正常 dispatch（`server.js:3059-3063`）。

每次实际 native POST `/chat/completions` 调用通过 `root.attempt()` 创建一个真实调用记录（`server.js:1947-1950`; `lib/detailed-log-capture.js:435-441`）。收到上游响应时：

- `attempt.status = res.statusCode`；
- `attempt.responseHeaders = res.headers`；
- 上游 body 在任何 SSE head/non-stream consumer 之前经过一个 backpressured `Transform` tap（`server.js:1962-1968`; `lib/detailed-log-capture.js:382-392`）。

最终发布前，root 先学习 ingress/downstream/attempt request/response 所有 Header，再学习所有 body，最后才投影 Header 与正文（`lib/detailed-log-capture.js:450-467`）。因此 manifest 中的：

```text
attempts[].responseHeaders
```

是经 `DetailRedactor.headers()` 脱敏后的上游响应 Header，而不是原始 Header（`lib/detailed-log-capture.js:205-207,450-467`）。Credential Header 直接变为 `[REDACTED]`；普通 Header 值可保留，但已知 secret/URL 凭据回显会被 scrub。

### 1.3 详细日志中的上游正文

每个 attempt 拥有独立 `output: new BodyCapture()`，其 ID 最终写到：

```text
manifest.json -> attempts[].responseBody
manifest.json -> bodies[]  // descriptor
<attempt.responseBody>.txt // 实际经脱敏正文
```

证据：

- `BodyCapture` 每个 body 最多复制 5 MiB，并记录 `observedBytes/capturedBytes/truncated/complete/state/omittedTailBytes/redacted`（`lib/detailed-log-capture.js:316-378`）；
- root publication 把 request input/output 与每个 attempt input/output 一起 materialize，并把 `attempt.responseBody` 指向对应 body UUID（`lib/detailed-log-capture.js:444-467`）；
- `DetailedLogStore.publish()` 先写 `<bodyId>.txt`，再写 manifest，最后 rename 发布（`lib/detailed-log-store.js:241-293`）；
- 存储目录为 `DATA_DIR/detailed-logs/<requestId>/`，目录 0700、文件 0600，固定 7 天/1 GiB（`server.js:104`; `lib/detailed-log-store.js:6-7,271-284`；logging spec “Store, retention and APIs”）。

这份 attempt response body 是 Switcher 在 Node 层实际读到的上游响应。它与 `request.responseBody` 不同：后者是 Switcher 最终写给客户端的响应，可能已经解包、归一化或脱敏。

集成测试直接证明了这个区别：`test/integration.test.js:1680-1729` 构造上游普通响应 Header、Set-Cookie、Location 凭据和 wrapper body；测试断言：

- `group.attempts[0].responseBody` 包含只存在于上游 wrapper 的内容；
- `group.request.responseBody` 不包含 wrapper、但包含最终客户端输出；
- Header/body 中的凭据在 group 和所有 body API 中均不存在。

### 1.4 未持久化但请求内可用的数据

即使详细日志关闭，非流式 attempt 在处理期间仍持有：

- `res.headers`；
- `res.text`（`clineRequestJSON()` 通过 `streamToString()` 读完整响应）；
- JSON parse 后的 `structuredError`；
- error-rule matcher 使用的 bounded/redacted failure text 与 request-local Headers。

对应代码为 `server.js:2667-2685` 和 `server.js:2622-2645`。这些 Header/body 只用于当次分类与规则匹配；trace 最终只带有限枚举/状态/媒体/字节数（`server.js:2711-2722`），不会把原始值持久化。

流式路径只由 `createSseObserver()` 保留 bounded event 状态、error payload/text、usage/provider 与总字节数（`server.js:2191-2222`）；完整 stream 只有详细 capture 开启时才由 attempt `BodyCapture` 保存。

传输层在收到 HTTP 响应前失败时没有可保存的响应 Header/body；详细 attempt 为 `status:null/state:transport-failed`，普通 error row 为 `upstreamStatus:0`。这类情况不能伪造“上游响应正文”。

---

## 2. 为什么“错误日志”页看不到 Header/正文

这是四个可验证原因叠加的结果。

### 2.1 错误日志页只读 ordinary errors API

`public/index.html:1241-1255` 的 `loadLogs()` 根据板块调用：

```text
GET /api/logs/requests
GET /api/logs/errors
```

然后只把返回 row 展开成 JSON。server 端 `/api/logs/errors` 允许过滤/返回的也是 ordinary projection（`server.js:3187-3212`）。该 endpoint 不 join `DetailedLogStore`。

### 2.2 ordinary schema 明确不含敏感值

`record()` 的 error object 只放 `reason/responseContentType/responseBytes` 等事实（`server.js:1767-1780`）。UI 即使完整展开 row，也没有 Header/body 可渲染。

`.trellis/spec/backend/logging-guidelines.md` 明确规定 detailed store 是唯一 Header/body 例外；把这些值加入 ordinary row 会违反已执行的安全契约。`public/index.html:239` 也明确告知操作者“正文/Header 值不会进入普通日志或元数据”。

### 2.3 详细日志默认关闭，历史错误无法补录

默认配置是 `detailedLogging:false`（`server.js:29-35`）。关闭时不会创建 `DetailRoot`，因而没有 Header/body 文件。后来开启只能影响新 root，无法从 ordinary JSONL 反推出已丢弃的原始响应。

详细页 banner 也说明“默认关闭”，且正文只有请求结束后可查（`public/index.html:164-177`）。

### 2.4 两个页面没有关联动作，详细列表也弱化了失败语义

详细页独立调用：

```text
GET /api/logs/details
GET /api/logs/details/<requestId>
GET /api/logs/details/<requestId>/bodies/<bodyId>
```

并在选中 group 后把 attempts metadata（包括脱敏 responseHeaders）写入 `<pre>`，再为每个 attempt response body 生成按需按钮（`public/index.html:1202-1224`）。

但 error row 没有“查看上游诊断”动作；操作者必须手工复制 `requestId`、切换“详细日志”、筛选，再选 attempt body。

另外详细列表当前渲染 `${row.status} / ${row.state}`，没有显示 `row.result`（`public/index.html:1208-1210`）。SSE 错误可能 HTTP status 仍为 200、而 request `result=failed`；归档生产诊断已记录这个混淆，并建议增加 `result` 筛选和区分 HTTP/outcome status（`.trellis/tasks/09-16-investigate-remote-cline-pass-errors/research/detail-status-semantics.md:112-160,217-220`）。

---

## 3. 当前性能与可靠性事实

## 3.1 ordinary JSONL 已经解决的性能问题

当前 `JsonlLogGroup` 的优点：

- 启动恢复异步，ready 前查询安全返回 503；恢复期间 append 可继续（`lib/jsonl-log-store.js:91-143,179-275`）；
- ready 后 append 只做单条同步 JSON stringify/Buffer 构造，然后进入一个异步串行队列，写当前 active `FileHandle`；不会每条枚举/stat/read/rewrite 历史（`lib/jsonl-log-store.js:331-382`）；
- retention maintenance 通过 segment catalog 工作，并由 `setImmediate` 调度（`lib/jsonl-log-store.js:384-461`）；
- append/maintenance 错误被 fail-open，记录安全 health/console 错误，不改变请求结果（`lib/jsonl-log-store.js:162-173`）。

`test/jsonl-log-store.test.js:37-70` 验证异步恢复与 ready 后 append/低阈值维护对历史的 0 次扫描。归档同机 benchmark 从旧实现 3,607.9 ms/5,000 rows 降到 70.58 ms，约 51.12×，event-loop p99 15.48 ms（`.trellis/tasks/archive/2026-09/09-19-optimize-ordinary-jsonl-logs/research/local-performance-validation.md`）。

因此，不应为 R1 再造一个普通日志 store、每错误一个大 JSONL 文件，或恢复“每请求 compact/全目录 scan”。

## 3.2 ordinary append 仍缺 pending queue 边界

`JsonlLogGroup` 只有 `this.queue = Promise.resolve()`，每个 append 把一个闭包和已序列化 `Buffer line` 链到 promise（`lib/jsonl-log-store.js:119,162-173,331-382`）。代码没有 pending record count 或 pending byte reservation。

在磁盘长期阻塞而请求继续到达时：

- 每个 request/error row 都会继续 JSON stringify 并持有 Buffer/closure；
- `maxTotalBytes` 约束 durable/live segment，不约束尚未执行的 promise 链；
- 现有 spec 声称“内存目录/队列必须有固定边界”，但该边界在 append queue 上没有实现证据。

普通字段通常很小，但 `reason` 目前也没有最终持久化长度上限：`errText()` 对结构化 error 做完整 `JSON.stringify`，`safeReason()` 对整个字符串逐 secret 扫描，最后 error row 原样写入（`server.js:820-830,2476-2488,1767-1780`）。非 JSON body 使用通用原因，不直接写 raw body，这是安全的；但巨大结构化 error 仍可能放大同步 CPU、Buffer 和 queue 内存。

## 3.3 ordinary 日志本身异步，但 metadata 仍在响应热路径同步重复写

`atomicWriteJson()` 使用同步 `mkdir/stat/writeFile/rename/unlink`（`server.js:79-91`）。一次 chat finalization 中：

- `commitStatistics()` 末尾 `saveMeta()`（`server.js:1618-1645`）；
- 紧接着 `record()` 更新 model metadata 后又 `saveMeta()`（`server.js:1720-1783`）；
- 某些 account/provider error action 还会在 attempt settlement 中额外同步 `saveMeta()`（`server.js:2650-2661`）。

非流式路径在 `sendJSON()` 前调用 statistics/record，因此这些同步原子写会推迟客户端拿到响应（`server.js:2990-3025` 附近）。这不属于 `JsonlLogGroup` 的缺陷，但属于“诊断/统计持久化不应显著拖慢请求”的同一热路径问题。最小收益点至少是一次 request finalization 合并重复 metadata write，而不是优化已经很快的 JSONL active-segment append。

## 3.4 full detailed capture 的热路径成本

完整详细模式不是纯后台工作：

1. `readBody()` 每个 ingress chunk 除原有 50 MiB request buffer 外，还同步调用 `detail.input.add(chunk)`，额外复制前 5 MiB（`server.js:2245-2288`; `lib/detailed-log-capture.js:316-339`）。
2. `handleChat()`/`readJsonBody()` 在 JSON parse 后同步 `redactor.learn(body)`（`server.js:2307-2311,2864-2872`）。
3. 每个 outbound attempt 在发网前把已 stringify 的 body 再放进 `BodyCapture`，并再次 `JSON.parse(String(body))`、`redactor.learn(parsed)` 来提取 model/provider（`lib/detailed-log-capture.js:435-441`）。这与调用方已经持有的 body/model/attempt metadata 重复。
4. 每个 upstream/downstream stream chunk 都经过同步 `capture.add()`；只复制前 5 MiB，之后只累计字节，且受全局 64 MiB reservation 保护（`lib/detailed-log-capture.js:29-36,316-339,382-392,411-430`）。
5. finalize 调用 `store.publish()` 后不等待磁盘；但真正的 group-wide discovery/materialization 是 `produce()` 内同步 CPU 工作，在 `DetailedLogStore` 的串行 promise queue 回调中、仍运行于主 Node 事件循环（`lib/detailed-log-capture.js:444-468`; `lib/detailed-log-store.js:241-293`）。每个 body 至少经历 discovery 与 materialization 两轮解析/扫描。异步 promise 不等于 CPU 不阻塞其他请求。
6. 每个 full root 先写一个 open manifest，完成时又读 open manifest、写 2+2×attemptCount 个 body 文件和新 manifest，再逐个 rename（`lib/detailed-log-capture.js:399-410,444-468`; `lib/detailed-log-store.js:243-284`）。这保留了崩溃后 interrupted identity，但增加 IOPS。

现有详细安全边界很好：单 body 5 MiB、全局 retained payload 64 MiB、active roots 128、store pending publication 128、attempts 256；超过边界丢诊断不丢流量（`lib/detailed-log-capture.js:5-36,316-378,401-439`; `lib/detailed-log-store.js:246-249`）。问题主要是**有界但仍可能大块同步**，以及成功请求也承担完整 capture 成本。

当前测试大量覆盖安全、backpressure、失败隔离，但归档 `09-18` 的性能数据只测 store inventory：5,000 roots 的 indexed query 2.77 ms、expiry 0.10 ms、publication 0.98 ms；它不包含 5 MiB JSON/SSE group redaction/materialization或上传复制（`.trellis/tasks/archive/2026-09/09-18-optimize-detailed-log-scan/research/local-performance-validation.md`）。因此不能用该 benchmark 证明 capture/sanitizer 对请求无显著影响。

## 3.5 detailed store 的 corpus 扫描问题已经解决

当前 `DetailedLogStore` 在启动时完整 reconcile，正常 publication/query/minute expiry 使用内存 inventory，最多每小时低频 reconcile（`lib/detailed-log-store.js:40-58,109-240,295-305`）。`test/detailed-log-store.test.js:40-72` 用 I/O 计数证明正常 publication/query/expiry 不 walk corpus、不重读历史 manifest/body。

归档生产证据显示旧扫描实现在约 368 MiB/23,367 files 语料上曾有周期性单核峰值和两次 heap OOM；部署 inventory 版本并重新开启详细日志后，5 分钟采样平均 0.040% core、最大 2.998%、无 OOM/restart（归档 `09-18` 的 `production-baseline.md`、`production-deployment.md`）。所以本任务不应回退到 per-error/per-query corpus scan。

## 3.6 进程退出没有可验证 drain

- `JsonlLogGroup.close()` 可以等待 queue 并关闭 active handles（`lib/jsonl-log-store.js:537-543`）；
- `DetailedLogStore.close()` 只清 timer，不等待 queue（`lib/detailed-log-store.js:51`）；
- `server.js` 没有调用两者，也没有 SIGTERM/SIGINT handler（全文件搜索无匹配）；
- integration helper 直接发送 SIGTERM，1 秒后 SIGKILL（`test/integration.test.js:98`）。

因此当前“响应完成后异步 append/publication”在正常容器终止时没有应用层 drain 保证。open detail manifest 可在重启时恢复为 interrupted，但刚排队、尚未写入的 ordinary row 或 detailed final publication可能丢失。R4 所要求的“进程退出时可验证落盘”目前存在明确缺口。

---

## 4. 候选方案比较

### 方案 A：把 Header/正文直接加入 ordinary errors JSONL

**不建议。**

问题：

- 直接违反 logging spec、项目 AGENTS 和现有安全测试；
- `/api/logs/errors` 列表会批量返回高敏内容，而不是按需读取；
- Header values、Set-Cookie、供应商 body 可能含 credential、用户内容和代理信息；
- ordinary recovery/query/maintenance 会反复解析大 row；
- 100 MiB combined budget 会被少量大错误迅速占满；
- pending queue 当前无字节上限，磁盘阻塞时风险更高。

即使先脱敏，也不能把“脱敏”当作扩大普通数据面的许可；现有规范明确要求先构建最小 approved projection。

### 方案 B：只改 UI，把 ordinary error row 链接到现有 full detailed record

**低风险、应做，但单独不足以满足需求。**

可做内容：

- error row 增加“查看上游诊断”按钮；
- 用同一 `requestId` 切到详细页并加载 group；
- 显示 attempt responseHeaders，并按需加载 responseBody；
- 详细列表显示 `HTTP status / result / capture state`，增加 `result` 筛选；
- 缺失时明确区分“当时未启用”“已过期/清空”“捕获/存储失败”。

不足：`detailedLogging` 默认关闭；错误发生时未捕获就无法事后恢复。也没有稳定 `attemptIndex` 显式字段来保证 UI 精确定位 ordinary error row 对应的 detail attempt。

### 方案 C：强制开启现有 full detailed logging

**不建议作为默认错误诊断方案。**

它能保存 Header/body，但同时保存 ingress prompt、outbound request、所有成功响应及完整流；成功请求也承担前 5 MiB 同步复制、重复 JSON learn/parse、group-wide sanitizer 与多文件 publication。它扩大了数据量、敏感范围和上传热路径成本，违背 R1/R4 的最小数据面原则。

### 方案 D：推荐——同一 detailed owner 下的 error-only capture profile + UI 联动

复用现有 `DetailedLogStore`、retention、redactor、body descriptors、认证与按需 body API，不新增第二 store/queue/cursor。新增的是捕获 profile，而不是新的持久化 owner。

建议语义：

1. **full profile**：现有 `detailedLogging:true` 行为，人工排障时保存完整模型 HTTP 内容。
2. **error-only profile**：对真实失败 upstream attempt 始终（或由独立、明确的安全开关）保存：
   - requestId、attemptIndex、provider/account 的已有安全身份；
   - 原始 HTTP status 与归一化 outcome status；
   - 经同一 `DetailRedactor` 脱敏的上游 response Headers；
   - 经同一安全规则处理、较小固定 cap（建议 256 KiB–1 MiB；若产品坚持可沿用 5 MiB）的上游 error response body；
   - `observedBytes/capturedBytes/truncated/complete/state/contentType`。
3. error-only **不保存** ingress Header/body、outbound request Header/body、成功 response body、完整成功 SSE 或最终 downstream body。
4. full profile 开启时不重复发布 error-only group；同一 request 仍只有一个 detailed root owner。
5. ordinary error row 继续不含敏感值，只增加必要的安全关联事实（例如 validated `detailProfile`/stable attempt index；不要声称异步 publication 已 durable）。UI 用 `requestId + attemptIndex` 调详细 API，而不是把 body 混入 ordinary API。

这一方案让正常上传/成功请求不付完整 capture 成本，失败诊断才复制 bounded error payload；同时保持 Header/body 在已有 7 天/1 GiB、认证、脱敏、按需读取的受控边界内。

---

## 5. 推荐实现边界（供后续 design/implementation）

### 5.1 采集 seam

#### 非流式

`attemptOnce()` 已经拥有 `res.headers` 和完整 `res.text`（`server.js:2667-2685`），`runChatChain()` 非 SSE 路径也已读出 `text`（`server.js:2791-2815`）。不要为了日志再读一次 stream。

在分类确定 attempt 失败后：

- 从现有 text 只复制 cap 内前缀到 `BodyCapture`；
- 将 headers、raw HTTP status、normalized status 与 stable attempt index 交给 request-local error diagnostic collector；
- 不把 raw text 塞入 trace、ordinary row、metadata 或 console；
- 在响应/重试控制完成后异步 sanitize/publish，失败 fail-open。

注意：当前 chat `streamToString()` 默认没有 response-size cap；这是既有模型路径风险。error-only logging 不应再制造第二份完整字符串，只保留 bounded copy。

#### SSE

不要 tap/保留完整成功 SSE。复用 `createSseObserver()` 已有的每事件 64 KiB bounded parser：

- 仅在识别到 error event 时保留该 raw complete event（或其结构化 error envelope）与 upstream headers；
- post-start error 仍只影响未来健康、不 replay；
- transport error 若没有完整 error event，只记录 Header、字节数和 `interrupted/transport-failed`，不能伪造 body；
- full profile 继续用现有 `observeStream()` 捕获完整前 5 MiB。

### 5.2 脱敏与 profile 合并

- 继续使用 `DetailRedactor` 的 group-wide learn-before-project 规则；不要创建弱化版正则 sanitizer。
- error-only 只在失败时对 request body 执行 credential discovery，避免所有成功上传都同步 `redactor.learn(body)`；发现完成后不要把 50 MiB request object 留在异步 queue closure。
- 必须 seed 当前账号 key/proxy、admin key、account custom Header values、request credential Headers，以及 ephemeral test credentials。
- 供应商错误 body 属于高敏内容，即使脱敏也只能落在 detailed owner。
- full mode 应移除可证明重复的 hot-path工作：调用方直接把已知 model/provider metadata 传给 `root.attempt()`，避免为了日志对已经 stringify 的 outbound body再 `JSON.parse`；最终 group prepass已会学习 capture body，删除提前 `learn()` 前必须由现有跨 body/partial credential测试证明安全不回退。

### 5.3 API/UI

建议保持现有 API owner，可扩展为：

- detailed list 增加严格 `result` filter；
- detail attempt metadata增加稳定 `attemptIndex`、`httpStatus`、`outcomeStatus`、`profile`；
- error row“查看上游诊断”切换到详细页，设置 requestId，并选中对应 attempt；
- Header 使用 `<pre>.textContent`，body 继续通过独立 text/plain endpoint按需加载到 textarea；
- 如果 body state 为 `truncated/omitted-for-safety/resource-limited/interrupted`，明确显示原因；
- detail 不存在时显示安全原因，不把 404 模糊成“没有错误”。

现有 UI 已安全使用 `textContent`/textarea 处理 arbitrary diagnostics，并有 stale-response generation owner（`public/index.html:1184-1231`; `test/detailed-log-ui.test.js`），应复用，不新建通用 store。

### 5.4 ordinary queue 与 reason 边界

在 `JsonlLogGroup` 同一 owner 内增加：

- `pendingRecords` 与 `pendingBytes` 固定上限；
- append 在持有 serialized line 前预留，完成/失败都 release；
- 超限只增加 bounded `health.dropped`，不等待/不影响模型流量；
- 已接纳记录仍保持单 queue 顺序；
- 对 ordinary `reason` 建立明确上限和 truncation fact，完整 bounded error body转移到 detailed owner。

不能简单“先 slice raw body 再脱敏”，因为 cap 可能切在 credential 中间。ordinary reason 应来自安全 bounded extractor；详细 `BodyCapture` 对 partial credential已有 fail-closed状态。

这会改变当前“长 structured error 完整写入 ordinary reason”的 spec，需要同步更新 `.trellis/spec/backend/logging-guidelines.md` 和相应 integration test；保留最终 nested cause可以通过头尾/结构化 bounded提取实现，但不能继续无界。

### 5.5 metadata 写入去重/异步化

优先级建议：

1. 先把同一次 request finalization 中 `commitStatistics()` 与 `record()` 的两个 `saveMeta()` 合并成一个；
2. account/provider state action 也由同一 request finalizer统一提交，而不是每 attempt同步写；
3. 若进一步异步化，只允许一个版本化、coalescing、bounded metadata persistence owner，继续使用同目录 temp+rename；
4. mutation 仍同步进入内存 authoritative state，写失败只记录安全健康状态；
5. graceful shutdown 必须 flush 最新版本。

不要创建 statistics/logging/provider 各自的 metadata writer，否则会发生旧快照覆盖新快照。

### 5.6 graceful shutdown

增加幂等 SIGTERM/SIGINT 流程：

1. 停止接收新请求；
2. 给已完成请求的 ordinary/detailed queue 一个有界 drain 窗口；
3. `await ordinaryLogs.close()`；
4. 把 `DetailedLogStore.close()` 改为 async flush-and-close（清 timer、await queue、拒绝/丢弃新 publication并释放 reservation）；
5. flush coalesced metadata owner；
6. 超时后输出安全状态并退出，不打印路径/body/credential。

测试应在模型响应完成后立即 SIGTERM，重启后验证 ordinary row、error detail与 metadata 一致；另测被永久阻塞的 writer在 deadline 后不会无限拖住容器。

---

## 6. 风险与必须守住的行为

1. **attempt 对齐风险**：ordinary `attemptIndex` 来自 trace；detailed attempts 来自真实 native transport。后续实现必须显式携带 stable index/call ID并测试 provider retry、account replacement、pre-stream SSE error、post-start SSE error，不能靠数组“通常同序”推断。
2. **异步 sanitizer仍可能阻塞事件循环**：把工作放进 promise queue只移出当前 response callback，不会移出 Node 主线程。需要 5 MiB worst-case benchmark/event-loop delay；若仍超预算，再考虑可 yield 的分阶段 sanitizer或 `worker_threads`，不要先引入复杂 worker而没有测量证据。
3. **失败响应可能包含 request内容**：error-only body仍是高敏数据。必须只走已有 authenticated detailed API/retention，绝不能在普通列表、service errors或 console 输出。
4. **空管理 key模式**：现有 auth contract在未配置 key时允许管理 API并由 UI警告。若 error-only 默认开启，暴露风险比当前 default-off full detail高；产品需明确是“始终捕获”还是新增独立 opt-in开关。无论选择哪种，都不能静默声称受密钥保护。
5. **截断安全**：Header/body cap不能产生 credential prefix/suffix泄漏；继续沿用当前 partial JSON/SSE/prose fail-closed测试矩阵。
6. **存储碰撞**：full root与 error-only root不能用同一 requestId各自 publish互相覆盖。profile选择必须在一个 request owner内合并或明确 full优先。
7. **保留/clear generation**：queued error detail在 clear后不能复活；继续复用 `DetailedLogStore.generation`。
8. **fail-open**：磁盘、脱敏、queue overflow、inventory overflow均只能丢诊断并更新 bounded health，不能改变 status/body、retry、account action、lease release或 SSE replay语义。
9. **退出 drain与 keep-alive**：`server.close()`可能等待长连接；shutdown需有 deadline并处理 idle connections，不能因日志 flush破坏正在进行的模型流。
10. **规范冲突**：当前 ordinary spec要求长 structured error完整保留；R4又要求无界工作不得进入热路径。两者必须显式收敛为“ordinary bounded reason + detailed bounded body”，不能在实现中静默改变。

---

## 7. 建议测试矩阵

### 安全/数据面

- HTTP 4xx/5xx JSON error：detailed error profile含脱敏 Headers/body；ordinary API/file无 Header value/body。
- HTTP 200 error envelope、non-JSON HTML 429、Set-Cookie、Location credential URL、Bearer/API-key回显。
- response body cap −1/exact/+1；credential正好跨 cap，必须 whole-body/group安全省略。
- transport failure无响应：只记录无 body事实，不伪造空完整 body。
- full mode开启时同一 request只有一个 detailed group，不重复存储。
- detailed API未认证返回401；空 key模式 UI持续明确警告。

### 生命周期/对齐

- named provider retry两个失败 attempt；`requestId + attemptIndex`精准打开对应正文。
- account cooldown replacement A→B；两个账号 attempt对齐。
- pre-stream SSE error可重试；post-start SSE error不 replay但可查错误事件。
- client cancellation不创建 ordinary error row；error-only也不把取消误记为上游错误。

### 性能/边界

- 50 MiB upload在 error-only/default路径不创建 ingress body copy；full profile最多复制5 MiB且转发字节相同。
- 成功 SSE在 error-only不保留完整流。
- blocked ordinary writer下 pending records/bytes不越界，超限drop且响应不受影响。
- blocked detailed writer下现有128/64 MiB边界持续生效。
- 5 MiB JSON/SSE sanitizer benchmark记录 wall time、event-loop p99、heap，不只测 store write。
- ready后的 error publication/query继续0 corpus walk。

### 退出/失败隔离

- 响应后立即 SIGTERM，重启可查 ordinary row与详细错误。
- detailed rename/write failure时客户端 status/body与关闭模式完全一致。
- metadata/ordinary/detailed各自失败不会二次改变请求错误语义。
- shutdown writer永久阻塞时按deadline退出，reservation/health可验证。

---

## 8. 已验证与未验证

### 已验证（源码/现有测试/归档证据）

- 上游 response Headers/body 的当前详细落盘结构与 ordinary缺失字段；
- UI两个数据源互不关联；
- detailed default-off、认证/no-store、按需 body API、脱敏与保留边界；
- ordinary append与 detailed inventory已消除历史全扫；
- full capture在上传/stream热路径的同步 copy/learn/parse位置；
- ordinary queue无显式 pending byte/record cap；
- SIGTERM/SIGINT无应用层 drain；
- 历史 ordinary/detailed store性能基准与 detailed旧扫描导致的生产 OOM证据。

### 未验证（本次未运行新 benchmark/故障注入）

- 当前生产流量下 full sanitizer的实际 event-loop延迟；
- 当前 metadata.json大小对应的双次同步 `saveMeta()`绝对延迟；
- error-only profile的最佳正文 cap（256 KiB、1 MiB或5 MiB）与默认开关策略；
- New API对这些管理页面的具体操作者入口（不影响本仓库数据流结论）。

本次只写入本研究文件，未修改业务代码、规格或其他任务文件。