# 技术设计：账号级 RPM

## 1. 配置合同

账号canonical字段为`maxRpm`，strict整数`0..100000`，0不限。`normalizeAccount()`、POST validation、GET projection、config example和完整browser draft共用该字段。旧客户端提交完整账号但省略`maxRpm`时，以stable id保留previous值；新账号缺失为0。

## 2. 运行时状态

在`activeCounts/waiters`旁维护唯一owner：

```text
rpmWindows[accountId] = {
  timestamps: committed native chat start times,
  head: first live index,
  reservations: count
}
```

检查时prune `<= now-60000`并周期压缩。单账号committed live count+reservations最多为当前有限limit；总内存由账号数量×各自maxRpm配置界定，不声称固定常数。使用紧凑数组/head并及时删除无活动state。账号删除/key替换清理；disable保留窗口；重启为空。

## 3. 并发优先与permit生命周期

`tryLease()`返回结构化结果而非只返回null：

1. 检查hard eligibility由上层完成；
2. 若`maxConcurrent`满，返回`blockedBy=concurrency`且不触碰RPM；
3. 若并发可用，尝试reserve首个RPM permit；失败返回`blockedBy=rpm,retryAt`；
4. permit成功后增加activeCount并返回lease。

lease持有first permit。native `/chat/completions` seam先创建`ClientRequest`，紧接`req.end(data)`前/时原子`commit()`把reservation变为timestamp；`lib.request()`同步失败或调用`req.end()`前结束必须release reservation并`notifyCapacityWaiters()`。一旦`req.end()`调用，后续DNS/connect/proxy/TLS失败也属于真实attempt且不退款。后续provider attempt通过lease broker请求新permit。

## 4. 选择、等待和重试

所有模式在候选排名内跳过RPM耗尽账号。wait复用现有全局capacity waiter并增加“最早rpm retryAt”定时唤醒；无per-account timer/refill queue。总等待仍受`concurrencyWaitMs`限制。

mixed block记录最早可准入事实。single只等指定账号；sticky仍遵守primary/overflow；pipeline/cache在同组选择可准入账号。普通错误/请求日志只保存`blockedBy`枚举和bounded retryAfter。

同一账号Provider retry若permit不可用立即停止后续attempt并返回local 429 + Retry-After，不重新分配`concurrencyWaitMs`，避免重试数线性放大延迟。该local block不创建upstream attempt/error rule/account replacement；此前真实失败attempt保留其upstream status/error row，请求row使用`errorCategory=rpm`并可保留最后真实`upstreamStatus`作为历史事实。只有现有明确account removal outcome可以首包前换号。

## 5. 动态池交互

选择聚合区分all-concurrency、rpm、mixed：grow要求所有当前active hard-eligible候选都有有限maxConcurrent且全部concurrency-full，等待deadline后仍成立，并存在eligible standby且target<max。任何RPM block、mixed block或unlimited-concurrency candidate均不grow。

## 6. 调用覆盖

所有绑定持久账号的shared native chat transport调用都必须由permit broker保护：三个chat aliases、`/api/test`、`/api/probe`、`/api/validate-upstreams`、`/api/accounts/test`和`/api/accounts/proxy-test`。validate并发batch共享一个lease但每个native call原子claim独立permit。models/catalog、usage-limits quota refresh及不发chat的管理请求不计。`/api/accounts/test`若无有效持久accountId而只测试临时credential，因没有maxRpm owner而明确不计；不能冒充已限流。

## 7. API/UI/诊断

GET accounts可投影`rpm:{limit,used,reserved,retryAt}`，只含数字/null。账号抽屉、批量/预设/raw scheduling和`collectAccounts()`保留字段。服务端始终权威；前端只做范围反馈。

## 8. 失败与回滚

permit bookkeeping异常fail closed到该账号但不能泄漏activeCount/reservation；release幂等。`maxRpm=0`即时关闭限制并清理无用state。回滚旧版本前备份包含新字段的config；本任务不部署。
