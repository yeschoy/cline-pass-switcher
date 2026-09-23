# 设计：详细诊断丢弃分原因计数

## 1. 边界与唯一 owner

继续由 `DetailedLogStore.health` 持有唯一进程内计数，不增加存储文件、第二队列或 requestId→reason 表。把 `lib/detailed-log-store.js`、`lib/detailed-log-capture.js`、`server.js` 的每一个 `health.dropped++` 改为 `store.recordDrop(reason)`；`recordDrop` 仅接受固定内置枚举，未知内部调用归 `other`，在 `Number.MAX_SAFE_INTEGER` 达到时停止两侧递增，维持 `sum(dropReasons) === dropped`。`failure()`/`corrupt` 原样独立。

一次 `recordDrop()` 就是现有代码原本一次 `dropped++`：store 拒绝发布可能没有 manifest，而 full/error 详情根只要**任一** body `resource-limited` 就记一次，manifest 仍可存在。不要把它描述为“失败的请求数”。

## 2. 固定原因（API 字段 `health.dropReasons`）

| 内部枚举 | 来源 |
|---|---|
| `activeLimit` | `DetailRoot.active >= 128` |
| `attemptLimit` | 一个 root 超过 256 次 attempt |
| `attemptCaptureFailure` | 真实 transport 已启动但 `root.attempt()` 捕获设置抛错 |
| `captureBudget` | `BodyCapture.add()` 原始保留或 `materialize()` 脱敏输出扩容的共享 64 MiB `CaptureBudget` 拒绝 |
| `redactionSecretLimit` | 秘密值超过 256 项/64 KiB |
| `redactionWorkLimit` | depth/visited/token/match/assignment 等有界脱敏扫描工作量超限 |
| `redactionOutputLimit` | 输入/安全投影文本超过 5 MiB 或构造输出超过限额 |
| `redactionOther` | 脱敏步骤落入其他资源受限分支（如正则构造失败），不能归上述原因 |
| `storeQueue` | 不接收新发布/待处理 128 项栅栏 |
| `storeStale` | generation、时间过期、无效身份（含发布前后重复检查） |
| `storeOpenRoot` | full 模式前置 open 根不存在/不再 open/目录消失 |
| `storeSize` | manifest >1 MiB 或组大小超过 store 上限 |
| `storeCapacity` | inventory/admit 拒绝额度 |
| `other` | 保守兜底，不能为其填入动态错误文本 |

API 固定枚举可视为向后兼容的 additive schema；不改变 `dropped` 旧字段、`health.lastFailure`、登录边界或详细捕获默认关闭行为。候选原因类别应以代码可证明的首次/最高优先级原因计，不引入 request identity：同组多个 body 限制时，`captureBudget` > `redactionSecretLimit` > `redactionWorkLimit` > `redactionOutputLimit` > `redactionOther`；store 拒绝时按拒绝入口单独归因。普通 5 MiB 截断仍只是 `truncated`，不是资源丢弃。

## 3. 原因传递（只在内存）

- `DetailRedactor` 在第一次设置 `limited` 时留下固定的 `limitReason`。保持现有 `limited`/`unsafe` 分支和返回文本原样；不要因计数改变扫描次数、脱敏或复用的 `DetailRedactor` 行为。
- `BodyCapture` 将共享 raw/encoded budget 失败记为短生命周期内部原因。`materialize()` 返回给 `DetailRoot.finalize()` 的内部结果可携带固定 `limitReason`，但不得写入 `descriptor`、manifest 或 ordinary row。
- `DetailRoot.finalize()` 在 **原先**根级 `health.dropped++` 处，从捕获和 redactor 的固定原因集合中选一个主因后调用 `recordDrop`。不因一个 root 的多 body 失败重复增加总数。
- store 的所有拒绝分支直接调用 `recordDrop(<固定枚举>)`；异步 I/O 异常仍走原来的 `failure()` fail-open 路径，不伪造为 dropped。

## 4. 浏览器与兼容

`GET /api/logs/settings` 与 `GET /api/logs/details` 继续复用同一 `health` owner，只加固定 `dropReasons` 数字对象。控制台现有详情状态/`DETAIL_*` generation owner 接收该投影；在详情页使用固定中文标签、`textContent` 和 `aria-live` 展示非零桶，标明“本进程启动以来，诊断省略/拒绝次数”。缺字段的旧服务/历史响应显示“原因暂不可用”，不能从 `dropped` 猜分项。模式切换、clear、导航不重置或持久化本地假计数。

## 5. 风险与回滚

主要风险是漏改某个 `dropped++` 入口导致求和失真，或为了归因额外扫描正文引入热路径 CPU/敏感泄漏。用全库 grep、测试注入小预算和反向变异守卫；原因记录必须 O(1)，不扫描第二遍内容。回滚只需回退代码，不涉及 config/metadata/详细 manifest schema 迁移。本任务不推送/部署。
