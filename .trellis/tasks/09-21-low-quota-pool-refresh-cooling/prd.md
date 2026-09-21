# 低额度热池调度与刷新冷却

## Goal

在保留高额度兜底和动态池容量的同时，优先消耗少量低额度账号，并让账号级失败通过额度刷新驱动的冷却/耗尽状态快速退出与自动恢复。

## Background

父任务：`../09-21-upstream-diagnostics-account-limits-pool-keepalive/`。前置依赖：`../09-21-account-rpm-limits/`与既有`../09-20-dynamic-cache-pool-growth/`。本任务不重复实现target/grow owner。

## Requirements

1. 保留`cachePoolSize`最小总池、`cachePoolMaxSize`上限和metadata target；新增`cachePoolLowQuotaSize`，要求`0 <= low <= size <= max`。
2. 旧配置缺失low为0；旧客户端POST省略max/low时按当前server值保留。size=0的新安装保持low=0；只有operator设置正数池或启用对应预设时建议/写入low=1。动态扩容只增加高额度目标，low槽保持固定。
3. `cachePoolLowQuotaSize=0`完全关闭role-aware membership/selection并沿用既有non-reserve + priority/id基线。low>0时复用现有fresh complete quota snapshot：hot(<80% used)=high；warm(80%..<95%)=low；reserve(>=95%)排除；unknown保持未知。
4. low>0时membership不持久化ID：low按最少剩余额度优先、再priority/id；high按最多剩余额度保留、再priority/id；组成不足时从剩余known high/low稳定补位，unknown永远最后，并投影实际high/low/unknown数量，不把filler伪装成目标角色。
5. quota role优先于healthSort/sticky：low可准入时优先承接；low受并发、RPM或状态阻塞而high可用时立即high fallback，不等待low恢复。health/sticky只在同role内排序。
6. RPM阻塞不是动态grow信号；只有既有“全部active有限并发满载、等待后仍满”才能grow-one。
7. lease快照携带角色。仅low角色上最终canonical policy为`scope=account, action=degrade`时，设置持久化`waiting-refresh`并产生独立request-local account removal outcome；provider-model、explicit ignore和client cancel不升级账号。显式account cooldown/hard-quarantine只执行规则动作，不额外设置quota hold。
8. waiting-refresh不使用固定时长，并绕过最近成功cache以要求下一调度周期进行一次真实quota fetch，同时继续遵守全局两槽、dedupe和failure backoff。成功且没有已知100%窗口则清除；失败/unknown保持。
9. role-aware pool启用时，最新成功snapshot任一已知有效window为100%即设置`quota-exhausted`，即使snapshot partial或账号此前没有chat failure；失败不会解除已确认耗尽。它不改operator enabled、不冒充hard quarantine；到最早已耗尽窗口的有效未来`resetsAt`后刷新，只有全部已知窗口<100%才清除，否则重新计算。
10. quota job继续能刷新被hold/exhausted账号，复用现有global queue、backoff、generation和routing epoch，不建第二scheduler。
11. API/UI/log显示目标与实际组成、role、hold/exhausted/next refresh等安全事实，不显示raw quota payload、候选列表或凭据。

## Acceptance Criteria

- [ ] config/API/UI严格验证并完整往返min/max/low/target；启动missing、旧客户端省略、显式0、size0新安装和正数preset各有确定测试，low=0成员/选择与既有基线一致。
- [ ] 79.999/80/94.999/95/100边界、known zero与unknown语义通过。
- [ ] 活跃池满足可用候选范围内的high/low目标，动态grow只增加high目标且target跨重启不缩。
- [ ] low>0且任一low可准入时每次确定性选择low；low并发/RPM/hold阻塞且high可用时立即high fallback；known补位优先于unknown且实际组成如实投影。
- [ ] RPM-only不grow；并发竞争不超max且无double lease。
- [ ] low account/degrade产生独立removal outcome并可首包前最多换号一次；显式account rule disposition、provider failure/ignore/cancel不误设quota hold，post-start只影响未来请求。
- [ ] waiting-refresh真实fetch、success/failed/unknown、partial snapshot 100%、多个耗尽reset、无有效reset、manual recover和resetsAt自动恢复均有确定状态/持久化测试。
- [ ] quota jobs、stream/cancel、statistics与ordinary日志安全边界保持。
- [ ] focused、UI、integration和完整gate通过。

## Out of Scope

- 主动消耗reserve(>=95%)账号。
- 自动缩容。
- 第二额度刷新队列或外部状态服务。
- Provider重试策略变更。
- 生产部署。
