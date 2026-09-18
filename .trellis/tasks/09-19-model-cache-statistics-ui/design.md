# 模型缓存统计与展示设计

## 1. 统计 owner 与迁移

`server.js` 中的 `META.statistics` 继续是唯一统计 owner。将 schema 从 v1 显式迁移到 v2，不把模型统计塞进探测用的 `META.models`，也不从 JSONL 查询反算。

v2 在每分钟 bucket 增加：

```js
{
  minute,
  global,
  accounts,
  health,
  models: { [resolvedModelId]: Aggregate }
}
```

`recentCoverage` 增加模型侧覆盖信息：

```js
{
  droppedAccountMinuteCells,
  accountIncompleteAt,
  modelTrackingStartedMinute,
  droppedModelMinuteCells,
  modelIncompleteAt
}
```

不增加未被产品使用的 lifetime model map。v1 迁移时为旧 bucket 写入空 `models`，把 `modelTrackingStartedMinute` 设为迁移时当前分钟；旧全局/账号/健康数据逐字保留。模型 24h 窗口在开始分钟尚未覆盖窗口起点时标为 incomplete。模型 minute cells 使用独立固定上限，溢出时删除最旧模型 cell 并记录 `modelIncompleteAt`，不影响账号覆盖。

模型 key 的写入和校验使用 own-property/prototype-safe helper；不改变现有聊天模型兼容输入。

## 2. exactly-once 数据流

`handleChat()` 在解析别名后创建的统计 finalizer 固定携带 `modelId`：

```text
requested model -> resolveModelAlias -> modelId
  -> request-scoped idempotent finalizeStatistics
  -> commitStatistics({ modelId, usage, error, segments, ... })
```

每次已接受聊天只向该模型 bucket 合并一次与 global 相同的 request/error/usage delta。取消、失败、流式最终 usage 和容量拒绝沿用全局统计语义；management/test/probe 路径不调用该 chat finalizer。

`GET /api/statistics` 增加 `models` 数组，项目字段限制为模型 ID、recent24h aggregate 和 coverage。前端 `loadAll()` 与现有五个管理读取并发获取统计快照，把模型统计映射附到 `DATA` 模型视图，不创建独立通用 store。统计页面仍使用自己的 generation/visit owner。

## 3. 模型表展示

模型表新增“24h 缓存 Token 占比”列：

- ratio 有效：`91.4% · 412 请求有数据`；可在次行显示缓存/input Token 计数。
- 已知分母 0：显示 `0.0%` 仅当 ratio 合同允许；否则显示“无可计算输入 Token”，并保留覆盖数。
- 无成对 usage：显示“无数据”。
- 窗口未覆盖：在数值旁显示“统计积累中/覆盖不完整”，不能伪装完整 24h。

只显示 Token 占比，不显示 `cacheHitRequestRate`。

## 4. 上游发现修正

`harvestAvailableProviders()` 通过现有 `upstreamErrorOf()`/`errText()` 读取字符串或结构化 envelope，再从规范化文本严格提取 slug。探测成功时 provider 集合为：

```text
finalProvider + harvested providers + fallbacksAvailable
```

保持去重顺序。新增 bounded `upstreamDiscovery` 元信息（例如 `known` / `unavailable`）或等价显式字段，使 UI 能区分：

- 无 meta：未探测；
- 探测成功且有集合：显示数量；
- 探测成功但无法发现：显示“未发现”，不显示 0。

`upstreamStatus` 仍是独立校验结果；仅观察到 provider 不自动标记 `ok`。

## 5. 账号主表投影

`GET /api/accounts` 在每个认证账号对象内增加安全只读 `statistics`：

```js
{
  recent24h: AggregateProjection,
  lifetimeErrors,
  health
}
```

健康可复用已有 account `health` 字段，避免重复 owner。保留旧 `stats` 名称映射以兼容旧 UI/API 客户端，但新页面不再使用它。`renderAccounts()` 只读取账号对象内按 ID 生成的投影，不写回 `collectAccounts()`；完整保存仍显式挑选静态字段，运行投影不会持久化为配置。

## 6. 额度显示

仅修改 `quotaLimit()` 文案：验证 `percentUsed` 后显示 `剩余 ${(100-used).toFixed(1)}%` 和重置时间。`statisticsQuotaForecast()`、服务端 quota projection、状态判断和刷新 owner 不变。

## 7. 测试与回滚

- integration：v1→v2、严格验证/损坏保护、模型 exactly-once、别名、coverage/cell cap、provider harvest/finalProvider、稳定 ID 账号投影。
- account/UI VM：模型比例、未知/0、账号草稿保留、额度只剩余、转义和 stale guards。
- 浏览器：宽表横向滚动、桌面/390px、键盘和状态可读性。

回滚代码时不删除 v2 数据；若需要向旧版本回滚，部署计划必须先确认旧二进制对高版本统计的 fail-closed 行为并使用备份元数据。此子任务本身不执行生产回滚。
