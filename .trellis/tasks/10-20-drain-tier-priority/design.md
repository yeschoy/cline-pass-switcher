# Design — drain 档

## 配置契约（`accountPipeline` 新字段）

> 位置决策：旧镜像 `normalizeConfigAndMeta` 对 `accountWorkflow` 调用会抛 unknown field（启动失败），对 `accountPipeline` 走非 strict 路径静默丢弃未知字段。新镜像首次启动会把默认值写回 config.json，因此新字段必须放在 `accountPipeline`，镜像回退才安全，且不需要 schema-changing（stop-first）部署。

| 字段 | 类型 | 默认 | 校验 |
|---|---|---|---|
| `drainEnabled` | boolean | `false` | 必须 boolean |
| `drainThreshold` | number（百分比） | `95` | 有限数，`80 < x < 100` |
| `drainMaxConcurrent` | integer | `2` | `1 ≤ x ≤ 100000` |

- `normalizeAccountPipeline`（server.js）新增 `drainEnabled`/`drainThreshold`/`drainMaxConcurrent`/`warmThreshold`，加入 `allowed` 列表；非 strict 缺省补默认，strict 校验类型与范围；前端 accountPipeline 草稿同步。
- 生效条件 helper：`drainActive(policy = config.accountWorkflow, pipeline = config.accountPipeline)` = `policy.enabled && pipeline.drainEnabled`。Workflow 请求快照已含 `pipeline`，选号时用快照值。

## 额度投影（server.js `quotaProjection`）

```
max < warm                  → hot       warm  = accountPipeline.warmThreshold ?? 80
max < upper                 → warm      upper = drainActive ? drainThreshold : 95
drainActive && max < 100    → drain
otherwise                   → reserve
```

- drain 关闭时 upper=95、无 drain 分支 → 与现状逐字等价。
- `quotaProjection` 读取 live `config.accountWorkflow`（与 cachePool 配置一样不走请求快照；配置保存是原子替换，差异只存在于保存瞬间）。
- `lease.quotaRole` 映射：`drain → 'low'`（与 warm 同语义：账号级 degrade 时进入 waiting-refresh，等待额度确认）。
- **该保护不依赖 `cachePoolLowQuotaSize`**：现有 `selectionResult` 仅在 `lowSize > 0` 时设置 quotaRole，`enabledAccounts` 仅在 `lowSize > 0` 时剔除 `quotaDisposition`，`reconcileQuotaDisposition` 的 100% → `quota-exhausted` 同理。drain 档启用时，这三处对 drain 号也要生效（条件改为 `lowSize > 0 || drainActive()`），否则 `lowSize=0` 时 drain 号会失去 waiting-refresh / exhausted 保护。
  - 实现前需确认放宽条件对非 drain 号的影响：只对 drain 号放宽，或整体放宽（后者会让 `lowSize=0 + drain 开启` 时普通号也获得 exhausted 剔除——这是更安全的方向，但属于行为变化，需在 PRD 写明）。默认选择：**只对 drain 号放宽**。

### warmThreshold 校验

- `normalizeAccountPipeline`（server.js）新增字段，缺省 80；strict 模式下要求有限数且 `0 < x < 95`。
- 跨字段约束在保存时检查（`applyAccountConfig` 前的校验处）：drain 启用时要求 `warmThreshold < drainThreshold`，否则返回 400。
- 前端：缓存池设置区新增输入；`#cachePoolHelp` 与 README 中硬编码的 80%/95% 改为引用当前值或描述为"可配置分界"。

## 有效并发

新增 `effectiveMaxConcurrent(account)`：
- 非 drain：`account.maxConcurrent`（0 = 不限）。
- drain：`account.maxConcurrent ? Math.min(account.maxConcurrent, cap) : cap`。

替换所有直接读 `maxConcurrent` 做并发判定的位置：
- `accountHasCapacity`（server.js:1737）
- `poolWaitBudget` 的 `a.maxConcurrent > 0`（server.js:807）
- `growCachePoolOne` 的 `!account.maxConcurrent`（server.js:2076）
- 账号列表/统计投影中展示的并发上限（新增 `effectiveMaxConcurrent` 字段，不覆盖原配置值）。

性能：`accountHasCapacity` 是热路径，drain 判定需要 `quotaProjection`。drain 关闭时短路（不调用投影）；开启时只对 58 级别账号做 O(1) 计算，可接受。

## 缓存池成员（`cachePoolMembership`）

- 剔除条件仍为 `pool !== 'reserve'`，drain 自然入池。
- 排序：drain 号放在最前（保证进入 active），其后保持原有 low/high/unknown 逻辑；`actual` 计数新增 `drain` 字段。
- Pipeline 的 `buildPipelineGroups` quota 分组列表加入 `'drain'`（防御：drain 只在 workflow 下出现，但避免候选被意外丢弃）；`PIPELINE_QUOTA_POOLS` 加入 `'drain'`。

## Workflow 选号（`tryWorkflowSelection` / `workflowFilteredCandidates`）

- quota 过滤：`policy.quotaPools.includes(pool) || pool === 'drain'`。
- capacity 后、selector 前新增 tier 划分：`drainTier = available.filter(pool==='drain')`，`rest = 其余`；按 `[...workflowRank(drainTier), ...workflowRank(rest)]` 顺序尝试 lease。
- trace 新增节点 `{ node: 'drain', before: available.length, after: drainTier.length, result: drainActive ? 'prioritized' : 'disabled' }`（仅 drainActive 时追加，保证 decision nodes ≤ 8：现有最多 binding+eligibility+cache+quota+health+capacity+selector+lease=8 → 需要把 drain 合入 capacity 节点的扩展字段 `drain: n`，而不是新增节点）。
  - 结论：不新增节点，`capacity` 节点增加可选字段 `drainAfter`；`projectWorkflowDiagnostics` 白名单透传该字段。
- 绑定命中路径不改（Requirement 5）。
- `previewAccountWorkflow` 用同一 tier 顺序预测；预测用的 drain 判定与 live 一致。

## roundrobin → LRU（lib/account-workflow.js `rankWorkflowCandidates`）

- `selector === 'roundrobin'`：比较键 `lastSelected(left) - lastSelected(right)`，并列回退到稳定 id 顺序；不再参与 `cursor` 旋转（`cursor` 参数保留给其他 selector 的并列打破）。
- `lastSelected` 来源同 `counts`（`META.selectionCounters.accounts`），缺省 0；非法行抛错与现有 count 校验一致。
- 复杂度：排序仍是 O(n log n)（复用现有排序框架，n≈40 时可忽略）；需要时 `tryWorkflowSelection` 只需第一个可 lease 的候选，不做额外优化。
- drain tier：两档分别调用 `workflowRank`，天然各自 LRU。
- `recordWorkflowSelection` 已在每次新选号时写 `lastSelected = ++sequence`，无需新增状态或持久化格式变化。
- 测试：`test/account-workflow.test.js` 现有 `roundrobin, cursor: 1 → 'b'` 断言需改为 LRU 语义。

## 前端（public/index.html）

- `WORKFLOW_SELECTOR_LABELS.roundrobin` 改为「轮询：最久未选优先」，决策结果文案 `roundrobin` 同步。
- 工作流面板 quota 节点下新增：drain 开关、阈值（%）、并发上限输入。
- 账号状态徽章：drain 号显示「drain·并发N」。
- 决策节点渲染 capacity 的 `drainAfter`。

## 兼容与回滚

- 默认关闭 → 升级零行为变化；回滚 = 控制台关闭开关，或直接回退镜像（旧版本启动时丢弃 accountPipeline 未知字段，drain/warm 设置随之失效，回到 80%/95% 硬编码行为）。
