# 普通日志内存索引与按偏移读取

## Goal

普通日志（`requests` / `errors` jsonl）的后台查询不再全量读取并解析日志段：用内存索引筛选，再按字节偏移只读取命中的行。让日志查询在高并发下不拖慢代理主线程，也不产生大块临时内存。

## Background（已确认事实）

- 存储实现：`lib/jsonl-log-store.js`（`JsonlLogGroup`），由 `server.js:230-236` 创建，限额为 requests 5 万条、errors 1 万条、两个流合计 100MB，单段 5MB。
- 写入：`append()` 每条记录一次 `handle.write`，串行队列，不调用 fsync，有待写队列保护（1 万条 / 16MB），写入不是瓶颈。
- 查询：`_queryPass()`（`lib/jsonl-log-store.js:523-569`）按"段内最新时间"从新到旧逐段 `readFile` + 逐行 `JSON.parse` + 排序 + `matches()` 筛选。
  - 命中稀疏的筛选（requestId、status、账号等）要解析全部约 100MB / 4.5 万条记录，单次约 0.3 秒 CPU，并有几十 MB 临时内存。
  - 翻页游标只记 `(ts, requestId, attemptIndex, segment, line)`，每页都要从最新段重新扫到游标位置，第 N 页的代价是 O(N)。
- 查询接口：`GET /api/logs/requests|errors`（`server.js:5586-5605`），筛选字段白名单：
  - errors：`from,to,requestId,model,requestedModel,resolvedModel,account,accountId,accountName,status,upstreamStatus,category,provider,targetProvider,accountAction,ruleId,ruleScope,ruleAction,errorScope,scopeEvidence,failureClass,healthAction,responseContentType`
  - requests：`from,to,requestId,model,requestedModel,resolvedModel,account,accountId,accountName,strategy,status,result,upstreamStatus,stream,provider,actualProvider,targetProviders,overflow,switched,accountAction,errorCategory`
  - 匹配语义见 `matches()`（`lib/jsonl-log-store.js:77-92`）：`from/to` 是时间范围；`status/upstreamStatus` 精确数值匹配；布尔精确匹配；`model/account/provider/accountAction` 跨多个字段匹配；其余字段都是大小写不敏感的子串匹配；数组字段匹配任一元素。
- 调用方：后台日志页 `loadLogs()`（`public/index.html:2133`）、工作流预览按 requestId 查（`public/index.html:1644`）、README 排障指引（`README.md:334`）、多个集成测试。
- 启动恢复已在 `d63c1f4` 改为只保留轻量字段，100MB 合成日志的恢复堆峰值约 60–90MB。

## Requirements

- R1 查询结果兼容：同一组筛选条件、limit、游标，返回的记录集合和顺序与现有语义一致（新到旧）；接口参数、返回结构、游标格式对调用方保持兼容（旧游标失效时安全回到第一页）。
- R2 筛选不解析 JSON：所有白名单筛选字段都在内存索引上判断，只有命中且要返回的行才按 `(segment, offset, length)` 读取并解析。
- R3 翻页 O(1) 定位：游标能直接定位到下一页的起点，不需要从最新段重新扫描。
- R4 requestId 精确查询走哈希定位。
- R5 内存上限：索引常驻内存在 6 万条记录规模下控制在约 10MB 以内（字符串字段做字典去重）。
- R6 写入、维护（过期 / 条数 / 字节清理、段重写）、清空、恢复都要同步维护索引，索引与磁盘始终一致。
- R7 不新增 npm 依赖。
- R8 索引落盘（用户已确认选项 1）：日志段关闭后（写满、进程关闭、维护重写生成的新段）生成同名的旁路索引文件；启动时有效索引文件直接加载，不解析对应日志段；只有正在写的段、缺失或校验不通过的索引才解析日志段并补建。索引文件损坏、缺失、与日志段大小不符都必须安全回退，不能导致日志不可用或查询结果错误。
- R9 回滚安全：回退到旧版本时，旧代码忽略索引文件也能正常工作；新版本启动时清理无主的索引文件。

## Acceptance Criteria

- [ ] 现有 `test/jsonl-log-store.test.js` 和全部集成测试通过。
- [ ] 新增测试覆盖：每个白名单字段的筛选结果与旧 `matches()` 语义一致；跨页游标连续且不重不漏；requestId 精确查询；维护和清空后索引一致；损坏或缺失的索引能被识别并回退重建。
- [ ] 压测（100MB / 约 6 万条合成日志）：命中稀疏的筛选查询一页不再全量读取段文件（readFile 调用数 ≤ 返回行所在的段数），耗时和临时内存明显低于当前实现；第 10 页的代价与第 1 页同一量级。
- [ ] 索引常驻内存在压测规模下 ≤ 约 10MB。
- [ ] 压测规模下，全部段都有有效索引文件时，启动恢复不解析任何已关闭的日志段（readFile 只读索引文件和正在写的段），恢复耗时和内存峰值明显低于 `d63c1f4`。
- [ ] 删除、截断、篡改某个索引文件后重启，该段被重新解析并补建索引，查询结果与删除前一致。

## Out of Scope

- 不改日志记录的字段内容和写入格式（仍是 jsonl）。
- 不改详细日志（`lib/detailed-log-store.js`）。
- 不引入 SQLite 或其他存储引擎。
- 不改后台日志页的 UI。