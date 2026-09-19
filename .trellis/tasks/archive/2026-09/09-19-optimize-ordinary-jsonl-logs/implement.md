# 普通 JSONL 性能实施计划

## 1. 基线和红灯

- [x] 读取 logging/error/quality/reuse specs 和父任务 research。
- [x] 冻结用户现有 dirty paths；确认本任务只改普通日志 owner、server integration、测试/spec。
- [x] 增加 injectable I/O/call-count 测试，证明旧实现构造/append/query/maintenance 会全扫。
- [x] 固化 5,000 条 3,607.9 ms 同机基线和测试数据形状。
- [x] 加入恢复期间 append、query/clear 503、组合预算和 stale cursor 红灯。

## 2. 目录级 group 与后台恢复

- [x] 在 `lib/jsonl-log-store.js` 内建立一个 requests/errors 目录 owner，不新增依赖。
- [x] 构造时只初始化目录和新 generation active segments；历史 reconciliation 异步运行。
- [x] 增加有界 segment catalog、ready/unavailable 状态和安全 503 error。
- [x] 恢复扫描每个旧段一次，处理 malformed/truncated/dedupe，并原子发布 catalog。
- [x] 恢复期间 append 进入新 active segments；合并后 old+new 完整可查。

回滚点：focused startup/recovery 测试未绿时不修改 server integration。

## 3. 增量 append 与 retention

- [x] 使用串行异步 `FileHandle.write` 和内存 size/count 更新；段满时滚动。
- [x] 保持串行即时 write，不添加定时缓冲或 fsync 语义变化。
- [x] 删除每 100 条全量 compact 和每请求 `enforceCombinedLimit`。
- [x] 实现按 catalog 的 age/record/combined-byte maintenance，只在边界段执行原子局部重写。
- [x] 对 queue/catalog/recovery-generation 设置固定上限，故障继续 fail-open。

## 4. Async query/clear 与 server integration

- [x] 把 query 改为 newest-first 分段异步扫描，`limit+1` 早停，稀有 filter 定期 yield。
- [x] 保持全部 filter/cursor 字段和 stale cursor 行为。
- [x] clear 通过同一 owner 串行化，独立清理指定 stream 并重开 active segment。
- [x] `server.js` 改用 group owner，GET await query，record 不再外部组合全扫。
- [x] 验证 503 仅影响普通日志 API，不影响详细日志、统计或聊天。

## 5. 性能和完整验证

依次运行：

```bash
node --check lib/jsonl-log-store.js
node --check server.js
node --test test/jsonl-log-store.test.js
node --test test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- [x] 运行同机 5,000 条基准：70.58 ms，满足 ≤ 360.79 ms。
- [x] 记录 startup、第一页 query、maintenance、heap 和 event-loop delay。
- [x] 审计普通投影无新增字段/秘密，详细 store 无代码变化。
- [x] 更新 logging spec 的 group、ready、segment catalog、局部 retention 和 async query 合同。
- [x] 只提交本子任务拥有的代码、测试、spec、research 和 Trellis 文件。
