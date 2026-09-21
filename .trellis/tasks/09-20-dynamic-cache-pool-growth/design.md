# 技术设计：动态缓存热池扩容

## 1. Owner

扩展现有 `accountPipeline` normalizer、`cachePoolMembership()`、`acquireCachePoolAccountLease()`、capacity waiter和`META` normalization；不增加队列或成员表。

本设计拥有总池 min/max/persisted target 与 concurrency-only grow-one。关联后续任务 `../09-21-low-quota-pool-refresh-cooling/` 只能在同一 `cachePoolMembership()` 内增加 high/low role composition和角色内选择，不能复制 target、成员表、waiter或扩容器。

## 2. Static and dynamic state

`cachePoolSize`=min，`cachePoolMaxSize`=max，严格要求 `0 <= min <= max <= 100000`；legacy missing max uses min。有效池条件仍是 sticky mode或explicit sticky。

metadata保存 `{ cachePoolTargetSize }`（必要时带bounded updatedAt/reason），有效 target=`clamp(stored,min,max)`。operator显式save负责clamp/reset；自动路径只允许+1。成员每次由target、priority、stable ID和资格派生，不持久化IDs。

## 3. Selection algorithm

Normal path计算active(target)。本任务基线按hard eligibility、非reserve、priority、stable ID派生成员；账号success rate不参与membership。后续quota-role任务可先按high/low角色派生并以priority/ID作tie-break，但仍读取同一target。若healthSort启用，在active同role内部先rate降序，再让后续sticky仅处理同rate tie。无identity仍复用当前mode rank within active。

所有active满载：等待existing waitMs，收到capacity notice后完整重算。deadline后仍满载且target<max：同步grow-one、persist、重算active、lease新成员。若无eligible standby或已达max，保持safe capacity error；不再做一次性standby overflow。

`maxConcurrent=0`意味着不满载。多个timeout回调串行读取最新target并重算；第一个grow后后续应先看到新容量，不能盲增。

## 4. Eligibility and quota

复用enabled/key/ban/cooldown/quarantine hard filter，再排quota reserve。Success rate绝不做hard filter。Quota routing继续使用shared jobs/global pump/routing epoch。hard loss替换成员但target不降。high/low额度阈值、优先消耗、quota hold/exhausted状态属于关联后续任务，不在本任务建立临时实现。

## 5. API/UI/logs

GET accounts投影min/max/target和active/standby role；POST strict roundtrip。UI增加max input、current target只读状态、updated help/raw editor/presets。Diagnostics增加bounded target/max/expanded reason，删除/兼容旧standby-overflow wording时同步日志测试。

## 6. Rollback

配置上设置max=min即可关闭自动扩容；size=0关闭池。旧版本回滚必须带回旧config/metadata备份，避免unknown field丢失。
