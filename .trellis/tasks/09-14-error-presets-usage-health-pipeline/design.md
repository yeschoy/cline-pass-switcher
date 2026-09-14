# 错误规则预设、统计面板与健康调度流水线 — 技术设计

## 1. 设计目标与边界

本任务在现有零数据库、零前端框架的单进程 Node 服务上扩展，不引入依赖，不改变“先选并租用账号，再在同一账号内执行供应商故障转移”的边界。

三类能力共享同一组稳定账号 ID，但状态所有权分离：

- `config.json`：用户配置的错误规则、流水线开关；
- `metadata.json`：有界统计、健康桶、额度快照；
- JSONL 请求/错误日志：诊断投影，不作为统计真相来源；
- `public/index.html`：错误规则快捷预设、流水线开关及统计板块。

本任务不拆子任务：三个交付物共同修改 `server.js`、`public/index.html` 和同一套集成契约，拆分会产生多个写者及重复迁移。

## 2. 配置与迁移

### 2.1 流水线配置

新增最小配置：

```js
accountPipeline: {
  quotaPool: false,
  excludeUnhealthy: false,
  healthSort: false,
  sticky: false
}
```

`normalizeAccountPipeline(value, { strict })` 是唯一规范化入口：

- 启动迁移：缺失或非法字段安全归一为 `false`；
- 管理 API：只接受对象、上述四个键和布尔值，未知键/非布尔值返回 `400`；
- 新安装及旧配置默认全部关闭；
- `POST /api/accounts` 缺少 `accountPipeline` 时保留当前值，避免旧管理客户端静默关闭已启用流水线；新版 UI 总是提交完整值。

当四个开关全为 `false` 时，直接进入现有选号实现，不通过新排序模拟旧行为。这样保持六种模式的 RR 计数、权重比例、配置顺序、sticky 等待/溢出和 priority 容量回退完全不变。

### 2.2 动态统计结构

在 `metadata.json` 中新增版本化结构：

```js
META.statistics = {
  version: 1,
  lifetime: {
    global: Aggregate,
    accounts: { [accountId]: Aggregate }
  },
  minuteBuckets: [{
    minute,                         // floor(ts / 60000)
    global: AggregateDelta,
    accounts: { [accountId]: AggregateDelta },
    health: { [accountId]: HealthDelta }
  }],
  recentCoverage: {
    droppedAccountMinuteCells,
    accountIncompleteAt: { [accountId]: minute }
  },
  migration: {
    legacyStatsMigratedAt,
    legacyRequests,
    accountLegacyRequests: { [accountId]: number },
    ambiguousNames,
    unmappedNames
  }
}

Aggregate = {
  requests, errors,
  usageRequests,
  inputKnownRequests, inputTokens,
  outputKnownRequests, outputTokens,
  totalKnownRequests, totalTokens,
  cacheKnownRequests, cacheHitRequests, cachedTokens,
  cacheInputKnownRequests, cacheInputTokens, cacheInputCachedTokens,
  lastUsedAt, lastErrorAt,
  overflowFields
}

HealthDelta = {
  results,
  penaltyUnits, // 整数十分位：auth=10, rate=7, network=6, server=4, other=5
  errors,
  auth, rateLimit, networkProxy, server, other
}
```

最近窗口只保留当前分钟及之前 1439 个分钟键，共最多 1440 桶。一个“账号分钟单元”定义为唯一 `(minute, accountId)`，计数取该分钟 `accounts[id]` 与 `health[id]` 键的并集；总数硬限制为 50,000。超限时按分钟从旧到新驱逐完整单元，同时删除该账号该分钟的 AggregateDelta 和 HealthDelta，但保留 global 增量，并令 `accountIncompleteAt[id]` 保存最新被丢弃分钟。缺口离开 1440 分钟窗口前，该账号 recent24h 标记 coverage incomplete，健康状态强制为 `insufficient`，不得据不完整样本过滤。账号删除时从 lifetime、分钟桶、coverage、健康和额度状态中删除该 ID，global 历史保留。这样动态近期状态受 `1440 buckets + 50,000 account cells + current account lifetime` 的明确上限约束，而不随请求量增长。

Aggregate 的固定计数字段只接受非负安全整数。若下一次加法超过 `Number.MAX_SAFE_INTEGER`，对应字段变为 `null` 并加入固定枚举的 `overflowFields`；后续不再对该字段加法，所有依赖该字段的比例返回 `null`。健康权重只累计整数 `penaltyUnits`，避免小数持久化漂移。比例只在 API 查询时由有效分子/分母计算。

`metadata.json` JSON 解析/read 错误继续由 `loadJson()` 致命退出并保留原文件；已存在的 version 1 statistics 若结构、计数/null-overflow 关系或桶边界非法，也在任何 `saveMeta()` 前抛出明确错误，不静默清空。缺失 statistics 才初始化/迁移；未知更高版本拒绝启动，防止降级覆盖。

旧 `META.stats` 以账号名为键且混入历史控制台测试，无法伪造 token、24 小时或健康数据。一次性迁移只写入独立标注的 `migration.legacyRequests` 与 `accountLegacyRequests`，禁止合入新的精确 chat `requests`、分钟桶、token/cache 或健康分母。唯一同名账号可关联历史基线；重名或未匹配只计入有界摘要。统计 UI 单独显示“旧版请求基线（可能含控制台测试）”，不得与精确业务请求相加成无标注总量。迁移带版本/时间并删除/停止读取旧 map，重启不得重复迁移。

### 2.3 额度快照

```js
META.accountQuotas = {
  [accountId]: {
    snapshot: {
      limits: {
        five_hour: { percentUsed, resetsAt? },
        weekly: { percentUsed, resetsAt? },
        monthly: { percentUsed, resetsAt? }
      },
      fetchedAt
    },
    lastAttemptAt,
    lastSuccessAt,
    errorCategory // null | auth | rate_limit | server | http | proxy | network | timeout | json | schema
  }
}
```

只保存严格投影；禁止保存 Key、Header、URL 凭据、异常正文和原始响应。未知 limit 类型忽略；重复已知类型、非法数字、越界百分比或非法时间使整次新投影失败，并保留上次有效快照供诊断显示。路由只使用“最近一次请求成功、三个窗口齐全且 15 分钟内新鲜”的快照；任一抓取失败会立即使当前路由额度归为未知，last-good 不继续参与池选择。UI 可标注显示 last-good/部分窗口，但不得据此宣称热池。

## 3. 统计与健康数据流

### 3.1 Usage 规范化

新增纯函数：

```js
normalizeUsage(raw) -> {
  inputTokens,
  outputTokens,
  totalTokens,
  cachedTokens,
  cacheFieldPresent,
  cacheInputPairPresent
} | null
```

只从已识别的 `usage` 对象读取显式字段，使用 `hasOwnProperty` 区分缺失和显式 `0`。接受优先级：

- input：`prompt_tokens` → `input_tokens` → `inputTokens`；
- output：`completion_tokens` → `output_tokens` → `outputTokens`；
- total：`total_tokens` → `totalTokens`；
- cache：`prompt_tokens_details.cached_tokens` → `input_tokens_details.cached_tokens` → `cache_read_input_tokens` → `cached_input_tokens` → `cachedInputTokens`。

每个值必须是有限非负整数；不递归扫描任意响应，不把 `cache_creation_*`、粘性或重复提示当成缓存命中，也不推算缺失 `totalTokens`。

统计 API 对每项同时返回值和覆盖请求数。`cachedTokens` 是所有明确 cache 字段请求的累计展示值；缓存 Token 占比必须使用配对累计 `cacheInputCachedTokens / cacheInputTokens`，两者只接收同时明确返回 cache 与 input 的请求。命中请求率使用 `cacheHitRequests / cacheKnownRequests`。分母为 0、任一字段 overflow，或配对 cached 大于配对 input 时比例为 `null`，UI 显示“无数据”。

### 3.2 Exactly-once 提交

`handleChat()` 创建请求级提交闭包，只有该闭包可以同时写入业务统计与调用现有 `record()`：

```js
const finalizeChat = once((facts) => {
  commitStatistics(facts);
  record(modelId, facts);
});
```

- 只有 JSON object 与 model 校验通过后的客户端聊天进入统计；参数解析/校验前拒绝的请求不计；
- 容量失败：全局请求与全局错误各记一次，无账号段、usage 或健康结果；
- 下游主动断开：全局请求记一次但不记全局/账号错误，不提交不完整 usage，也不影响健康；
- 最终上游/服务失败：全局错误一次；账号段仅在该段终止失败时记一次 operational error；
- 供应商重试：不单独增加请求或健康结果；
- 每个下游请求中同一账号最多形成一个账号处理段；A→B 换号时两账号处理数各加一，但全局请求只加一；
- 最终 usage 只归属真正返回最终响应的账号；失败账号不继承 B 的 token；
- `/api/test`、探测、校验、目录抓取和额度刷新继续可写诊断，但不调用业务统计提交。

非流式只在最终 `chain.routing.usage` 提交。流式在现有幂等 `finalize()` 中提交最后一个有效 usage 快照，多个累计 SSE usage 事件只取最后一个，绝不求和。

为避免统计功能扩大现有流式全量缓存风险，流式 Transform 改为增量观察器：只保留最大 64 KiB 的未完成 SSE 事件，原字节按背压透传；观察器仅保存最后 usage、供应商/模型投影和第一个终止错误。`chain.streamHead` 必须先输入同一个观察器恰好一次，再写给下游；后续 Transform 只输入剩余字节，避免首个读取 chunk 同时包含多个事件时漏掉 usage，也避免重复观察首事件。超大/非法事件只使对应统计未知，不得中断客户端响应。

### 3.3 每账号健康结果

transport、provider trace 与流式生命周期增加内部安全枚举 `terminalOrigin`：`success | upstream_http | upstream_envelope | proxy | network | timeout | client_disconnect | capacity`。最终 trace 按稳定 `accountId` 分段并去重，每个账号只取该段终止结果；健康分类使用 normalized status + terminalOrigin，而不是从错误文本猜测：

- 该账号内 `500 → 200`：成功，权重 0；
- 401/403：1.0；429：0.7；
- 代理/网络/上游超时：0.6；
- 最终 5xx：0.4；其他账号可归因错误：0.5；
- 除 401/403/429 外的 4xx：参数/请求错误，不进入健康分母；
- 容量失败、下游断开、管理流量、本地校验/持久化错误：不惩罚账号；
- 已开始流式后的真实上游错误只惩罚一次，仍禁止重放。

最近 1440 分钟桶计算：

```text
score = 100 - (penaltyUnits / 10) / results * 100
```

少于 5 个有效结果为 `insufficient`；否则 `>=80 available`、`>=50 degraded`、`<50 unhealthy`。显示优先级为：disabled → banned → cooling → insufficient/scored。排序使用未四舍五入分数，展示才取整。

## 4. 额度刷新

端点：

```text
GET {upstreamBase}/users/me/plan/usage-limits
Authorization: Bearer <account.key>
Accept: application/json
```

默认即 `https://api.cline.bot/api/v1/users/me/plan/usage-limits`。扩展现有原生 `clineRequest()` 支持默认不变的 `method: "POST"` 及 GET；额度请求复用账号代理 Agent，但不发送下游 Header 或账号自定义聊天 Header，代理失败绝不回退直连。

固定常量而非新增用户配置：15 秒超时、并发 2、成功后 5 分钟刷新、失败后 1–15 分钟有界退避、15 分钟过期、按稳定账号 ID 抖动启动、同账号不重叠，timer 调用 `unref()`。只有 `accountPipeline.quotaPool=true` 时调度后台刷新；刚开启或快照未知时聊天仍按普通调度，不在选号路径发起或等待请求。

内存 `quotaGeneration[accountId]` 在账号删除、Key/代理变化和流水线关闭时递增。每次刷新捕获 generation、Key 和代理值，提交前重新确认账号仍存在、三者均未变化且 quotaPool 仍启用；否则丢弃结果，防止旧请求复活已删除账号或把旧凭据额度写回轮换后的同一 ID。聊天结束时 global 统计始终保留，但只有账号 ID 仍存在时才写账号级 lifetime/recent/health，避免删除后的在途请求复活账号状态。

任何额度失败立即把当前路由状态设为 unknown，只更新安全错误类别并保留 last-good 供 UI 诊断，不影响健康、ban/cooldown 或聊天响应。

为使分钟级自动测试可运行，生产常量保持固定；仅当子进程显式 `NODE_ENV=test` 时允许读取 `CLINE_PASS_TEST_QUOTA_*` 时间缩放/零抖动 seam。测试必须使用本地 mock，生产环境忽略这些测试变量，不新增用户配置。

## 5. 固定调度流水线

开启任一流水线开关后的固定顺序：

1. **硬过滤**：无 Key、禁用、本次请求排除、封禁、未到期冷却；永不回退；
2. **健康过滤（可选）**：只删除已评分 `unhealthy`；insufficient/available/degraded 保留。若因此清空全部硬候选，只恢复最高分不健康层并记录 `health-filter-fallback`；
3. **额度池（可选）**：三个新鲜窗口的最大 `percentUsed` 决定 hot `<80`、warm `<95`、unknown、reserve `>=95`；全部未知时此步为 no-op；
4. **健康分层（可选）**：available 与 insufficient 同层，degraded 次之，unhealthy 最后；
5. **粘性（可选或 mode=sticky 隐式）**：有 fingerprint 时在当前最高层用现有 HRW 选一个主账号且只执行一次；无身份时不伪造粘性；
6. **现有 mode**：若粘性主账号可租用则不得覆盖它；否则按下表执行等待或在同层/下一允许层用现有 mode 回退。

构建流水线计划的函数只产生有序候选组和安全诊断，不修改全局账号顺序，也不租约。租约函数在容量通知后重新计算计划。

`accountPipeline.sticky × accountMode` 的确定矩阵：

| identity / mode | 行为 |
|---|---|
| 无 identity，任意 mode | 跳过可选粘性；`sticky` mode 沿用现有 `sticky-no-identity-roundrobin`，其他 mode 正常 |
| 有 identity，mode=`sticky` | 在最高允许层执行一次 HRW；主账号空闲立即使用，满载则等待 `concurrencyWaitMs`，之后才按 HRW/层顺序溢出 |
| 有 identity，mode=`single`，pipeline sticky 开 | HRW 主账号覆盖 active；只等待该主账号，不容量溢出 |
| 有 identity，mode 为其余四种，pipeline sticky 开 | HRW 主账号空闲时优先且最终 mode 不得覆盖；满载时不等待，立即由该 mode 在剩余同层及下一允许层选择 |
| pipeline sticky 关且 mode 非 `sticky` | 不执行 HRW；完全按 mode 在流水线层内选择 |

因此 roundrobin / least-connections / weighted-roundrobin / priority-failover 在最高层无容量时立即选下一允许层，并记录 quota/health capacity fallback；single 与 sticky 保持上表的既定等待差异。

普通供应商重试始终使用同一租约账号。cooldown/ban 仅在输出开始前允许 `handleChat()` 进行一次排除后重新执行完整流水线；第二次处置不得选择第三账号。

选号日志只增加枚举步骤、候选数量、quota/health 层和回退原因；不记录原始 session/fingerprint、原始额度响应或敏感配置。

## 6. API 与 UI

### 6.1 管理 API

- `GET /api/accounts`：返回完整 `accountPipeline` 及账号的精简健康/额度状态；保留现有字段兼容；health/quota 必须与统计 API 复用同一个严格 projector，避免 stale/unknown 漂移；
- `POST /api/accounts`：先严格校验完整账号、模式、规则、流水线，再一次性写配置；失败不得部分写入；
- `GET /api/statistics`：经现有管理鉴权，返回 `generatedAt`、lifetime、recent24h 和按当前账号 ID join 的 health/quota 严格投影；不返回原始桶和 META；
- 请求日志投影增加有界的流水线步骤/层/回退原因，不增加消息、会话、Key、代理或 Header 值。

### 6.2 顶层统计板块

顶部导航扩展为“控制台 / 统计 / 请求日志 / 错误日志”四个互斥板块。进入统计时请求 `/api/statistics`，使用独立查询代数防止离开后旧响应覆盖 UI。

统计页展示：

- 累计与最近 24 小时的全局请求、错误、input/output/total token、字段覆盖；
- cached token、缓存 Token 占比和缓存命中请求率及明确分母；
- 每账号处理请求、token、错误、健康状态/分数/样本数；
- Cline 5h/周/月已用百分比、重置时间、额度池、抓取时间/未知错误类别；
- 说明换号后账号处理数之和可能大于全局请求数；旧 `META.stats` 请求基线单独标注“可能含控制台测试”，不得与精确聊天请求无标识相加；
- 不提供 7 天趋势或统计重置。

所有服务端文本经 `escapeHtml()` 或 `textContent`；表格使用 `.table-wrap`，加载/错误状态使用 `aria-live`。

### 6.3 错误规则预设与流水线 UI

新增独立错误规则预设控件，不复用现有六个综合策略预设的含义。定义仅在前端一处：

- standard：429 / 30m；
- fast：429 / 5m，500/502/503/504 / 1m；
- conservative：429 / 60m，500/502/503/504 / 5m；
- observe：429/500/502/503/504 ignore；
- clear：空对象，仅 replace。

预览必须读取当前 textarea 草稿而不是旧 `ACCS.accountErrorRules`。默认 merge，可切 replace；按状态码列出 preserved/added/modified/deleted。取消不改草稿；确认把结果写回高级 JSON，并调用现有完整 `saveAccounts()`。现有综合策略预设合并规则时也改读当前草稿，避免覆盖未保存自定义值；其中现有 `safe` 预设移除 401/403 自动 ban，只保留 429 处置，以满足“所有自动预设的 4xx 仅处理 429”。401/403 仍可在高级 JSON 中自定义。高级 JSON 始终保留。

账号调度区域增加固定顺序的四个 checkbox，并说明 sticky mode 的隐式行为、健康回退、未知额度及容量跨层回退。`collectAccounts()` 必须携带完整 pipeline，现有预设不得静默修改它。

## 7. 兼容、回滚与风险

- 旧配置和全 false 走旧选号快路径；旧 API 客户端缺 pipeline 字段时保留当前值；
- 旧统计只迁移可证明的请求基线，token/cache/24h/健康均从上线后开始；
- 额度接口变化只导致 unknown，不阻断聊天；
- 所有新增动态状态均可通过关闭四个开关停止影响调度；本地统计继续只读展示；
- 回滚代码时未知 config/META 字段会被旧版本忽略，原账号/路由配置不受影响；
- 最高风险为 usage 重复、缺失字段伪 0、重试重复惩罚、全 false 兼容回归、静态高层容量饥饿、额度请求进入聊天关键路径和敏感信息进入 META。测试计划必须逐项覆盖。
