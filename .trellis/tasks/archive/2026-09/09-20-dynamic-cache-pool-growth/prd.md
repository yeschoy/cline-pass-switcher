# 缓存热池动态扩容与会话命中优先

## Goal

在现有缓存活跃池 owner 内交付两项共享同一membership/lease边界的能力：由真实容量饱和触发、跨重启保持的grow-only动态扩容；以及 sticky+healthSort 同时启用时“已有会话绑定优先，只有miss才按账号成功率选择”的有界会话绑定。保持旧单独开关语义、成员稳定、quota/hard state安全和lease exactly-once。

## Background

父任务：`../09-20-scoped-error-rules-dynamic-routing/`。依赖 `09-20-scoped-error-rules-success-rate` 已提供三步账号流水线、账号 hard state 和成功率投影。

当前缓存池有效时，active membership按priority/ID派生，普通请求在active内按HRW sticky选择；`healthSort`虽显示在可排序流水线并已可配置，但active主路径不消费其分组，只在部分standby路径体现。另一方面，现有sticky是无状态HRW，没有“新会话/已绑定会话”表；若直接把HRW结果视为hit，则首次出现的会话也永远是hit，healthSort无法只服务新会话。

用户确认新增仅内存的bounded session binding：显式Codex/Claude/session身份使用2小时滑动TTL，`message_hmac` fallback使用15分钟滑动TTL；sticky+healthSort组合下，绑定hit短路健康排序，miss只在active内按成功率选择后建立绑定。满载只临时溢出不改绑，soft quota与成功率变化不迁移老会话，reserve/exhausted和hard invalidation才重绑。

后续关联任务：`../09-21-low-quota-pool-refresh-cooling/` 将在本任务的 min/max/persisted target owner 上增加 high/low quota role composition。为避免重复 target、成员表、绑定表或扩容器，本任务建立总池target、并发grow-one和唯一session binding owner；后续任务只能扩展同一membership资格/角色判断。

## Requirements

1. `cachePoolSize` 是初始/最小大小；新增 `cachePoolMaxSize`。旧配置默认 max=size，升级行为不自动扩容。
2. metadata 持久化当前 grow-only target size，不持久化第二份成员列表，也不自动回写operator config。
3. 只有当前active全部具有有限`maxConcurrent`且满载，等待`concurrencyWaitMs`后重算仍满载，才可扩一个账号；unlimited账号不触发。
4. target每次至多加一且不超过max；并发超时请求不能竞争扩过上限。
5. 本任务的基础成员按hard eligibility、非reserve、priority、stable ID选择，先正式入active再lease；不再是一次性standby永久承载。后续high/low quota composition复用同一membership owner。
6. 并发下降不自动缩容。operator显式修改min/max/关闭可clamp；硬状态退出由合格成员替换但target不降。
7. 账号成功率永不改变membership。无session binding时healthSort只排序当前active；sticky+healthSort组合时，binding hit短路healthSort，miss才按配置中quotaPool/healthSort的相对顺序处理active候选，并在同率层使用稳定tie-break。standby必须正式晋升/替换后才能建立绑定。
8. sticky单独启用时保持现有无状态HRW（Codex/Claude/session key及message_hmac）；healthSort单独启用时每次排序且不建表。仅当sticky有效（accountMode=sticky或pipeline sticky）且healthSort=true时启用新的stateful binding。
9. binding map只保存在进程内，键为已有HMAC fingerprint，不保存raw session/message。显式身份滑动TTL=2h，fallback message_hmac滑动TTL=15m；最大50,000条，Map/LRU淘汰，重启清空，不写metadata/API明细或日志身份值。
10. 新会话miss取得真实lease后、首个native attempt前建立带owner/generation的provisional binding；attempt commit后确认。无真实attempt的取消/失败只能删除仍属于该owner的provisional entry，旧请求不能覆盖/删除新binding。同session并发请求可命中provisional entry。
11. binding账号仅并发满载时先等现有waitMs，超时后在其他active中按miss路径临时溢出，但不改绑；下次请求仍回原账号。Provider级失败/普通失败不改绑，account removal成功替换后更新binding。
12. success rate变化及quota hot/warm/unknown不迁移binding；账号删除、禁用、key/proxy identity变化、cooldown、hard quarantine、退出active、quota reserve或确认exhausted时binding失效，后续miss重新选择。后续quota任务必须复用该invalidate seam。
13. active全满的miss仍遵守动态扩容：等待、重算、必要时grow-one并正式晋升后，才可把新会话绑定到新增active。无eligible standby或达到max时返回现有capacity错误。
14. 复用quota refresh owner、capacity waiter、tryLease/release、routing epoch和identity fingerprint；不得新增第二账号选择器、成员表、队列或持久session store。
15. API/UI完整round-trip min/max、TTL/maxEntries及条件流水线语义；旧客户端遗漏新字段时保留服务端值。日志/API只投影bounded `bindingSource=explicit|fallback|none`、`bindingResult=hit|miss|invalidated|temporary-overflow|provisional`及安全计数，不投影fingerprint、候选列表、session、credentials或health buckets。

## Acceptance Criteria

- [ ] 缺失max的旧配置启动/save/restart均保持max=size且不扩容；非法/partial/unknown输入在写前400。
- [ ] 全active满载、等待、重算、grow-one、lease的时序确定；一个active有容量时不扩。
- [ ] 并发触发最多增长到配置上限，无双lease/泄漏，stream/error/cancel后计数归零。
- [ ] target跨重启保持且压力下降不缩小；operator clamp、hard replacement、reserve、disable/cooldown/quarantine正确。
- [ ] sticky-only继续用无状态HRW且跨进程重启稳定；healthSort-only每次排序；两者组合时同session首请求miss并按active成功率选号，后续hit不因rate变化迁移。
- [ ] 显式2h、fallback15m滑动TTL、50,000 LRU、重启清空、provisional并发命中和generation防旧finalizer覆盖均确定；无raw/HMAC identity投影。
- [ ] 绑定账号满载只临时溢出不改绑；hard/reserve/exhausted/退出active会失效并在新账号实际可用后重绑。
- [ ] membership不受成功率波动影响；healthSort只处理miss active候选；standby必须grow/replace后才能建立binding。
- [ ] UI把“会话命中条件门”和“miss流水线”解释清楚，不继续把sticky位置误导为普通线性排序；raw scheduling/presets/full save保留全部新旧字段和隐藏账号字段。
- [ ] 聚焦测试、全量项目门禁与相关spec/docs更新通过。

## Out of Scope

- high/low额度槽组成、低额度优先与刷新驱动冷却（由`09-21-low-quota-pool-refresh-cooling`实现）。
- 持久化session→account映射、跨进程共享、原始session存储或管理API列出映射。
- 依据当前请求的`cached_tokens`决定当前选号（该值只能在响应后获得）。
- 自动缩容或时间/利用率预测扩容。
- 修改Provider路由或NewAPI会话字段转换。
- 生产部署。
