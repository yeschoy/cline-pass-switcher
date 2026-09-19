# 缓存热池只扩不缩动态扩容

## Goal

在现有缓存活跃池 owner 内增加由真实容量饱和触发的、逐步且跨重启保持的动态扩容，同时保持旧配置不自动扩容、成员稳定、会话粘性和 lease 安全。

## Background

父任务：`../09-20-scoped-error-rules-dynamic-routing/`。依赖 `09-20-scoped-error-rules-success-rate` 已提供三步账号流水线、账号 hard state 和成功率投影。

## Requirements

1. `cachePoolSize` 是初始/最小大小；新增 `cachePoolMaxSize`。旧配置默认 max=size，升级行为不变。
2. metadata 持久化当前 grow-only target size，不持久化第二份成员列表，也不自动回写 operator config。
3. 只有当前 active 全部具有有限 `maxConcurrent` 且满载，等待 `concurrencyWaitMs` 后重算仍满载，才可扩一个账号；unlimited 账号不触发。
4. target 每次至多加一且不超过 max；并发超时请求不能竞争扩过上限。
5. 新成员按 hard eligibility、非 reserve、priority、stable ID 选择，先正式入 active 再 lease；不再是一次性 standby overflow。
6. 并发下降不自动缩容。operator 显式修改 min/max/关闭可 clamp；硬状态退出由合格成员替换但 target 不降。
7. 账号成功率不改变 membership。启用 healthSort 时只排序当前 active；sticky 在同 rate 内稳定选择。扩容/替换仍按 priority/ID。
8. 复用 quota refresh owner、capacity waiter、tryLease/release 和 routing epoch；不得增加第二队列。
9. API/UI/日志安全投影 min/max/target/role/expanded reason，不投影候选列表、session、credentials 或 health buckets。

## Acceptance Criteria

- [ ] 缺失 max 的旧配置启动/save/restart 均保持 max=size且不扩容；非法/partial/unknown 输入在写前400。
- [ ] 全 active 满载、等待、重算、grow-one、lease 的时序确定；一个 active 有容量时不扩。
- [ ] 并发触发最多增长到配置上限，无双 lease/泄漏，stream/error/cancel 后计数归零。
- [ ] target 跨重启保持且压力下降不缩小；operator clamp、hard replacement、reserve、disable/cooldown/quarantine 正确。
- [ ] membership 不受成功率波动影响；healthSort 只排序 active 候选。
- [ ] UI/raw scheduling/presets/full save 保留 min/max 和隐藏账号字段；诊断无敏感值。
- [ ] 聚焦测试、全量项目门禁与相关 spec/docs 更新通过。

## Out of Scope

- 自动缩容或时间/利用率预测扩容。
- 修改 Provider 路由。
- 生产部署。
