# 技术设计：低额度热池与刷新冷却

## 1. 前置owner

本任务建立在`09-20-dynamic-cache-pool-growth`提供的min/max/persisted target上，并读取`09-21-account-rpm-limits`的结构化可准入结果。它只扩展现有`cachePoolMembership()`、`acquireCachePoolAccountLease()`、quota job reconciliation和`META.accountStates`，不建成员表、冷却map或第二queue。

## 2. 配置与target

`accountPipeline` canonical新增：

```js
{
  cachePoolSize,        // min total
  cachePoolMaxSize,     // max total
  cachePoolLowQuotaSize // fixed low target
}
```

strict要求`0 <= low <= size <= max <= 100000`。启动legacy max缺失用size、low缺失用0；旧客户端POST省略max/low时保留当前server值，显式0才关闭对应能力。size=0时low必须0；正数preset默认low=1。metadata只保存grow-only total target；有效target clamp到min/max。low target固定为`min(low,target)`，grow增加high目标。

## 3. 额度角色和成员派生

从同一fresh snapshot计算`used=max(five_hour,weekly,monthly)`与`remaining=100-used`：

- high/hot: used<80；
- low/warm: 80<=used<95；
- reserve: used>=95；
- unknown: incomplete/stale/error。

low=0时直接调用既有dynamic baseline membership，不执行额度角色排序。low>0时选择L个low：remaining升序（越少越优先），再priority/id；选择H=T-L个high：remaining降序（保留最高额度），再priority/id。缺槽时从未选known high/low按稳定规则补位，unknown永远最后；API投影actual role而非谎称目标满足。账号success rate不改变membership。

## 4. 选择顺序

role-aware启用时active candidates分成low-drain、high-reserve、unknown-filler。先对low执行现有health/sticky/mode排序并尝试结构化lease；任何high可准入时不等待low的并发/RPM，立即fallback high，再尝试unknown。low=0完全使用baseline选择，不产生role优先。

仅当所有active均为有限并发且并发已满时，进入既有wait/grow流程。若存在并发容量但被RPM挡住，返回RPM block，不grow。role作为lease snapshot传入attempt settlement，避免途中quota refresh改变本请求归属。

## 5. quota hold状态

扩展`META.accountStates[id]`为正交维度，不能由rule cooldown过期清理整对象：

```js
{
  ...ruleDisposition,
  quotaDisposition: null | 'waiting-refresh' | 'quota-exhausted',
  quotaDispositionAt,
  quotaRetryAt,
  quotaReason: bounded enum
}
```

`enabledAccounts()`排除两种canonical quota disposition；quota job仍从config账号取凭据，所以可以刷新。API/UI/spec只使用`waiting-refresh`和`quota-exhausted`，不维护别名。

仅low lease且最终canonical policy为`account/degrade`时设置`waiting-refresh`，并额外返回request-local `quotaRemovalAction`供`handleChat()`复用现有首包前最多一次replacement；现有degrade本身不会换号，不能声称直接复用。post-start只影响未来候选。显式account cooldown/hard quarantine只保留rule disposition，不同时创建quota hold；provider-model/ignore/cancel不设置。

## 6. 刷新协调

现有quota scheduler继续唯一owner：

- waiting-refresh使账号在下一scheduler周期要求一次真实fetch，绕过最近成功cache但不绕过dedupe/global cap/failure backoff；
- refresh失败/unknown保留hold并走现有bounded backoff；
- role-aware启用时，对每次最新成功snapshot独立评估所有已知有效window；任一>=100即`quota-exhausted`，即使partial且此前未hold；
- `quotaRetryAt`取已耗尽窗口中最早有效未来`resetsAt`，到时刷新再评估；若另一个窗口仍100%则继续并计算下一次；
- 只有成功snapshot的三个窗口齐全、均<100且成功时间不早于disposition，才清除waiting-refresh或quota-exhausted；部分非100成功仍属unknown并保留原disposition，部分已知100成功确认/保持exhausted；
- 没有有效resetsAt时按现有failure/success周期重试，不永久定时器泄漏。

人工recover只字段级清rule cooldown/quarantine，不绕过quota-exhausted；force quota refresh可提前重新判断但仍遵守failure backoff，且只有真实成功snapshot能清除。账号key替换/删除清理旧quota state。`clearExpiredCooldowns()`、`persistAccountAction()`和quota reconciliation都必须字段级merge/clear，禁止删除另一维度。

## 7. API/UI/日志

GET accounts投影role、target/actual composition、`quotaDisposition/retryAt`。UI分别显示人工禁用、规则冷却、硬隔离、等待刷新、额度耗尽。普通日志只记bounded selected role、fallback reason和state enum，不写percent/resets payload。

## 8. 兼容与回滚

low=0恢复旧membership；max=min关闭grow。metadata新状态对旧二进制未知，因此生产回滚必须恢复备份。本任务不部署。
