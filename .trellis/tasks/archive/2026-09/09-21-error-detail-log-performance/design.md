# 技术设计：错误详情与日志热路径

## 1. 单一详细存储、两种捕获 profile

`DetailedLogStore`继续是唯一详细持久化 owner。请求开始时根据配置快照选择：

- `full`: 现有完整详细捕获；
- `error`: 轻量collector，只在失败attempt出现后持有有界响应；
- `none`: 不创建collector。

当两个开关都开启时选择`full`，其失败attempt可直接由错误页关联，不再额外发布error group。

error collector只保存root安全摘要和失败attempt：`requestId`、稳定`attemptIndex/callId`、账号/provider安全身份、HTTP/outcome status、transport state、脱敏responseHeaders及可选responseBody descriptor。attempt token由request-local native-chat owner在真实transport start seam统一分配，capture profile不得成为索引owner。请求/成功正文均不存在。

## 2. 捕获 seam

### 非流式与首包前失败

调用方已经读出`res.headers`和`res.text`，分类失败后把同一文本的有界copy交给`BodyCapture`；不重新消费stream。账号/消息/credential discovery只在确认需要持久化错误时执行，不让成功上传承担成本。

### 已开始SSE

扩展`createSseObserver()`保留触发错误的有界完整原始event bytes及`errorPayload`。只保存该事件和upstream Headers；普通成功chunk、心跳和DONE不进入error body。收到response前的transport失败省略body并标记`no-response/transport-failed`；已起流后断流保留HTTP Headers和`stream-transport-failed`，但不复制此前成功chunks。

### attempt对齐

真实native chat request准备交给Node transport时分配`callId`和全请求递增`attemptIndex`，并随transport result进入trace、full/error capture和ordinary row。账号替换时不重置索引。未调用`req.end()`的RPM阻塞不创建已发送attempt；若token已预分配但transport同步失败则必须安全作废，不能留下可关联的伪attempt。

## 3. 脱敏与发布

error collector使用完整`DetailRedactor`：seed admin/account/proxy/custom-header secrets；失败时学习request结构中的credential字段、所有失败Header和error body，再统一project。BodyCapture沿用5MiB、64MiB group budget、UTF-8/partial安全省略和16,384工作上限。

一个request在最终化时最多发布一个group。失败重试后最终成功仍发布失败attempt。publication异步、受pending 128和store generation约束；失败只增加health。列表summary增加`profile:error|full`，body继续按需读取。

## 4. API/UI

`GET /api/logs/settings`返回两个开关；POST接受严格allowlist中的一个或两个布尔字段，先原子持久化再改runtime。旧`{detailedLogging}`请求继续有效。

ordinary error row仅在intent存在时增加`detailProfile: error|full`与`detailCallId`；off/legacy省略。不声称异步publication已durable。错误页用`requestId`读取group并按`attemptIndex/callId`双重定位，Headers用`textContent`、正文用textarea。无intent显示“当时未开启”；收到response前失败显示“未收到上游响应”；404统一显示“详情不可用（已过期、已清空、被容量边界丢弃或发布失败）”，不得逐条猜测。

## 5. ordinary queue边界

ordinary projection先对脱敏后的`reason`执行16KiB UTF-8边界截断并写`reasonTruncated`，同时拒绝任何超过64KiB的serialized row；完整诊断转由error detail按需承载。只有在单条已固定边界后，`JsonlLogGroup`才增加总pending records/bytes计数（默认值由focused tests固定，例如10,000条/16MiB）。append预留后入队；超限立即drop并返回resolved promise；finally释放预留。catalog/durable limits不承担pending内存边界，也不能在未界定单条记录时才检查。

## 6. metadata与退出

`commitStatistics()`只变更内存并由同一chat finalizer最终`record()`执行一次`saveMeta()`，消除正常终态重复原子写。非chat quota jobs、显式状态动作和管理操作保留其持久边界；不引入并行snapshot writers。

增加幂等shutdown coordinator：先停止listen、新quota调度和管理批次，关闭idle inbound连接，但保持log stores开放；等待active HTTP/chat finalizer至总deadline；active归零后fence新日志并await ordinary/detailed queues，最后关闭agents（keepalive子任务接入）。deadline到期才abort active upstream/socket、feature-detect关闭连接并强制退出。Detailed store关闭后新publication立即释放capture reservation并drop。

## 7. 验证

除安全/功能tests外，增加50MiB ingress成功路径copy计数、5MiB最坏脱敏event-loop benchmark、blocked I/O queue fence、metadata write call count和SIGTERM重启检查。绝对时间仅作同机证据；CI固定copy/parse/save调用次数、记录/queue上限、fail-open和shutdown deadline，不把主线程延后CPU误称为真正non-blocking。
