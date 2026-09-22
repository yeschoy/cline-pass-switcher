# 双维度错误规则与动态路由策略

## Goal

将错误识别、健康状态和重试调度统一为可配置且可解释的机制：错误规则能够分别作用于账号和“渠道 + 模型”两个维度；缓存热池能够在并发压力下只扩不缩；严格钉住和 Switcher 智能选择都以单上游、逐次重试的方式执行。

## Background

当前系统已经具备账号状态码/内容错误规则、账号最近 24 小时加权健康评分、按 `(resolvedModel, provider)` 保存且跨账号共享的 Provider 健康状态、固定大小缓存活跃池，以及 Switcher 管理的单 Provider 外层尝试。目标契约不再沿用账号的加权罚分公式，而是以直接成功率表达健康；现有能力的规则模型、动作语义和池容量策略尚不足以表达本任务要求。

已确认具名 Provider 每次只通过单元素 `only` 发出一个独立 HTTP attempt，这个传输约束需要保持且不应重复建设第二套重试器。但现有 `strict` / `preferred` 都会在所有未冷却候选中保持配置顺序，尚未满足目标重试语义：严格钉住仅保证首次选择用户顺序中的首个可用渠道；后续重试应排除已尝试渠道，再按“渠道 + 模型”成功率选择。当前也不存在一个独立的 Switcher 智能跨 Provider 策略；无已知 Provider 时只有一次 unattributed `auto` 请求。

## Task Map

- `09-20-scoped-error-rules-success-rate`：先实现统一规则、双维度状态、成功率、迁移和管理面。
- `09-20-provider-success-retry-selection`：依赖前一子任务，实现 strict 首选与 Switcher 健康重试。
- `09-20-dynamic-cache-pool-growth`：依赖第一子任务，实现热池只扩不缩。
- 本父任务负责需求源、串行依赖、跨子任务验收和最终集成；后两个子任务在逻辑上可独立验收，但因共享 `server.js` / `public/index.html` 不并行写入。

## Requirements

### R1. 双维度错误规则

- 一套错误规则必须能明确指定作用维度：
  - 账号维度；规则中的 `credential` 与当前 `account.id` 一一对应，不引入账号下的第二层 credential 身份。规范化后的内部/投影名称使用 `account`，输入可将 `credential` 作为兼容别名；
  - “渠道 + 模型”维度，即某个 Provider 在某个 resolved model 下的独立状态，不得污染其他模型。
- 支持以下动作：
  - `ignore`：不改变目标维度的健康或隔离状态；
  - `degrade`：只记录目标维度的一次健康失败样本并降低成功率；它本身不创建冷却/隔离、不直接改变当前请求的重试控制流，也不直接把目标从候选集中移除；
  - `hard-quarantine`：持久隔离目标维度，跨进程重启保持，不因成功、探测成功或时间经过而自动解除；
  - `cooldown`：在有界时间内冷却目标维度。
- `degrade` 的记录基数按作用维度区分：同一个客户端请求中的同一个账号最多记录一次账号健康失败；`(resolvedModel, provider)` 按每个真实上游 attempt 记录，多个命中 attempt 可以累计多次，不做请求级去重。
- 账号 `hard-quarantine` 通过现有账号恢复入口手动解除；账号凭据身份被替换或删除时按身份失效规则清理旧隔离。
- `(resolvedModel, provider)` 的 `hard-quarantine` 需要独立的手动恢复入口；对应模型渠道身份从配置/发现状态中删除时清理隔离。
- 健康度采用不加权的直接成功率，不再使用账号现有的错误类型罚分公式，也不再把成功率映射为 `available` / `degraded` / `unhealthy` 等阈值状态。
- 管理面只展示成功率及其样本/覆盖信息；冷却、硬隔离、禁用等处置状态仍作为独立状态展示，不能伪装成健康率。
- 账号管理中的健康度流水线只作用于账号维度：按账号成功率排序，不得改变 `(resolvedModel, provider)` 的渠道重试顺序。未知/低样本数据需要明确、确定性的账号排序语义。
- 新规范流水线移除 `excludeUnhealthy`，只保留额度热池、成功率排序和会话粘性，不设置任何隐式成功率淘汰线。旧配置/旧客户端中的 `excludeUnhealthy: true` 兼容迁移为 `healthSort: true`，旧四步顺序可被接收并规范化为新三步顺序。
- 两个维度都使用最近24小时滚动成功率：`success / (success + degrade)`。账号按请求/账号去重：若该账号在请求内出现账号级 `degrade`，该账号本次记一个失败样本，否则仅在该账号取得最终成功时记一个成功样本；渠道+模型按每个具名真实 attempt 分别记录成功或 `degrade`，允许一请求多条。
- 有一个样本即可展示成功率并同时展示样本数；无样本显示“无数据”。需要排序时，有数据按成功率降序、无数据置后；成功率相同或都无数据时，账号保持进入流水线前的顺序，Provider 保持用户配置顺序或稳定发现顺序。
- 规则作用、健康变化和后续调度结果必须可解释、可测试，账号健康与渠道模型健康不得混为同一状态。

### R2. 状态码、响应体与响应头匹配

- 错误规则除状态码外，还必须支持对失败响应体和响应头进行匹配。
- 规则必须支持组合条件，至少覆盖：
  - `statuses`：一个或多个状态码，数组内部为 OR；
  - `body_contains`：不区分大小写的普通字符串包含，并支持字符串数组；数组内部为 ANY，任意一个非空值命中即可；
  - `header`：`null` 表示不启用，否则为 `{ name, contains? }`；Header 名不区分大小写，只提供 `name` 时匹配存在性，提供 `contains` 时对值做不区分大小写的普通字符串包含。
- 规则可选 `providers` 和 `models` 精确适用范围：各数组内部 OR，两个字段及 `when` 之间 AND；缺省表示全部。名称匹配不区分大小写且不支持正则，`models` 使用别名解析后的 `resolvedModel`。无 Provider 归属的兼容 auto 不匹配带 `providers` 限制的规则。
- 同一条规则中所有已启用的条件采用 AND。
- 规则按数组顺序匹配，第一条命中即停止，包括 `ignore`。
- 无显式规则命中时执行保守默认：明确账号鉴权、账号额度或账号代理错误记录账号 `degrade`；明确渠道 429、5xx、网络、超时或不可用记录对应 `(resolvedModel, provider)` 的 `degrade`；普通请求参数 4xx、无法可靠判定作用维度的错误和客户端取消按 `ignore` 处理。
- 默认处理不会自动创建 `cooldown` 或 `hard-quarantine`；只有显式规则可进入这两种状态。错误是否可重试由独立分类决定：账号作用域的 `cooldown` / `hard-quarantine` 立即停止该账号 Provider 链，并且只在客户端尚未看到输出时最多替换一次账号；渠道+模型作用域的 `cooldown` / `hard-quarantine` 只停止当前 Provider 并在同一账号继续选择下一 Provider。`ignore` / `degrade` 不直接控制重试。流式输出开始后的动作只影响未来请求，绝不重放当前流；客户端取消不执行规则动作。
- 冷却 `reset` 支持固定 `fallback`、指定响应 `header`、显式 `format` 和 `max`。`format` 支持 `retry-after`（delta-seconds 或 HTTP-date）、`unix-seconds`、`unix-milliseconds`、`duration`；省略格式时只允许 Header 名为 `Retry-After` 并默认 `retry-after`。Header 缺失、非法或已过期时使用 fallback，最终持续时间不得超过 max。
- `fallback`、`max` 及 `duration` Header 使用严格、有界的 `d/h/m/s` 连续时长格式，兼容 `5m0s` 和 `1h0m0s`；不得根据数字大小猜测单位或时间戳类型。
- 规则需要稳定 ID，并能表达类似以下的 operator 配置意图：

```json
{
  "id": "ollama-openai-rate-limit",
  "scope": "account",
  "action": "cooldown",
  "providers": ["ollama-openai"],
  "when": {
    "statuses": [429],
    "body_contains": null,
    "header": null
  },
  "reset": {
    "header": "Retry-After",
    "format": "retry-after",
    "fallback": "5m0s",
    "max": "1h0m0s"
  }
}
```

- 匹配与诊断不得将账号 Key、自定义 Header 值、代理凭据、请求消息或未经净化的响应体写入普通日志或元数据。

### R3. 动态热池扩容

- `cachePoolSize` 继续表示初始/最小活跃池大小；新增 `cachePoolMaxSize` 作为可扩容上限，旧配置默认上限等于初始大小，因此升级后不会自动扩大流量范围。
- 仅当所有当前活跃账号都达到各自有限的 `maxConcurrent`，等待 `concurrencyWaitMs` 后仍无容量时触发扩容；`maxConcurrent: 0` 表示不限并发，不构成满载扩容信号。
- 每次只扩一个账号，按现有账号优先级和稳定账号 ID 从合格备用账号中选择；先将其正式加入活跃池，再为当前请求分配 lease，不再把这种情况仅记为一次性备用溢出。
- 扩容后的目标池大小持久化到 `metadata.json` 并跨重启保持，但不得自动回写 operator 配置的初始值/上限。
- 本任务不要求动态缩容；一次扩容后的目标大小不得因并发下降而自动减少。
- 扩容不得绕过账号禁用、封禁、冷却、硬隔离或额度 reserve。成员因硬状态退出时可由合格账号替换，但已扩容的目标大小不下降。
- 活跃成员组成始终由 `priority + stable account ID` 和硬资格决定；24小时账号成功率波动不得提升/逐出成员。启用账号健康度流水线时，成功率只在当前活跃成员内部决定选择顺序，且优先于后续会话粘性；动态扩容及硬状态替换仍按 `priority + stable ID` 选择备用账号。
- 动态扩容必须保留会话稳定性，并通过管理投影和普通诊断提供配置初始值、上限、当前目标大小、角色和扩容原因，不暴露会话或凭据。

### R4. 严格钉住的单上游健康重试

- 严格钉住模式的首次 attempt 选择用户配置顺序中的第一个可用 Provider；明确排除、硬隔离和有效冷却的 Provider 不得被强行尝试。
- 首次失败后的后续重试必须排除本请求内已经尝试的 Provider，再在剩余可用 Provider 中按该 `(resolvedModel, provider)` 的成功率降序选择；成功率相同或无数据时需要确定性 tie-break。
- 每次上游 HTTP attempt 只能通过单元素 `only` 钉住一个 Provider，不得在一次请求中向网关提交多个候选 Provider。
- 前一个 Provider 满足可重试条件后，Switcher 才能发起下一个 Provider attempt。
- 账号健康度流水线不得参与 Provider 排序；Provider 排序只读取渠道+模型维度的成功率和硬状态。
- 新规则引擎与智能选择模式不得复制现有单 Provider attempt owner。

### R5. Switcher 智能选择的单上游策略重试

- Switcher 智能选择与账号流水线分离，并使用 `(resolvedModel, provider)` 维度的健康数据。
- 对具名候选执行健康选择时，从首次 attempt 开始就按渠道+模型成功率排序；每次失败后排除已经尝试的 Provider，再重新选择剩余候选。
- “自动选择”由 Switcher 所有：从配置的具名 Provider 候选中选择；未配置候选时使用稳定的已发现 Provider 集合。跨 Provider 只按最近24小时成功率降序选择，无数据置后且同率保持配置/发现顺序；现有 `sort: cost / ttft / tps` 仍只作用于已选定单个 Provider 内部，不参与跨 Provider 综合评分。每次选定后仍通过单元素 `only` 发出，不委托 Cline 网关进行不透明的多 Provider 选择或回退。
- 完全没有配置或发现 Provider 时，允许一次兼容性的 unattributed auto 请求；它不产生伪造的渠道+模型健康归因，也不进行不透明的重复 auto 重试。
- 每次上游 HTTP attempt 只能包含一个 Provider，Switcher 根据规则判定是否继续下一次尝试。
- 诊断必须能区分严格钉住、Switcher 自动健康选择和无候选兼容 auto，并记录安全、有限的策略和真实尝试结果。

### R6. 兼容与管理面

- 新的有序 `errorRules` 是唯一权威规则配置。启动迁移先按原顺序转换 `accountContentErrorRules`，再转换旧 `accountErrorRules` 精确状态规则；旧 `ban` 映射为账号作用域 `hard-quarantine`，旧 `cooldownMs` 转换为新 reset 时长。迁移成功后原子持久化新格式并保持可回滚的数据兼容，不修改账号凭据。
- `GET /api/accounts` 在兼容期返回 `errorRules`，并保留能够无损表达部分的旧规则字段投影。`POST /api/accounts` 提交 `errorRules` 时严格验证并替换；旧客户端未提交时必须保留完整新规则。若旧客户端通过旧字段尝试修改规则，返回明确 `409`，不得静默覆盖或丢失 Header/Provider/model 范围等新规则能力。
- 新控制台只编辑并提交 `errorRules`；账号完整保存、筛选、抽屉、预设和高级 JSON 草稿必须保留该完整有序数组。
- 服务端是规则验证、匹配、状态变更和重试决策的权威来源。
- 管理页面必须能够无损读取、编辑和保存新增配置；旧配置需要按上述兼容规则安全迁移。
- 新成功率统计从升级时刻重新积累，账号和渠道+模型都先显示“无数据/统计积累中”；不得把旧账号加权健康历史转换或伪装成新成功率。旧账号封禁/冷却及旧 Provider 冷却继续按原状态和到期时间生效。
- 管理流量、探测、模型目录和额度刷新不得误计入聊天健康结果。
- 普通请求的取消、SSE 首事件边界、已向客户端输出后的不可重放、账号 lease 释放和统计幂等语义必须保持。

## Acceptance Criteria

- [ ] AC1：同一错误可根据规则只改变账号状态，或只改变指定 `(resolvedModel, provider)` 状态；两个维度按各自去重基数投影最近24小时 `success / (success + degrade)` 与样本数，不生成健康阈值状态，测试证明不会跨维度或跨模型污染。
- [ ] AC2：`ignore`、`degrade`、`hard-quarantine`、`cooldown` 在两个目标维度上的行为均有明确结果和覆盖测试。
- [ ] AC3：Provider/resolved-model 适用范围、状态码、body contains、Header 及其组合匹配通过严格输入验证；Header 派生冷却时间正确应用 fallback 与 max；未命中规则时只按保守归属记录默认 `degrade` 或 `ignore`，不产生隐式冷却/隔离。
- [ ] AC4：任何规则匹配、状态持久化、管理 API 和普通日志都不泄露受保护的 Header/Body/凭据内容。
- [ ] AC5：旧 `excludeUnhealthy` 配置/四步顺序无损迁移为成功率排序且不产生隐藏淘汰阈值；账号成功率不改变缓存活跃成员组成，只排序当前活跃候选；旧热池配置默认不扩容；有限并发活跃池在全部满载并等待超时后逐个扩容到上限，扩容目标跨重启保持且不因压力下降缩小，并且不纳入硬不可用/reserve 账号。
- [ ] AC6：严格钉住首次选择用户顺序的首个可用 Provider，失败后排除已尝试项并按渠道+模型成功率选择剩余候选；抓取的每次出站请求都只包含一个 Provider。
- [ ] AC7：Switcher 自动选择从首次 attempt 起在配置或已发现具名候选中按渠道+模型成功率选择并逐次排除已尝试项，每次出站请求都只有一个 Provider；完全无候选时只允许一次不归因的兼容 auto。
- [ ] AC8：非流式、流式首事件前失败、流式已开始、客户端取消、账号切换和 Provider 重试保持既有安全边界及 exactly-once 统计。
- [ ] AC9：旧状态/内容规则按原优先级迁移为统一 `errorRules`；旧加权历史不伪装成新成功率而从迁移时刻重新积累，旧硬状态继续有效；旧客户端可保存其他账号字段但不能覆盖新规则，冲突修改得到 409；新配置可通过管理页面完整 round-trip。
- [ ] AC10：相关后端、前端、集成测试及项目全量质量门禁通过。

## Out of Scope

- 动态热池自动缩容。
- 将原生 Node 服务迁移到框架、引入前端构建系统或新增外部状态服务。
- 生产部署；除非后续单独获得明确授权。
