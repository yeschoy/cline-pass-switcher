# 技术设计：动态缓存热池与会话命中优先

## 1. Owner

扩展现有 `accountPipeline` normalizer、`cachePoolMembership()`、`acquireCachePoolAccountLease()`、capacity waiter、request identity和`META` target normalization；不增加第二账号选择器、队列或成员表。

本设计拥有总池min/max/persisted target、concurrency-only grow-one和唯一process-local session binding map。关联后续任务 `../09-21-low-quota-pool-refresh-cooling/` 只能在同一 `cachePoolMembership()`/binding invalidation seam内增加high/low role composition，不能复制target、成员表、waiter、binding map或扩容器。

## 2. Static and dynamic state

`cachePoolSize`=min，`cachePoolMaxSize`=max，严格要求`0 <= min <= max <= 100000`；legacy missing max uses min。有效池条件仍是sticky mode或explicit sticky。

metadata保存`{ cachePoolTargetSize }`（必要时带bounded updatedAt/reason），有效target=`clamp(stored,min,max)`。operator显式save负责clamp/reset；自动路径只允许+1。成员每次由target、priority、stable ID和资格派生，不持久化IDs。

`accountPipeline`新增严格有界字段：

```js
{
  sessionBindingExplicitTtlMs: 7_200_000,   // 2h sliding
  sessionBindingFallbackTtlMs: 900_000,     // 15m sliding
  sessionBindingMaxEntries: 50_000
}
```

建议范围：两个TTL均为整数60,000–604,800,000 ms，fallback不得大于explicit；max entries为1–100,000。旧持久配置缺失时使用默认；旧客户端save遗漏时保留当前服务端值。关闭组合行为可关闭healthSort或sticky，不需要把容量设为0。

## 3. Binding owner and identity

`sessionBindings`是进程级bounded `Map<fingerprint, entry>`，仅在sticky effective且healthSort=true时读取/写入。fingerprint复用`extractSessionIdentity()`已生成的HMAC，不保存raw session/message。Entry仅含：

```js
{ accountId, source: "explicit" | "fallback", expiresAt, lastUsedAt,
  state: "provisional" | "confirmed", generation, ownerRequestId }
```

Explicit confidence使用2h滑动TTL；message_hmac/fallback使用15m。命中时delete+set刷新Map顺序及TTL；插入前lazy清过期，超过50,000逐个删除最旧。不得新增周期timer。重启自然清空。

只有已取得真实account lease的miss请求能写provisional entry。native chat attempt在`req.end()`后通过现有attempt commit seam确认entry；未产生attempt的取消/本地失败仅在owner+generation仍匹配时删除。并发同session可读取provisional entry，避免首次并发散到不同账号。Account replacement在替代lease准备真实attempt时以新generation更新；旧finalizer无法回滚。

## 4. Conditional pipeline

编译后的选择流不是简单三项线性排序：

```text
hard eligibility / active membership / reserve fence
  -> sticky+health binding gate
       hit: bound account
       miss: quotaPool + healthSort miss pipeline (relative order preserved)
  -> mode/tie rank
  -> capacity wait / grow / temporary overflow
```

开关矩阵：

- sticky off + healthSort off：legacy selection；
- sticky off + healthSort on：每请求healthSort，无binding；
- sticky on + healthSort off：现有无状态HRW，无binding；
- sticky on + healthSort on：stateful hit-first/miss-health behavior。

Sticky effective包括`accountMode=sticky`或pipeline sticky=true。组合模式下sticky是前置条件门，不参与miss stages的线性位置；现有`order`中删除sticky后，quotaPool与healthSort保持相对顺序。UI应分开展示“会话命中条件门”和“未命中调度步骤”，避免继续声称sticky位置是普通排序优先级。Persisted三键order继续接受并round-trip，避免破坏旧配置。

Hit validation只允许当前active、hard eligible、非reserve/exhausted的account。Success rate变化以及quota hot/warm/unknown不使binding失效。无缓存池时，所有hard/quota eligible账号视为active候选。

## 5. Capacity, overflow and growth

Binding hit账号有容量即lease；满载则只等待该账号至existing wait deadline。超时后在其它active执行miss pipeline获得temporary overflow，entry不改绑；下次仍尝试原账号。若bound账号hard-invalid或退出active，删除entry并按miss处理。

Miss计算active(target)。基础成员按hard eligibility、非reserve、priority、stable ID派生；后续quota-role任务可先按角色派生并以priority/ID tie-break，但仍读取同一target。Miss pipeline按配置中quotaPool/healthSort相对顺序细分，rate已知降序、unknown最后、tie保持prior order；显式identity可在最终tie内用HRW稳定选择。

所有active满载：等待existing waitMs，capacity notice后完整重算。deadline后仍满载且target<max：同步grow-one、persist、重算active、lease新成员，并为miss session建立binding。若未grow的standby只用于现有兼容temporary overflow，则不得绑定；本任务目标是以正式grow/replace替代永久standby承载。

`maxConcurrent=0`意味着不满载。多个timeout回调串行读取最新target并重算；第一个grow后后续先看到新容量，不能盲增。

## 6. Invalidation and related state

Binding lookup及相关mutation复用一个失效函数。以下条件删除对应entry或使lookup miss：account deletion/disable、key或proxy identity rotation、cooldown、hard quarantine、manual removal、退出active membership、quota reserve或未来确认exhausted、TTL/LRU eviction。

Provider失败、普通请求失败、success rate波动、quota hot/warm/unknown、临时capacity overflow不改绑定。Account-scoped replacement更新绑定。Manual recover不会复活旧entry；下一请求重新miss。

后续low-quota任务必须调用同一invalidate seam；不得建立quota binding表。Config save可按account generation批量失效，不扫描/输出fingerprint。

## 7. API/UI/logs

GET accounts投影min/max/target、active/standby role和binding安全摘要`{ enabled,size,maxEntries }`，不列entry。POST strict roundtrip新pipeline字段；older omission保留。UI增加max/TTL/maxEntries输入、current target/binding size只读状态，拆分conditional gate与miss pipeline帮助文案，更新raw editor/presets。

Request diagnostics只允许：

```js
bindingSource: "explicit" | "fallback" | "none"
bindingResult: "hit" | "miss" | "invalidated" | "temporary-overflow" | "provisional" | "not-applicable"
```

可增加bounded fixed aggregate counters，但不得记录fingerprint、hash prefix、session值、entry account map、候选列表、健康桶或credentials。账号选择本来已有selected/preferred account投影，不新增identity关联字段。

## 8. Rollback

配置上设置max=min关闭自动扩容；关闭healthSort或sticky恢复旧非binding组合语义。Session map只在内存，代码回滚/重启即清空。旧版本回滚必须带回旧config/metadata备份，避免unknown config字段丢失；不得尝试迁移或持久化binding entries。
