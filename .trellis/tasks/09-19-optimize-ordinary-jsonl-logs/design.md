# 普通 JSONL 增量段目录设计

## 1. Owner

`lib/jsonl-log-store.js` 继续拥有普通请求/错误日志。把当前两个彼此独立、再由 `enforceCombinedLimit()` 临时全扫协调的实例，收敛为一个目录级 owner，内部提供 requests/errors 两个 stream view。它只协调既有两个流的组合预算，不引入第二套日志或游标。

建议接口：

```js
const ordinaryLogs = new JsonlLogGroup({
  dir,
  streams: { requests: { maxRecords: 50000 }, errors: { maxRecords: 10000 } },
  maxAgeMs,
  segmentBytes,
  maxTotalBytes
});
ordinaryLogs.append('requests', record);
ordinaryLogs.append('errors', record);
await ordinaryLogs.query('requests', options);
await ordinaryLogs.clear('errors');
```

可保留薄的 `JsonlLogStore` 兼容导出供现有测试迁移期间使用，但生产只有一个 group owner 和一套组合维护队列。

## 2. 启动和恢复

构造函数只创建 0700 目录、初始化有界状态并创建本进程唯一的新 active segment；不读取历史 corpus。后台 `ready` promise 异步：

1. 获取恢复开始时历史文件快照，排除本进程新 active segment；
2. 每个旧段只读取/解析一次，记录 segment metadata；
3. 容忍损坏完整行和尾部截断；
4. 以现有身份规则清理中断替换造成的重复记录；
5. 执行一次局部化 retention；
6. 原子发布 segment catalog，并合并恢复期间新 active segment 的内存计数。

恢复期间 append 直接写新 active segment，不等待历史扫描；query/clear 返回 `503 ordinary logs initializing`，避免部分视图或与恢复删除竞态。恢复失败进入 unavailable 状态，模型 traffic 仍继续，日志管理 API 返回安全 503。

恢复期间新 generation 的累计 bytes/records 有固定上限；极端情况下超过本身完整预算时丢弃新的诊断追加并记录 bounded health/error，而不是无限排队。

## 3. Segment catalog

内存只保存段级元数据，不常驻完整日志记录：

```js
{
  name, stream, bytes, records,
  minTs, maxTs, firstIdentity, lastIdentity,
  active, generation
}
```

catalog 固定限制文件数和投影字节；超限保留磁盘文件、停止新诊断 publication 并返回安全不可用，不以隐藏记录数上限删除数据。完整记录仍只存在 JSONL 中。

每个 stream 保留一个异步串行 append chain 和打开的 active `FileHandle`。size/count/timestamp 在成功 write 后增量更新；达到段大小后关闭并滚动到新文件。并发已排队记录可以合并为同一批 write，但不增加定时缓冲窗口；不引入额外 crash-loss 时间。

## 4. Retention 与组合预算

一个目录级 maintenance owner 处理三个限制：

- stream record limit；
- age cutoff；
- requests+errors combined bytes。

触发条件是 ready 后越过已知阈值、segment roll、分钟级 age timer 或显式测试调用，不再每请求全扫。算法：

1. 从 catalog 找到完全过期/最旧的 immutable segment，整段删除；
2. 只有阈值落在边界段内部时才读取并原子重写该边界段；
3. 组合容量在两个 stream 的最旧 segment/record 间比较 `ts`，只处理需要淘汰的段；
4. replacement 先写 0600 临时段并 rename 成功，再删除旧段和更新 catalog；
5. active 段先滚动为 immutable 再参与边界重写。

正常维护复杂度与需要删除的旧段数量相关，而不是与完整 corpus 大小相关。

## 5. Query 与 cursor

`query()` 改为 async：

- ready 前抛带 `statusCode=503` 的安全错误；
- 对 catalog snapshot 从新到旧读取段；
- 每段解析后从后向前应用现有 allowlisted filter；
- 收集 `limit + 1` 个匹配即停止，因此普通第一页不扫描完整 corpus；
- 稀有过滤可能扫描全部段，但使用异步 read，并每固定记录数 `setImmediate` 让出事件循环；
- 不把 corpus 级记录数组常驻内存。

cursor 继续编码 `ts/requestId/attemptIndex/segment/line`。若 segment 仍存在，以 segment/line 为主并用身份回退；若 segment 已被 retention 移除，则按现有合同安全从最新结果重新开始。返回字段完全不变。

查询与 maintenance 通过 catalog generation/snapshot 协调；文件在读取前后消失视为安全 stale/missing，重试一次新 snapshot 或返回一致页面，不能抛原始路径错误。

## 6. Server integration

- `record()` 只提交严格投影给 group；不再在 `Promise.all` 后调用 `enforceCombinedLimit()`。
- group 自己调度去重的 maintenance；chat finalizer 不等待 maintenance。
- `/api/logs/{type}` GET 改为 `await ordinaryLogs.query(...)`；outer dispatch 使用现有 `statusCode` 产生安全 503。
- DELETE 通过同一 group queue 清理所选 stream，滚动 active generation，另一个 stream 不受影响。

## 7. Tests and benchmark

文件系统注入/计数测试覆盖：

- 构造到 listen gate 前无历史 read/rewrite；
- ready 后 append 不 `readdir/stat/readFile` 历史段；
- threshold maintenance 只读边界段；
- query 首页面只读需要的新段，稀有 filter 会 yield；
- 恢复期间 append 与 ready 后合并无丢失；
- query/clear ready 前 503；
- failure、dedupe、damage、cursor、clear、combined cap 保持合同。

基准在同一临时目录、同一进程分别运行旧基线与新实现或使用冻结基线 3,607.9 ms；5,000 条追加需低于 360.79 ms。记录 heap、event-loop delay、startup、query 和 maintenance，但绝对值不用于跨机器门禁。

## 8. Rollback

文件格式仍是原 JSONL。回滚代码不需要数据迁移；旧版本可读取新段。禁止在回滚中删除或重新格式化 operator logs。
