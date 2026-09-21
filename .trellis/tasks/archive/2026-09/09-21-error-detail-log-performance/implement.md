# 实施计划：错误详情与日志性能

## 1. 红灯与契约

- [x] 为`errorDetailLogging`启动/保存/旧请求兼容写失败测试。
- [x] 构造多provider失败、账号替换、200 error envelope、SSE error、response前transport failure和起流后断流，固定request-local `requestId+attemptIndex+callId` owner。
- [x] 证明当前错误页无法访问attempt Header/body。
- [x] 对16KiB reason、64KiB row及blocked ordinary writer增加single-record/pending bytes/records红灯。
- [x] 统计一次chat终态`saveMeta()`调用次数，建立重复写红灯。
- [x] 建立50MiB上传copy和5MiB sanitizer benchmark。

## 2. Error-only capture

- [x] 在detailed capture owner内增加profile/collector，不复制成功请求。
- [x] 在capture-independent native chat seam分配稳定callId/index并贯穿trace/full/error/ordinary row；未`req.end()`不得形成真实attempt。
- [x] 非流式复用已读文本；SSE只捕获error event；transport failure无body。
- [x] full优先且不重复发布；失败后成功仍保留失败attempt。
- [x] 保持redactor/budget/retention/generation/fail-open全部安全测试。

## 3. API/UI

- [x] 扩展settings GET/POST strict shape与原子保存；off时ordinary row不新增intent字段。
- [x] 错误页增加按需查看、双重token匹配、off/no-response/stream-failed/missing-group诚实文案、stale generation和键盘/焦点行为。
- [x] 详细列表显示profile及HTTP/outcome/capture state，必要时增加result筛选。
- [x] 更新UI/static/production-VM测试，不用innerHTML插入任意诊断正文。

## 4. 性能与退出

- [x] 先界定reason/serialized row，再给JsonlLogGroup增加pending fence和health断言。
- [x] 合并chat statistics/record metadata保存，核对所有caller。
- [x] 移除full capture重复parse/metadata提取前先跑credential回归。
- [x] DetailedLogStore实现async close/drop-after-close。
- [x] 增加“stop intake -> wait active finalizers -> drain stores -> destroy sockets/agents”的有界shutdown coordinator及SIGTERM故障注入。

## 5. 验证

```bash
node --check server.js
node --check lib/jsonl-log-store.js
node --check lib/detailed-log-capture.js
node --check lib/detailed-log-store.js
node --test test/jsonl-log-store.test.js
node --test test/detailed-log-capture.test.js test/detailed-log-store.test.js test/detailed-log-ui.test.js
node --test test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- [x] 记录临时目录性能证据。
- [x] 更新`.trellis/spec/backend/{logging-guidelines,error-handling,database-guidelines,quality-guidelines}.md`、`.trellis/spec/frontend/{state-management,quality-guidelines}.md`与README。
- [x] 质量检查、提交并归档后再进入RPM任务。
