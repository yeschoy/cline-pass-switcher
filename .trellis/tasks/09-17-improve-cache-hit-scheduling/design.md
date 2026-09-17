# 缓存命中优先调度：技术设计

## 1. 范围与设计原则

本任务只修改 `cline-pass-switcher`。NewAPI 只提供只读链路证据，不修改；CPA 完全不参与。

实现复用现有账号配置、HRW 粘性、priority、健康/额度投影、容量租约、普通日志和账号管理 API，不新增依赖、模块、第二套账号存储或持久化会话表。

核心机制是：在现有 eligibility 之上形成一个稳定的“小活跃池”，正常请求只在活跃池中做 HRW；备用账号只在硬状态替换或容量等待超时后使用。默认关闭，旧行为保持不变。

## 2. 配置契约

扩展现有 `accountPipeline`：

```js
accountPipeline: {
  quotaPool: boolean,
  excludeUnhealthy: boolean,
  healthSort: boolean,
  sticky: boolean,
  order: ["excludeUnhealthy", "quotaPool", "healthSort", "sticky"],
  cachePoolSize: integer // 0..100000；0 = 关闭，推荐值 2
}
```

选择该位置而不是增加第五个可排序步骤：

- 活跃池是 sticky 的候选范围，不是另一个独立排序算法；
- 保留现有四步顺序及全部 24 种排列，避免扩大迁移与 UI 复杂度；
- `0` 可直接恢复旧行为和旧生产配置。

兼容规则：

- 启动时缺失/非法 `cachePoolSize` 规范化为 `0`；
- `GET /api/accounts` 始终返回规范化整数；
- 新客户端提交完整字段；
- 老客户端提交四个布尔值并省略 `cachePoolSize` 时，服务器保留当前值，避免旧页面静默关闭策略；
- 显式值必须是 0–100000 的整数，未知字段仍拒绝；
- `cachePoolSize > 0` 仅在 sticky 模式或显式 sticky 流水线生效。控制台明确提示该条件；默认/预设使用 sticky 模式。

`pipelineEnabled()` 必须把**有效**缓存池（`cachePoolSize > 0` 且 sticky 模式或显式 sticky 步骤）视为启用，确保四个布尔值全关但策略有效时仍进入现有 pipeline owner；正数池值配置在非 sticky 模式且未启用 sticky 步骤时保持休眠，不进入 pipeline owner。缓存活跃池需要识别 fresh reserve，因此额度刷新所有权复用现有 quota job/pump，并由统一的 `quotaRoutingEnabled()`（`quotaPool || cachePoolEnabled()`）控制；模式或 sticky 步骤使池失效时必须推进 routing epoch 并撤销该来源。不得新增刷新队列或在聊天路径发起额度请求。

`concurrencyWaitMs` 继续作为唯一容量等待配置；“缓存命中优先”预设将其设为 5000 ms，不增加第二个等待字段。

## 3. 活跃池选择

### 3.1 基础资格

先复用 `enabledAccounts()` 排除：

- 无 Key；
- disabled；
- banned；
- 未过期 cooldown；
- 本次换号明确排除的账号。

在这些账号上复用 `healthProjection()` 和 `quotaProjection()`。活跃池额外排除：

- `health.status === "unhealthy"`；
- `quota.pool === "reserve"`。

以下状态不触发活跃池重排：

- health 为 `available`、`insufficient` 或 `degraded`；
- quota 为 `hot`、`warm` 或 `unknown`。

这样满足“只在明确不健康或 reserve 时替换”，避免 80% hot/warm 边界、样本分数或短暂额度不可观测造成频繁缓存冷启动。未知数据不会被伪造成健康或额度充足；它只保持已有 priority 决策，并继续由现有普通诊断显示 unknown。

### 3.2 稳定排序

合格账号按以下顺序选前 `cachePoolSize` 个：

1. `priority` 数值升序；
2. 稳定账号 `id` 字典序。

不使用名称、Key、瞬时 activeCount、额度百分比或健康分数做并列排序。账号重命名、流量变化和进程重启不改变结果。

其余基础资格账号为 standby。若合格账号少于目标池大小，活跃池允许缩小；reserve/unhealthy 账号仍只能作为可用性兜底，不能被伪装成正常活跃成员。

## 4. 与流水线和 HRW 的组合

`buildPipelineGroups()` 仍先构造账号的健康/额度事实并执行现有四步流水线。有效 sticky 应用时：

1. 计算固定 priority 活跃 ID 集；
2. 将仍存在于流水线候选中的活跃账号提升为 `cacheTier=active`；
3. 在活跃账号内部用现有 `hrwRank(identity.fingerprint)` 排序；
4. 备用账号保留既有流水线相对层级，并标记 `cacheTier=standby`；
5. 无身份时仍只在 active 中使用现有无身份策略，standby 不参与正常分配。

同一身份、同一活跃账号集合和同一 routingSecret 的结果保持稳定。配置从 6 个账号首次收缩到 2 个时必然产生一次冷启动；后续只有硬状态变化才替换。

当 `cachePoolSize === 0` 时，不执行任何分区，直接走现有路径。该分支必须通过六种模式的等价回归测试。

## 5. 容量、等待与备用溢出

启用缓存活跃池后：

1. 按 HRW/当前模式尝试有容量的 active 账号；
2. 若首选满载但另一个 active 有容量，可在 active 内临时溢出，并记录首选不一致；
3. 仅当至少存在 active 且全部 active 都满载时，使用现有 waiter 等待 `concurrencyWaitMs`；容量通知后重新计算资格和活跃池；
4. 若 hard state 使 active 数量为 0，则不进行容量等待，立即尝试安全 standby；否则等待超时后，若 `allowOverflow` 为真，才尝试 standby；
5. standby 成功记录 `cache-pool-standby-overflow`；没有 standby 或 `allowOverflow=false` 时保持现有 429；基础资格账号为空时保持现有 503。

活跃账号的禁用/封禁/冷却/明确不健康/reserve 不是容量溢出：下一 priority 账号在下一次重算时成为 active。当前生产 `maxConcurrent=0`，因此单纯启用新策略不会制造等待或降低吞吐。

租约仍由 `tryLease()`/`release()` 唯一所有；流式完成、取消、错误和换号路径不新增第二套释放逻辑。

## 6. API、UI 与持久化数据流

```text
public/index.html 草稿
  -> accountPipeline.cachePoolSize
  -> POST /api/accounts 严格校验
  -> normalizeAccountPipeline()
  -> atomic saveConfig()
  -> GET /api/accounts 重新加载
  -> buildPipelineGroups()/acquirePipelineAccountLease()
```

控制台增加：

- “缓存活跃池账号数”数字输入，`0` 表示关闭；
- 帮助文本：仅在 sticky 生效、priority 越小越优先、reserve/unhealthy 自动替换；
- “缓存命中优先”预设：sticky、活跃池 2、等待 5000 ms，并在预览中允许检查/编辑账号 priority；
- 账号表的安全运行态标签 `缓存活跃` / `缓存备用`（不显示 ID、会话或候选详情）；
- 原始调度 JSON 增加 `accountPipeline.cachePoolSize`，仍由同一页面草稿所有。

预设可修改的字段扩展为 `cachePoolSize`；仍不得修改名称、Key、enabled、代理、Headers、模型路由或流水线四个开关。取消预览不改变草稿或服务器。

## 7. 诊断契约

复用现有 request JSONL，增加安全字段：

```js
cachePoolSize: integer,
cachePoolTier: null | "active" | "standby",
cachePoolFallback: boolean
```

选择原因使用稳定枚举：

- `cache-pool-active`；
- `cache-pool-active-overflow`；
- `cache-pool-standby-overflow`。

现有 `overflow`/`capacityFallback` 继续反映首选与容量回退。日志不得增加候选账号列表、原始会话值、HMAC 指纹、消息、Key、代理或 Header 值。

`GET /api/accounts` 可给每个认证管理账号增加运行时 `cachePoolRole: "active" | "standby" | null`，只用于控制台状态投影，不持久化、不回传到完整账号保存对象。

## 8. 失败、兼容与回滚

- 配置字段默认 0；部署新代码但不改配置时行为不变。
- 非法管理输入在任何内存/文件变更前返回 400。
- 旧客户端省略字段时保留当前值；省略整个 pipeline 仍保留完整当前对象。
- 运行时健康/额度未知不触发重排；明确 hard state 才替换。
- 日志写入失败保持既有 fail-open 语义，不改变模型响应。
- 配置级回滚：将 `cachePoolSize` 设回 0，并恢复原 `concurrencyWaitMs`/priority；不需要迁移或删除元数据。
- 代码级回滚：当前旧版本的启动规范化会丢弃未知 pipeline 字段，因此生产回滚必须同时恢复发布前的 config 备份，不能依赖旧代码保留 `cachePoolSize`。此次任务不执行部署。

## 9. 验证矩阵

### 自动化

- 缺失字段迁移为 0；新值保存/重启 round trip；旧客户端省略时保留；非法/未知值 400 且文件字节不变。
- 有效的 `cachePoolSize > 0` 在四开关全关时仍走 pipeline owner，并复用 quota routing epoch、单账号 job 与全局两槽泵；非 sticky 模式且无 sticky 步骤时保持休眠，模式/步骤关闭后只撤销 routing 来源且不影响页面刷新所有者。
- `cachePoolSize=0` 对六种模式、全部四步顺序及容量语义保持等价。
- priority 前两名成为 active；输入顺序变化不改变 priority/id 并列结果。
- hot↔warm、available↔degraded、quota unknown 不换池；disabled/ban/cooldown/unhealthy/reserve 确定性补位。
- 同一 Session/message HMAC 在稳定 active 集合中命中同一账号；standby 在正常容量下为 0 次。
- 两个 active 有容量时只在 active；一个满载可在 active 内回退；两个满载等待；超时后 standby；hard state 导致零 active 时立即 standby；无 standby 返回 429；所有 lease 回到 0。
- request 日志含安全枚举/数值且不含原始身份或秘密。
- UI 完整草稿、原始 JSON、预设 preview/cancel/apply、筛选/抽屉/批量并发保存均保留字段和隐藏账号数据。

### 后续生产试运行（不在本轮执行）

- 配置变更前保存当前 24 小时基线与配置哈希；自然预热阶段单独报告。
- 预热后观察 24 小时且至少 1,000 个明确 cache 样本。
- 成功：请求命中率 ≥70%。
- 护栏：Token 占比下降 ≤3 个百分点、最终失败率上升 ≤1 个百分点、P95 延迟恶化 ≤20%、standby 溢出率 <1%、active 不进入 reserve/持续不健康。
- 任一护栏失败，立即把 `cachePoolSize` 恢复为 0 并恢复旧 priority/wait；不自动缩成单账号池。
