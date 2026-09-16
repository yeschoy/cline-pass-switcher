# 可排序账号流水线 — 技术设计

## 1. 边界与目标

只扩展现有 `accountPipeline`、候选组计划和账号管理草稿，不新增调度器、账号存储或第三方拖拽依赖。强制资格过滤和最终 `accountMode` 不进入可拖动列表；供应商重试、账号租约、流式不可重放和最多一次账号替换保持原所有权。

## 2. 配置契约与迁移

配置扩展为：

```js
accountPipeline: {
  quotaPool: boolean,
  excludeUnhealthy: boolean,
  healthSort: boolean,
  sticky: boolean,
  order: [
    "excludeUnhealthy",
    "quotaPool",
    "healthSort",
    "sticky"
  ]
}
```

`order` 永远包含四个唯一合法 ID，即使某步骤关闭也保留其位置。启动读取旧配置时，缺失或无效顺序归一为上述默认顺序并沿用现有规范化保存流程。

管理 API 对显式 `order` 做精确排列校验。为兼容旧客户端，显式提交四个布尔值但省略 `order` 时，以当前服务端顺序作为回退；显式非法顺序返回 400，任何配置均不写入。新版 UI 始终提交完整顺序。

四项布尔值全为 false 时，`order` 不参与选号，继续调用原 legacy selector。

## 3. 有序候选组模型

流水线计划从一个组开始：

```js
[{ accounts: eligibleAccounts, quota: "ordinary", health: "ordinary" }]
```

按照 `order` 依次处理启用步骤。每个排序步骤只稳定细分当前组，已有组之间的顺序不可被后续步骤跨越，因此越靠前优先级越高。

### 3.1 `excludeUnhealthy`

从所有当前组中删除已评分 `unhealthy`，保留组顺序和组内顺序。若至少存在一个非 unhealthy 候选，空组被移除并记录 `health-filtered`。若全部候选均为 unhealthy，只从当前第一个非空组恢复该组最高健康分并列账号，记录 `health-filter-fallback`；这在默认首位时等价于现有全局最高分回退，在其他位置时不越过前置优先级。

### 3.2 `quotaPool`

只要全体候选中存在一个新鲜已知额度，就将每个现有组稳定拆成 `hot → warm → unknown → reserve` 子组。若全部未知则保持组不变并记录 `quota-all-unknown`。额度刷新仍完全独立，选号只读取快照。

### 3.3 `healthSort`

将每个现有组稳定拆成 `available-or-insufficient → degraded → unhealthy` 子组。前置额度组或 sticky 组之间的优先级不改变。

### 3.4 `sticky`

有 fingerprint 时，将每个现有组按 HRW 排名拆成单账号组；后续步骤只能为这些单账号组补充分层元数据，不能覆盖已形成的粘性优先级。无 fingerprint 时不拆组，最终模式保持现有 round-robin fallback。

当 `accountMode=sticky` 且 sticky 开关关闭、但其他流水线步骤开启时，在配置步骤之后隐式执行一次 sticky，以保持现有兼容语义。开关开启时只在配置位置执行一次。四项全关仍由 legacy sticky 分支处理。

## 4. 租约与账号模式

计划输出有序候选组、安全诊断和是否实际应用 sticky。租约逻辑沿用现有模式差异：

- sticky 主账号可用时直接租用；
- `single + sticky` 只等待首个 HRW 账号；
- `mode=sticky` 先等待 HRW 主账号至 `concurrencyWaitMs`，然后才允许后续组溢出；
- 其余模式在每个当前组内使用现有 rank，组满时立即尝试下一组；
- 没有 sticky 时，single 只等待第一组中最终选定账号；
- 所有模式均在容量通知后重建完整计划。

`selectedQuotaPool`、`selectedHealthLayer` 和 `capacityFallback` 从最终组投影；现有日志不增加顺序数组或会话值。

## 5. 控制台和草稿

将四个静态复选项改为一个原生有序列表。每项包含：拖动手柄、位置编号、复选框、上移和下移按钮。鼠标拖放和按钮排序共用一个 DOM 重排函数；排序后更新编号、禁用首尾按钮并通过 `aria-live` 宣布，但不发请求。

`loadAll()` 使用服务端顺序重排现有节点后再水合开关。`collectAccounts()` 从 DOM 顺序生成完整 `order`。禁用项仍可拖动并保留位置，以便后续启用。

原始调度编辑器在现有 `accountPipeline` 内增加 `order`，严格校验精确排列；应用时先重排同一组可视控件，再写布尔值。其 stale snapshot 比较自然包含顺序，仍由普通“保存账号配置”统一持久化。

## 6. 验证与兼容

- API/启动：旧配置默认顺序、旧客户端省略顺序保留、显式排列往返、非法顺序原子拒绝。
- 调度：额度优先与健康优先冲突、sticky 首/中/尾、过滤在分组前后、全部 unhealthy 回退、有/无 identity、六模式容量与租约。
- UI：拖放、上下移动、编号/状态、原始编辑器双向同步、保存失败/成功/重载、其他草稿不丢失。
- 安全：不输出原始 session/fingerprint、额度正文或凭据；普通日志仍只保留有界枚举。

## 7. 发布与回滚

配置迁移只增加一个小型排列字段。回滚旧版本时该版本可能把 `order` 视为未知流水线字段，因此生产回滚必须同时恢复部署前配置快照，或先将配置降级为四布尔旧形状。部署前保留原 `config.json` 哈希/备份；代码与配置切换遵循现有版本化发布流程。
