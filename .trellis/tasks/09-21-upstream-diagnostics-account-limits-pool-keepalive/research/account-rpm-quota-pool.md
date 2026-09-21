# 账号 RPM、额度热池与错误冷却研究

## 最终决策状态（后续用户评审已覆盖早期推荐）

本文件保留初始代码证据和候选方案；以下最终合同以父/子PRD与design为准，并覆盖本文后面的早期“推荐/待确认”：

- RPM按每个实际调用`req.end()`的Cline Chat HTTP attempt计数，Provider retry分别计数；不是一次lease只计1次。
- 使用单进程滚动60秒窗口，重启清空、多副本独立。
- Provider retry无permit时立即local 429，不等待、不换号；此前真实attempt保留。
- `cachePoolLowQuotaSize=0`完整保留legacy membership；正数时low确定性优先，known filler优先于unknown。
- low角色仅在最终`account/degrade`时进入`waiting-refresh`，不使用固定cooldown；显式cooldown/hard-quarantine不叠加hold。
- 任一最新成功snapshot的已知窗口100%（含partial）进入`quota-exhausted`，按reset刷新并自动恢复，不写`enabled=false`。

## 结论摘要

1. 当前账号准入只有 `maxConcurrent`：`tryLease()` 同步检查并发、增加 `activeCounts`，`release()` 幂等减计数并唤醒同一个 `waiters` 集合。不存在账号 RPM 状态或等待语义。
2. RPM 的最小一致实现应直接扩展现有 `tryLease()` / `acquireAccountLease()` owner，而不是建立第二个限流队列：先检查并发，再检查/消费 RPM；只有成功获得 lease 才记一次 RPM，RPM 不随 `release()` 返还。
3. 推荐 RPM 使用进程内、每账号精确滚动 60 秒时间戳队列。它天然有界于 operator 配置的 RPM，失败/取消仍计数，Provider 重试不重复计数，换号时每个新账号各计一次；重启清空是明确的 fail-open 语义，避免每请求同步写 `metadata.json`。
4. 当前额度层按 `hot -> warm -> unknown -> reserve` 选择，倾向消耗高余额账号；缓存池 membership 只排除 `reserve` 后按 `priority + id` 取固定数量。这与“保留高额度、尽量先消耗低额度”相反。
5. 推荐复用现有 quota snapshot、`cachePoolMembership()`、`buildPipelineGroups()` 和 `acquireCachePoolAccountLease()`，将活跃池划成少量“低额度消耗槽”和其余“高额度兜底槽”；请求先尝试低额度槽，高额度槽立即作为可用性回退，不为低额度账号额外等待。
6. 低额度账号的“立即冷却”不能另建 pool-local blacklist。应写入现有 `META.accountStates` 并沿用现有 account cooldown、首包前最多换号一次、流开始后只影响未来请求的契约。
7. `09-20-dynamic-cache-pool-growth` 尚未实现（task status=`planning`，当前 `HEAD` 仍只有 `cachePoolSize`）。其 `cachePoolMaxSize`、metadata target、并发满载后 grow-one、复用 waiter 的设计可直接复用；但其“membership 只按 priority/id、排除 reserve”需要先与本任务的高/低额度组成合并，不能按原设计独立落地后再叠第二层调度。

## 已验证的当前契约

### 1. 配置、API 和 UI

| 边界 | 当前事实 | 证据 |
|---|---|---|
| 账号 schema | `normalizeAccount()` 持久化 `id/name/note/key/enabled/maxConcurrent/weight/priority/proxyUrl/headers/perModel`；没有 RPM 字段。`maxConcurrent` 非严格启动规范化为非负整数。 | `server.js:480-498` |
| API 严格校验 | `POST /api/accounts` 对 `maxConcurrent` 要求整数 `0..100000`，完整列表保存后重建账号；RPM 不存在。 | `server.js:3270-3334` |
| API 投影 | `GET /api/accounts` 通过 `{ ...a }` 投影持久账号字段，并附加 `state/activeCount/health/quota/cachePoolRole/statistics`。 | `server.js:3258-3269` |
| 浏览器 owner | `ACCS` 是账号草稿 owner；`collectAccounts()` 明确 allowlist 重建每个账号，若不加入新字段会在任意完整保存时丢失。 | `public/index.html:997-1131` |
| UI 草稿路径 | 批量并发、抽屉、预设、raw scheduling 和普通保存共用 `ACCS`；`account-draft.test.js` 已覆盖重绘、stale raw editor、成功 reload 和完整字段往返。 | `test/account-draft.test.js:1-438` |
| 文档 | README/config example 只描述 `maxConcurrent` 和 `{ quotaPool, healthSort,sticky,order,cachePoolSize }`。 | `README.md:99-107,185-191`; `config.example.json:10-53` |

兼容注意：新 RPM 字段若在旧客户端完整保存中缺失，服务端 normalization 应按稳定 `id` 从 previous account 保留，而不是默认为 0；否则旧客户端会静默关闭已配置限流。启动读取旧配置时缺失才默认 0。

### 2. 并发、lease 和调用范围

- `accountHasCapacity()` 只检查 `maxConcurrent`；`tryLease()` 在同一个同步调用栈内检查并增加 `activeCounts`，lease 的 `release()` 幂等减计数并调用 `notifyCapacityWaiters()`（`server.js:856-879`）。Node 事件循环下该同步临界段已是账号准入的原子 owner。
- `waitForCapacity()` 使用一个全局 `waiters: Set` 加定时器；`waitForLease()` 循环重试并在每次唤醒后重新检查（`server.js:817-900`）。不需要为 RPM 增加第二个等待队列。
- `tryLease()` 的调用覆盖：legacy/pipeline/cache-pool 选择、显式 management account、`/api/probe`、model test 和 `/api/validate-upstreams`（`server.js:937-1167,3105-3142,3394-3407`）。
- `catalog()` 使用 `pickAccount()`，`/api/accounts/test` 和 quota refresh 也不经 lease；因此当前 `maxConcurrent` 本来就不覆盖这些路径（`server.js:1151-1167,2014-2180,3048-3052,3358+`）。最小 RPM 应先与 lease scope 完全一致，不能声称限制所有账号上游 HTTP attempts。
- 账号先 lease，随后同一账号内可有多个 Provider attempts；只有显式 account cooldown/hard-quarantine 可在首包前释放 A 并最多 lease B 一次（`server.js:2725-2945`）。
- 非流、异常、流完成及客户端取消均有 release 路径；现有集成测试断言 `activeCount` 最终归零且 started SSE 不重放（`test/integration.test.js:499-554,1240+`；spec `quality-guidelines.md:91-108,176-179`）。

### 3. quotaPool 和 cachePool

- `quotaProjection()` 只在快照完整、最新、无失败且 15 分钟内时分类：三个窗口的最大 `percentUsed < 80` 为 `hot`，`<95` 为 `warm`，否则 `reserve`；不完整/过期/失败为 `unknown`（`server.js:981-988`）。因此：
  - 已知 0% 使用量是 `hot`，不是 unknown；
  - 已知 100% 使用量是 `reserve`；
  - unknown 与数值零已经有正确的不同语义。
- `buildPipelineGroups()` 的 quota 顺序固定为 `hot, warm, unknown, reserve`，所以启用额度层时优先消耗剩余最多的账号（`server.js:997-1028`）。
- cache pool 仅在 `cachePoolSize > 0` 且 sticky mode/step 生效；membership 排除 `reserve`，再按 `priority + stable id` 取前 `size`，不按额度高低或成功率决定成员（`server.js:977-980,1030-1039`）。
- 活跃池全部无容量时等待 `concurrencyWaitMs`；超时后 `tryCachePoolStandbyLease()` 对一个 standby 做一次性溢出，不改变池大小（`server.js:1067-1103`）。
- 当前测试覆盖固定池配置迁移、old-client preservation、休眠模式、priority/id 稳定成员、reserve 替换、hard fallback、等待后 standby overflow、429 与 lease release（`test/integration.test.js:1250-1415`）。

### 4. 账号错误和冷却

- `matchErrorRule()` 首条命中；默认仅把明确账号 auth/quota/proxy 失败归为 account `degrade`，明确具名 Provider 失败归为 provider-model `degrade`，默认不会冷却（`server.js:2615-2647`；spec `quality-guidelines.md:105-108`）。
- `persistAccountAction()` 只持久化 account `cooldown`/`hard-quarantine` 到 `META.accountStates`，失败 fail-open；`enabledAccounts()` 会立即跳过该状态（`server.js:840-858,2649-2656`）。
- account cooldown 在首包前终止当前 Provider chain、释放 lease、最多换号一次；流开始后的动作只影响未来请求（`server.js:2725-2945`）。
- 账号 24h health 的失败样本仅来自 account-scope `degrade`；cooldown/hard-quarantine 本身不计 degrade（`server.js:1611-1645`; spec `quality-guidelines.md:187-189`）。

## 推荐的账号级 RPM 设计

### 1. Canonical 字段

推荐账号字段：

```json
{
  "maxRequestsPerMinute": 0
}
```

- 整数 `0..100000`；`0` 表示不限，与 `maxConcurrent: 0` 一致。
- 若更偏好短字段名，可选 `maxRpm`，但应只选一个 canonical 名称，不同时维护两个别名。
- startup：旧配置缺失时规范化为 0。
- `POST /api/accounts`：提交字段时严格校验；稳定 ID 的旧客户端省略字段时保留 previous 值。
- `GET /api/accounts`、config file、浏览器 `ACCS`、抽屉、`collectAccounts()`、新增账号默认值、UI tests、README/config example 全部完整往返。

### 2. 运行时 owner 和状态

直接在 `server.js` 的 lease owner 旁增加一个 Map，不新增 scheduler/queue/store：

```text
rpmWindows: Map<accountId, { timestamps: number[], head: number }>
```

- 每次检查先删除 `<= now - 60_000` 的已准入时间戳；必要时压缩数组。
- `timestamps.length - head < current maxRequestsPerMinute` 才可准入。
- 状态最多保存该账号过去一分钟成功准入的 `limit` 个时间戳；operator 配置是内存上界。
- 删除账号或替换 key 时清理该 ID 的 RPM state；仅修改限额时保留仍在窗口内的事实并按新 limit 判断，避免通过调高/调低配置意外重置历史。
- disable/re-enable 建议保留最近 60 秒窗口；凭据身份未变，不应通过短暂 disable 绕过 RPM。

不建议首版用固定自然分钟窗口：边界前后可瞬间放行约 `2 * RPM`。不建议把每次 admission 同步持久化到 metadata：会把每请求变成原子 JSON 重写，违背本任务日志/请求关键路径性能目标。

### 3. 明确的准入顺序

每次候选重算按以下顺序：

```text
hard eligibility
  -> maxConcurrent capacity partition
  -> maxRequestsPerMinute rolling-window check
  -> 同步提交 RPM timestamp + activeCounts increment
  -> return idempotent lease
```

原子点应保留在一个同步 helper 内。可以把 `tryLease()` 改为返回结构化结果：

```js
{ lease, blockedBy: null }
{ lease: null, blockedBy: 'concurrency', retryAt: null }
{ lease: null, blockedBy: 'rpm', retryAt: oldestTimestamp + 60_000 }
```

这样所有 legacy/pipeline/cache/management callers 都能共享相同顺序和安全诊断，不需 side channel。

“并发优先于 RPM”的可执行含义：

1. 并发已满时不读取、更不消费该账号 RPM；测试可通过“释放并发后仍有完整 RPM 余量”证明。
2. 动态 cache pool 扩容只看“所有 active 都是有限并发且已满”，绝不能由 RPM 耗尽触发。
3. 若至少一个 active 有并发容量、但这些账号均 RPM 耗尽，则结果是 RPM unavailable，不得误判为并发满载并 grow pool。
4. 候选 A 并发满/RPM 有余量、候选 B 并发可用/RPM 可用时，只能选择 B。

### 4. 计数、释放和请求生命周期

推荐定义为“一次成功账号 lease admission”，而不是一次 Provider HTTP attempt：

| 场景 | RPM | 并发 |
|---|---:|---:|
| 输入/鉴权/模型校验在 lease 前失败 | 不计 | 不占 |
| lease 成功，随后无可用 Provider | 计 1 | 终态释放 |
| 同账号 Provider retry N 次 | 共计 1 | 始终同一 lease |
| A account action 后首包前换 B | A 计 1，B 计 1 | A 释放后 B 获取 |
| 上游错误/超时 | 计 1 | 终态释放 |
| 客户端取消 | 计 1 | 幂等释放 |
| streaming 整个生命周期 | 计 1 | `[DONE]`/error/downstream close 后释放 |
| RPM 检查失败 | 不计 | 不增加 activeCount |
| lease `release()` | 不返还 RPM | 返还并发并通知 waiter |

这与现有“两级路由”和 lease 生命周期最一致，也不会因 Provider 数量不同使账号 RPM 语义漂移。若产品实际要限制“发往 Cline 的每个 HTTP attempt”，则 owner 应在 `clineRequest()` 前而不是 lease；这会同时涉及 Provider retry、quota、catalog/test 等路径，明显不是最小变更，需要另行确认。

### 5. 等待和 Retry-After

复用现有 `waiters`：

- release 仍通过 `notifyCapacityWaiters()` 提前唤醒；
- RPM 没有 release event，等待时把 timer 设为 `min(selection deadline, earliest RPM retryAt)`；醒来后完整重算 hard eligibility、membership、capacity 和 RPM；
- 不增加 per-account timer、排队器或后台 refill job；没有流量时不做任何工作；
- `concurrencyWaitMs` 继续作为一次账号准入的总等待上限。首版不再增加 `rpmWaitMs`；如果最早 RPM 恢复晚于 deadline，立即/到期返回 429；
- 429 `Retry-After`：纯 RPM 阻塞用最早 `retryAt` 向上取整；纯并发阻塞沿用 bounded wait 值；mixed 使用能使任一候选最早可重试的安全上界，并在普通日志只投影枚举 `blockedBy`，不写 session、候选表或凭据。

账号 mode 语义应保持：single 只等指定账号；sticky 仍先遵循其 primary 的既有 bounded wait/overflow规则；其他 mode 在排名候选中跳过 RPM 已满账号，只有全体不可准入才等待。低额度池的可用高额度账号存在时，不为低额度 RPM 恢复等待，直接回退高额度账号。

### 6. 重启语义

推荐首版明确为进程内 soft state：

- 正常重启后 RPM 窗口为空，最多产生一次重启后的额外 burst；
- 不从 ordinary logs/statistics 推断窗口，也不写 metadata；
- 多进程/多副本时每进程独立，配置 RPM 不是全局分布式硬上限。

原因：项目当前是单 Node 进程且没有共享状态服务；持久化精确滑窗会把同步存储引入请求热路径。若用户要求“跨重启/多副本绝对不超限”，需单独决定 durable/external limiter，这会扩大架构范围。

## 推荐的高/低额度热池方案

### 1. 额度定义

复用当前 fresh complete quota snapshot，定义保守可用余额：

```text
remainingPercent = 100 - max(
  five_hour.percentUsed,
  weekly.percentUsed,
  monthly.percentUsed
)
```

沿用现有边界，避免第二套 quota normalization：

| 类别 | 当前 pool | remaining | 用途 |
|---|---|---:|---|
| 高额度 | `hot` | `> 20%`（当前代码等价于 max used `< 80`） | 兜底容量 |
| 低额度 | `warm` | `> 5%` 且 `<= 20%`（used `80.. <95`） | 优先消耗 |
| 保护/近耗尽 | `reserve` | `<= 5%`（used `>=95`） | 正常 membership 排除；仅按明确 emergency contract 处理 |
| 未知 | `unknown` | null | 不得当作 0 或高额度；只作组成不足时的可用性 filler |

边界是否包含 20%/5%应沿用现有代码的 `<80/<95` 精确行为，测试写 79.999/80/94.999/95。已知 0 与 unknown 必须分别测试。

### 2. 最小配置扩展

为最大复用 09-20 动态池，推荐保留：

```json
{
  "cachePoolSize": 4,
  "cachePoolMaxSize": 8,
  "cachePoolLowQuotaSize": 1
}
```

语义：

- `cachePoolSize` / metadata target / `cachePoolMaxSize` 仍是**总活跃池** min/current/max；
- `cachePoolLowQuotaSize` 是 target 内最多保留的低额度消耗槽；
- 高额度目标数为 `target - lowQuotaSize`；例如总池 4、低槽 1，即“3 个高额度 + 1 个低额度”；
- strict validation：`0 <= lowQuotaSize <= cachePoolSize <= cachePoolMaxSize <= 100000`；legacy missing max=`size`，missing low=`0`；
- 动态 grow-one 增加总 target，低槽保持固定，因此新增容量默认成为高额度兜底槽。

此方案只新增一个“低额度槽数”，比同时新增 high/low 两个 size 更少，也保留 09-20 的 total target owner。UI 应把 `cachePoolSize` 改写为“最小总活跃账号数”，显示当前 target/max/低额度槽/实际组成。

### 3. Membership 算法

仍由一个 `cachePoolMembership(list,candidates)` 派生，不持久化成员 ID：

1. hard filter：key/enabled、ban/hard quarantine、有效 account cooldown、request exclude。
2. quota 分类：fresh known high/low/reserve 与 unknown；reserve 不进入常规候选。
3. 计算 `T=effective target`、`L=min(configured low slots,T)`、`H=T-L`。
4. 低额度成员：low 中按 `remainingPercent ASC -> priority ASC -> id ASC` 取 L，优先选择最接近耗尽但尚未 reserve 的账号。
5. 高额度成员：high 中按 `remainingPercent DESC -> priority ASC -> id ASC` 取 H，保留额度最高的兜底账号。
6. 类别不足时，用未入选的 non-reserve 候选补满 T；unknown 只能作为显式标注的 filler，不可伪装为高/低。实际投影应给出 `actualHigh/actualLow/actualUnknown`，不能声称目标已满足。
7. 成功率不参与 membership；`healthSort` 只在已选成员的同一 quota role 内排序。
8. hard state、quota reserve、disable 会立即触发派生成员替换，不降低 persisted target。

注意：按余额排序会在 quota refresh 后改变成员，这是“优先低余额/保留最高余额”的必然后果，与旧 09-20 “完全按 priority/id 保持 membership”存在真实冲突。若缓存粘性稳定比额度最优更重要，可改成“只按 high/low band 分类，band 内 priority/id”；该选择需用户确认。

### 4. 请求选择算法

在 `acquireCachePoolAccountLease()` 内复用现有 plan/lease/wait owner：

```text
active low drain tier
  -> active high reserve tier
  -> active unknown/filler tier
  -> wait only when no active account is admissible
  -> concurrency-only dynamic grow-one (09-20)
  -> safe 429 when max/no candidate
```

- 低额度 tier 中按现有 pipeline 的 health/sticky/mode 细分；高额度同理。
- 只要高额度 tier 当前可准入，就不等待低额度账号的并发或 RPM；立即回退高额度，保证可用性。
- 因而在低额度账号可用时分配概率接近 100%，被并发/RPM/冷却挡住时降为 0，统计上天然显著偏向低额度。
- 不建议另加随机权重：已有 mode、HRW、success sort 和 quota grouping，额外概率 owner 会让行为难解释且难测试。
- reserve 是否保留当前“active 为空时立即 standby emergency fallback”需要明确；若保留，必须标记 `emergency-reserve`，不能算低额度常规槽。

### 5. 低额度错误立即冷却

不建立第二个 cooldown map。建议：

1. selection/lease 携带 request-local bounded quota role（`low/high/unknown/emergency-reserve`），避免请求中途 quota refresh 改写归属。
2. attempt 失败仍先走现有 classification + ordered `errorRules`。
3. 仅当该 lease role=`low` 且结果是 **account-scope degrade** 时，保留原 `policy=degrade` 作为 health sample，同时额外生成 scheduler account action=`cooldown`，通过 `persistAccountAction()` 写现有 `META.accountStates`。
4. 显式 `ignore` 不得被低额度策略覆盖；provider-model degrade 不冷却账号，否则会把共享 Provider 故障错误扩大到 credential scope；显式 cooldown/hard-quarantine 继续按规则原语义执行。
5. synthetic cooldown 立即停止当前账号 chain，并复用首包前最多一次换号；若流已开始，只影响未来请求，不重放。
6. synthetic cooldown 失败仍 fail-open；普通日志只记录安全枚举原因，例如 `low-quota-health-failure`，不记录 quota payload/Header/body。

需要新增一个严格有界 duration 配置（建议 `cachePoolLowQuotaCooldownMs`，`0` 可关闭，正值 `1..30d`），或者明确要求 operator 必须用现有 errorRules 配置 cooldown。前者才能保证“默认立即冷却”，但会修改当前“默认 degrade 永不隐式 cooldown”的 spec；后者保持现契约，却无法无配置满足 AC5。

## 与 09-20 任务的复用和冲突

### 当前状态

- `09-20-scoped-error-rules-success-rate` 已完成并归档；对应 commit `cb19f2e`，统一规则、account/provider state、成功率和三步 pipeline 已在当前 `main`。
- `09-20-dynamic-cache-pool-growth` 的 `task.json` 仍为 `planning`；implementation checklist 全未完成。当前 `server.js` 无 `cachePoolMaxSize` 或 `cachePoolTargetSize`。
- `09-20-provider-success-retry-selection` 与父任务也仍为 `planning`；当前 Provider attempts 仍由 `buildProviderAttempts()` 预先按 source order 构建（`server.js:2372-2434`）。这不影响本研究的账号 lease 设计，但实现时共享 `server.js/public/index.html`，不能并行改同一区域。

### 可直接复用

- `cachePoolMaxSize` strict config、legacy max=size。
- metadata 单一 `cachePoolTargetSize`，不持久化成员 ID。
- all active finite-and-full -> wait -> recheck -> sync grow-one -> recompute -> lease。
- Node 同步 compare/increment、防并发超 max、复用 `waiters` 和 quota jobs/routing epoch。
- target 跨重启、压力下降不缩容、operator clamp、hard-state replacement。
- GET/API/UI/log 的 min/max/target/role 安全投影与相关测试骨架。

### 必须先修订的冲突

1. 09-20 规定 membership 只按 `priority + id`；新需求需要 high/low composition，且可能按 remaining 排序。两者不能同时为真。
2. 09-20 把 reserve 一律排除；新需求若把“低额度”解释为现有 reserve，则完全无可选低账号。推荐 low=warm、reserve 仍保护；若用户要消耗到 0，必须改 reserve contract。
3. 09-20 target 是总池大小；若本任务把现有 `cachePoolSize` 重新解释为“高额度 n”，会破坏其 metadata/API/UI 设计。推荐维持总池语义，用 `cachePoolLowQuotaSize` 推导高额度数量。
4. 09-20 grow trigger 必须继续只由并发满载触发；RPM exhaustion 不可触发 grow，否则违反“并发优先”和旧任务 AC。
5. 09-20 删除一次性 standby overflow；本任务的 high fallback 是活跃池内部 tier fallback，不应重新引入另一种 standby promotion owner。
6. 当前 quota pipeline 是 high-first；若只改 membership 不改 selection，低额度账号不会被优先消耗。必须在同一个 cache-pool acquisition owner 内明确 low-first。

建议把 09-20 dynamic task 的未实现设计并入/作为 09-21 的实现前置，不要先按原 membership 设计实现后再二次重构。

## 需要用户确认的最小决策

1. **RPM 计数单位**：推荐“一次成功 lease admission”；是否实际要求每个上游 HTTP attempt（包括 Provider retry/quota/catalog/test）都计数？后者范围显著更大。
2. **RPM 重启/多副本**：是否接受进程重启清空、每进程独立？推荐接受；否则需要 durable/external limiter。
3. **低额度定义**：推荐复用 warm（任一限制已用 80%–<95%，即最小剩余 >5%–<=20%），reserve >=95% 继续保护。是否要把 reserve 也作为优先消耗对象？
4. **池大小配置**：推荐 `cachePoolSize/maxSize` 保持总池，新增 `cachePoolLowQuotaSize`；用户提供的“n 个高额度”由 `target-low` 推导。是否认可？
5. **成员稳定性 vs 余额最优**：band 内按余额排序会提高“先耗低/保留最高”的效果但增加 quota refresh 后的粘性变化；是否改为 band 内仅 priority/id？
6. **低额度冷却触发**：推荐只对 account-scope degrade，显式 ignore 和 provider-model error 不触发。是否“一旦发生错误”意指任何 Provider/5xx 也冷却账号？后者会违反现有错误归属边界。
7. **低额度 cooldown 时长**：需要默认值/配置。建议配置 `cachePoolLowQuotaCooldownMs`，默认 60 秒（或 0 表示必须依赖 errorRules）；需产品确认。
8. **reserve emergency fallback**：当前 active 为空时可立即使用 reserve standby。新热池下是继续 fail-open，还是宁可 429 也不碰近耗尽账号？

## 实现触点（不新增 owner）

### Backend `server.js`

- account field：`DEFAULT_CONFIG` comment、`normalizeAccount()`、startup migration、`POST /api/accounts` validation/preservation。
- RPM runtime：`activeCounts/waiters` 邻近状态、`tryLease()`、`waitForLease()`、legacy/pipeline/cache acquisition、forced management callers、save/delete/key-change cleanup。
- quota composition：`quotaProjection()` 增加安全 remaining projection（保留 null/0）、`cachePoolMembership()`、`cachePoolRoles()`、`cachePipelineFacts()`、`acquireCachePoolAccountLease()`。
- dynamic pool：按 09-20 复用 `normalizeAccountPipeline()`、metadata normalization、target grow/clamp、save behavior。
- cooldown：`settleAttempt()` / `persistAccountAction()` / `handleChat()` 现有 account replacement path；不要新增 pool cooldown map。
- diagnostics：扩展已有 enum allowlist，投影 `blockedBy`、quota role、pool target/composition；普通日志不写滑窗 timestamps/count明细、候选列表或 quota raw payload。

### Frontend `public/index.html`

- 账号抽屉增加 RPM 输入；`drawerValue/open/save`、`addAccountRow()`、`collectAccounts()` 完整保留。
- scheduling owner 增加 max/low/cooldown fields；同步 visual control、raw editor exact shape、presets、stale snapshot 检查和 server reload。
- 运行列可显示 `RPM limit / recent admitted` 的安全投影，但 current count 是 soft state，不能冒充持久统计。
- cache role 应区分 low-drain/high-reserve/unknown-filler/standby，所有 server-controlled 文本继续 escape。

### Tests

重点新增/改写：

1. config/API/UI/restart：missing=0、边界 0/100000、非法/partial/unknown 不写文件、旧客户端省略保留、完整 browser draft round-trip。
2. precedence：并发满但 RPM 有余量不消费 RPM；释放并发后可按完整 RPM 准入；有并发容量但 RPM 满时跳过该账号。
3. lifecycle：success/error/cancel/SSE release activeCount；RPM 不返还；Provider retries 只计一次；换号 A/B 各一次；RPM reject 不占 lease。
4. timing：60 秒 prune、精确 Retry-After、等待在 release 或最早 RPM expiry 唤醒、deadline 不自旋；restart reset 明示测试。
5. caller scope：chat/probe/validate/model-test 与 catalog/account-test/quota 的期望边界被显式断言，避免误报“全上游 RPM”。
6. composition：79.999/80/94.999/95、known zero/unknown；H/L/unknown shortage、priority/id tie、success rate 不改变 membership。
7. low bias：足够样本下 low 可用时全部或显著多数命中 low；low 并发/RPM 满时立即 high fallback。
8. low cooldown：account degrade 立即写现有 state、后续跳过并首包前换高账号；explicit ignore、provider-model degrade、unknown quota、client cancel 不误冷却；stream started 不重放。
9. dynamic interaction：只有 all-active concurrency full 才 grow；RPM-only exhaustion 不 grow；并发竞争最多 grow-one；target/restart/no-shrink 和 role composition一致。
10. 更新现有 fixed-pool standby-overflow tests，因为 09-20 设计会删除该语义；保留 ordinary log/session/key absence断言。

## 风险提示

- 不能把 RPM count 写进现有统计 minute buckets后再拿它做 admission：统计 finalizer 在请求终态执行，无法原子阻止并发准入，且 cancel/失败时序不合适。
- 不能用 quota refresh 的 `rate_limit` errorCategory 代替聊天账号 RPM；前者是 quota job backoff，owner 和含义不同。
- 不能把低额度 Provider 故障默认升级为 account cooldown；这会破坏已完成的 scope attribution contract。
- 不能让 RPM exhaustion 触发 09-20 动态扩容；否则通过加账号绕过 operator 对单账号的速率保护，并与“concurrency first”冲突。
- 不能在 UI table cells 重建账号对象；新字段必须从 `ACCS` snapshot/drawer/collect owner 全链路保留。
