# 双维度错误规则与动态路由：总体技术设计

## 1. 架构边界

本任务扩展现有 owner，不新增框架、数据库、第二套队列、账号仓库或 Provider 传输：

```text
config.errorRules / accountPipeline / perModel
  -> strict normalization + migration
  -> account lease selection
  -> singleton Provider attempt planning
  -> bounded response classification + ordered rule match
  -> account state or (resolvedModel, provider) state
  -> request-scoped health sample finalization
  -> 24h success-rate projection
  -> next account / Provider selection
  -> bounded logs + authenticated console
```

始终保持两级路由：先租用一个账号，再在该账号内尝试 Provider。账号作用域动作不能伪装成 Provider 故障；Provider 动作不能隐式切换账号。

本父任务拆为三个实现子任务：

1. `09-20-scoped-error-rules-success-rate`：统一规则、双维度状态、成功率、迁移、恢复 API 与管理面。
2. `09-20-provider-success-retry-selection`：严格钉住首次选择、健康重试、Switcher 自动选择与 singleton-only 传输。
3. `09-20-dynamic-cache-pool-growth`：热池持久化目标大小和只扩不缩容量行为。

依赖顺序为 1 → 2/3；为避免 `server.js`、`public/index.html` 同时写入，实际执行保持串行。父任务最后负责跨子任务集成、全量门禁和统一 spec/docs。

## 2. 统一错误规则契约

### 2.1 规范形状

`config.errorRules` 是唯一权威有序数组：

```js
{
  id: string,
  scope: 'account' | 'provider-model',
  action: 'ignore' | 'degrade' | 'hard-quarantine' | 'cooldown',
  providers?: string[],
  models?: string[],
  when: {
    statuses?: number[],
    body_contains?: string | string[] | null,
    header?: null | { name: string, contains?: string }
  },
  reset?: {
    header?: string,
    format?: 'retry-after' | 'unix-seconds' | 'unix-milliseconds' | 'duration',
    fallback: string,
    max: string
  }
}
```

输入 `scope: "credential"` 规范化为 `account`，持久化和 API 投影只输出规范名称。`cooldown` 必须带合法 `reset`；其他动作必须省略 `reset`。规则 ID 唯一、稳定、控制字符安全；至少启用一个 `when` 条件，避免空规则误伤全部失败。

继续复用现有安全上限思路：规则数组、总 JSON 字节数、ID、状态数、body needle 数/长度、Header 名/值、Provider/model 数量均有固定上限；管理输入存在未知字段、空数组、重复值、非法 duration/format 或无条件规则时，在任何状态/文件修改前返回 400。

### 2.2 匹配

匹配只发生在已判定失败的真实 attempt 上。输入为：

- `normalizedStatus`；
- 当前 `resolvedModel` 与具名 Provider；
- 有界响应 Header 视图；
- 经现有 secret/request-message redaction、限长、单行化后的失败正文视图；
- transport origin 与保守错误归属分类。

数组内部 OR；`providers`、`models`、`when` 各条件之间 AND；规则顺序第一条命中即停止，包括 `ignore`。Header 名和普通字符串 contains 均大小写不敏感；不支持正则、JSONPath 或成功响应正文匹配。匹配值、Header 值和正文永不进入 metadata/普通日志。

### 2.3 冷却时间

使用一个共享 duration/reset parser：

- `retry-after`：非负 delta-seconds 或严格 HTTP-date；
- `unix-seconds` / `unix-milliseconds`：显式绝对时间；
- `duration`：严格 `d/h/m/s` 连续格式；
- 缺失/非法/已过期 Header 使用 `fallback`；
- 最终持续时间 clamp 到 `max`，并受全局安全上限约束；
- 省略 `format` 仅允许 Header 名 `Retry-After`。

不依据数字大小猜测单位。

### 2.4 未命中规则

保守默认分类只产生 `degrade` 或 `ignore`：

- 明确账号鉴权、账号额度、账号代理 → account degrade；
- 明确具名 Provider 429、5xx、network、timeout、unsupported → provider-model degrade；
- 请求参数 4xx、无法可靠归属、客户端取消 → ignore。

默认分类不创建 cooldown/quarantine。可重试判断独立于健康动作。

## 3. 双维度状态与控制流

### 3.1 账号状态

复用 `META.accountStates[accountId]`，规范化为可表达 `cooldownUntil` 与持久 `hardQuarantined` 的状态。旧 `banned: true` 迁移为 hard quarantine；兼容投影可暂时保留 bounded legacy mirror。状态只保存安全枚举、时间、规则 ID、规范状态码和脱敏 bounded reason，不保存规则 needle、Header/body、Key 或代理信息。

账号 cooldown/quarantine 立即终止该账号 Provider 链；首包前最多替换一次账号。现有 `/api/accounts/recover` 清理两者。账号 Key 身份替换或删除清理旧状态。

### 3.2 渠道+模型状态

复用 `META.models[resolvedModel].upstreamStatus[provider]` 作为唯一 durable owner，增加独立的 hard quarantine/cooldown/rule facts。旧 Provider cooldown 按原到期时间继续生效；旧 `status` 可作为兼容/探测事实保留，但不再作为健康阈值或成功率排序输入。

Provider cooldown/quarantine 只停止当前 Provider；同一账号可继续选择下一 Provider。新增严格恢复 API，例如 `POST /api/providers/recover` 接受精确 `{ model, provider }`，只清理该键的动态隔离/冷却；模型或 Provider 身份从配置和发现状态删除时清理孤儿状态。

流式响应开始后的状态更新只影响未来请求；不重放当前流。客户端取消不匹配规则、不写状态、不写健康样本。

## 4. 24 小时成功率

### 4.1 统计 schema

将 statistics 升级为新版本，并在 minute bucket 中新增明确 owner：

```js
accountHealth: {
  [accountId]: { successes, degrades }
},
providerHealth: {
  [resolvedModel]: {
    [provider]: { successes, degrades }
  }
}
```

成功率为 `successes / (successes + degrades)`；零样本投影为 `null`，不能变成 0。所有计数为非负 safe integer，溢出遵循现有 unknown/marker 原则。新增独立 provider-health cell 上限和 coverage 标记，不能用无界 `(minute, model, provider)` 增长替代现有边界。

迁移时不转换旧加权 account health，也不伪造 Provider 历史；记录 account/provider health tracking start minute，旧 cooldown/quarantine 保留。API 在窗口未完整时返回 coverage/from，UI显示“统计积累中”。

### 4.2 样本基数

- 账号：每请求每账号最多一条。该账号任一 account-scope degrade 命中时记失败；否则只有该账号取得最终成功才记成功。
- 渠道+模型：每个具名真实 attempt 各一条；成功记 success，显式/默认 provider-model degrade 记 degrade。unattributed auto 不归因。
- ignore、cooldown、hard-quarantine 不作为 degrade 样本；它们的状态事实单独投影。
- 管理、probe、validation、目录、额度和客户端取消不进入样本。

所有样本由现有 request-scoped idempotent finalizer一次提交；不得在每个 attempt 建立第二个独立统计写路径。

### 4.3 投影和排序

账号和 Provider 均投影 `{ successRate, successes, degrades, samples, coverageComplete, coverageFrom }`。有一条样本即显示；无样本为 null/“无数据”。

排序规则统一但数据 owner 分离：已知 rate 降序，null 最后，相同 rate 保持进入步骤前顺序。账号流水线绝不读取 Provider rate；Provider planner 绝不读取账号 rate。

## 5. 账号流水线与缓存池

规范流水线删除 `excludeUnhealthy` 语义和 UI，只保留 `quotaPool`、`healthSort`、`sticky`。旧 `excludeUnhealthy: true` 合并为 `healthSort: true`；旧四步输入可识别并规范化为三步。服务端执行 `healthSort` 时对当前候选组按账号成功率稳定细分，不设置淘汰阈值。

缓存活跃成员集合不读取成功率，仍由 hard eligibility、quota reserve、priority 和 stable ID 决定。成功率只排序当前 active 集合；若 healthSort 在 sticky 之前，则成功率优先，sticky 仅在相同 rate 内稳定分配。

## 6. 动态热池

配置扩展：

```js
accountPipeline: {
  quotaPool, healthSort, sticky, order,
  cachePoolSize,     // initial/min
  cachePoolMaxSize   // max; legacy default = cachePoolSize
}
```

metadata 只持久化 grow-only target size，不持久化第二份成员列表。有效目标为 operator min/max 与 metadata target 的 clamp；operator 显式关闭或降低上限可收缩，这是显式配置变更，不是自动缩容。

触发流程：

1. 当前 active 均为有限 `maxConcurrent` 且满载；
2. 等待 `concurrencyWaitMs`；
3. 重新计算后仍满载；
4. 若 target < max，同步将 target 加一并持久化；
5. 按 priority/ID 纳入一个合格 standby，再分配当前 lease。

Node 事件循环中的同步 compare-and-increment 防止并发超上限；继续复用现有 capacity waiter，不新增队列。`maxConcurrent: 0` 永不构成满载触发。禁用、账号 cooldown/quarantine、reserve 只替换成员，不降低 target。

## 7. Provider 计划

保留 `injectPrefs()` singleton-only owner。Provider 候选来源仍为 configured order，否则 stable discovered order；static exclude、hard quarantine 和 active cooldown 先过滤。

`pinMode: strict`：

1. 首次选择来源顺序首个可用 Provider；
2. 失败后排除本请求已尝试项；
3. 剩余候选按 provider-model success rate 降序、来源顺序 tie-break；
4. 每次只生成/发送一个 named attempt。

`pinMode: preferred` 兼容值重新定义为 Switcher 自动健康选择：从首次 attempt 起按 rate 排序，每次失败排除已尝试项后重算。`sort` 只注入已选 Provider 内部。全部具名候选被 static exclude/hard state/cooldown 排除时安全失败，不绕过；完全无配置/发现候选时只允许一次 unattributed auto。

`maxRetries` 继续限制首试后的 outer attempts。不可重试请求错误停止；Provider/账号 state action 按第3节控制。诊断区分 strict-first、health-selected、compat-auto 和真实 attempt path。

## 8. API、UI 与日志

- `/api/accounts`：完整 `errorRules`、三步 pipeline、cache pool min/max/target、账号 success projection/state/role。
- `/api/statistics`：账号 success projection；Provider 成功率以 `/api/models` 的 `meta.upstreamStatus` 安全投影或新增 bounded model-health projection输出，避免第二来源。
- `/api/providers/recover`：精确恢复 model/provider。
- 控制台：统一有序 rule draft；visual controls + advanced JSON 共用一个 owner；展示成功率/样本/coverage和独立 hard state；移除健康阈值及 exclude-unhealthy 控件；增加 max/target；Provider 恢复按钮。
- 旧账号规则字段仅作兼容投影。旧客户端不提交 `errorRules` 时保留；试图通过旧字段变更规则返回409。
- 普通日志只增加 bounded `ruleId/scope/action/matchedBy`、safe cooldown、selection strategy、pool min/max/target/expanded facts。不得记录 needle、Header值、body、rate bucket、候选列表、凭据或会话。

## 9. 迁移、回滚与失败

- 配置缺失 `errorRules` 时，先迁移 ordered content rules，再迁移 exact status rules；legacy ban → hard-quarantine；legacy cooldownMs → duration reset。迁移后持久化 canonical rules，并保留可表达 legacy API projection。
- statistics 新版本验证旧版本完整结构后再创建空成功率 owners/coverage；禁止 spread-merge 修复未知版本。
- config/metadata 任一 malformed/unreadable 文件仍使启动失败且不改原字节。
- 动态状态和诊断持久化失败保持模型流量 fail-open，但管理配置写失败必须返回错误且不虚报成功。
- 回滚到旧二进制无法理解全部新规则/三步 pipeline，生产发布必须使用发布前 config/metadata 备份；本任务不执行部署。

## 10. 验证策略

聚焦测试先覆盖：

- rule schema/matching/duration/migration/409/secret absence；
- account/provider state scope、manual recovery、stream/cancel boundary；
- vNext statistics migration、24h rates、coverage、cell caps、zero/null；
- account pipeline three-step migration and stable success sorting；
- strict-first then health retry, preferred health-first, singleton-only, no-candidate auto；
- dynamic pool full-wait-grow/persist/max/no-shrink/races；
- full account/UI draft round-trip and browser interaction where native dialog/focus/responsive behavior changes。

最终执行项目完整 syntax、VM、test 和 diff gates；跨子任务集成检查必须覆盖一条同时发生 Provider degrade、健康重试、账号规则和动态池诊断的端到端路径。
