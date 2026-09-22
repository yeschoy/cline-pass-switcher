# 技术设计：Provider 成功率与重试策略

## 1. Owner

保留 `injectPrefs()` 作为唯一singleton payload owner，将 `buildProviderAttempts()/planProviderAttempts()` 改为候选快照+逐次选择接口，而不是再创建一条transport/retry链。`runChatChain()` 继续是 outer attempt 与停止条件的唯一owner；新 retry policy 复用现有失败规范化和 bounded/redacted body view，不创建第二个matcher输入路径。

## 2. Candidate plan

建立稳定base plan：`configured | discovered | auto`、source order、static excludes、hard/cooldown availability、maxAttempts。Configured非空始终权威；known-all-excluded和known-all-hard安全失败；仅source完全为空时生成一次compat auto。

每次named attempt前从remaining选择：

- strict index0：source order首个available；
- strict retry：provider rate desc/null last/source index tie；
- preferred every attempt：provider rate desc/null last/source index tie。

attempt完成后将provider加入request-local attempted set，再根据独立 retry decision 决定是否继续。`maxRetries+1`限制真实outer attempt数，不把planning失败或blocked candidate算作attempt。

## 3. State actions and health samples

规则的处置动作与直接成功率样本在同一个attempt settlement中原子决定，但各自保持单一owner：

- `ignore`：不写直接健康样本，也不建立动态处置；
- `degrade`：只写一个失败样本；
- `cooldown`：写一个失败样本，并持久化有界`cooldownUntil`；
- `hard-quarantine`：写一个失败样本，并持久化隔离状态。

Provider-model scope按每个具名真实attempt最多写一次Provider失败样本；account scope保持现有request/account去重，任一account-scope degrade/cooldown/quarantine使该账号在该请求中最多写一个失败样本。Provider失败后同账号另一Provider成功时，前者degrade、后者success，账号仍可记success；account removal后替换账号各自结算。首事件已提交的SSE只在最终流状态结算，不能把stream-start placeholder记为success后再记failure。取消、管理流量、unattributed auto、stale generation和重复finalizer均不写样本。

Provider cooldown/quarantine保证该provider不再进入本次/未来候选；account cooldown/quarantine结束账号chain并遵守最多一次replacement。健康样本和处置都不决定retry classification。下一账号重新建立其route plan，但Provider-model hard state按共享model/provider继续生效。

## 4. Retry policy schema and matching

新增顶层配置：

```js
retryRules: [{
  id: "stop-empty-system-message",
  decision: "stop",
  when: {
    statuses: [502],
    body_contains: ["system message must have content"]
  }
}]
```

`normalizeRetryRules(value,{strict})` 是唯一 normalizer/validator：最多100条、序列化最多64KiB；ID沿用安全稳定格式且不重复；decision当前只允许`stop`；`when`精确包含非空statuses和body_contains。Statuses为去重100–599整数；body为一个字符串或最多20个去重、trim后1–500字符的普通文本。两类条件AND，body数组ANY，大小写不敏感，不支持正则/Headers。Persisted missing默认`[]`且不要求启动重写；显式非法持久值启动失败，管理输入在mutation前400。

`matchRetryRule(result,sensitiveValues)`复用 `normalizeFailureForRules()` 的bounded/redacted文本与normalized status，返回仅含`{ruleId,decision,matchedBy:["status","body"]}`的安全事实。needle、匹配片段和raw body只在请求内存在，不进入metadata/ordinary logs/API投影。

`settleAttempt()` 同时产出health policy与retry decision，但二者互不推导。失败attempt完成状态/健康结算后，`runChatChain()`把Provider标记attempted；若decision为stop则保留该attempt为terminal并停止本账号剩余Provider。外层`handleChat()`看到stop后不得account replacement，即使其它处置通常允许换号。无规则命中为`continue`，保持现状。Post-start SSE仍不重放，retry rule最多作为诊断事实；取消不匹配。

## 5. Paired preset and compatibility

“无效system消息停止重试”预设原子计算两个draft变化：

- retry rule：`502 + body contains system message must have content -> stop`；
- error rule：同一条件、`scope: provider-model`、`action: ignore`。

这样请求级确定性错误既不重试也不处罚Provider；retry matcher本身不隐式更改健康。预设沿用stable ID merge/replace预览，保留用户自定义规则，取消无变化。该预设只作为手动操作入口：默认和升级后的`retryRules`均为空，不做启动迁移或隐式激活；只有操作者确认普通完整保存后才生效。

`GET/POST /api/accounts` 返回/接收完整retryRules。新UI始终发送完整draft；旧客户端省略时服务器保留现值，显式字段则严格替换。Raw scheduling editor增加retryRules，仍不包含账号Key/代理/Header/route或runtime facts。成功保存后重新加载accepted server state。

## 6. Transport and stream

Named attempt通过planner gateway.only/direct provider.only（unknown pipeline二者相同）注入一个provider并删除order。Sort保留在singleton provider内部。相同account attempts保持同一Authorization/proxy/affinity key。

首个有效SSE event后绝不replay；late error只更新future state/health并可记录retry匹配事实；cancel终止planner并释放half-open/lease且无health/retry action。

## 7. Projection/UI

Plan/log投影source/strategy/planned providers、真实attempts和bounded retry rule facts，但不声称gateway内部行为。UI保留persisted strict/preferred值，文案改为“首选固定+健康回退”和“Switcher健康自动选择”。Provider列表显示rate/state但静态展示顺序不冒充实际runtime order。

Retry rules使用独立完整draft和可视化/advanced JSON owner，字段仅ID、statuses、body ANY、固定stop decision。所有server文本escape；任意正文不插入HTML。Full-account save、搜索、重绘、drawer、preset和raw editor不得丢失retryRules。

## 8. Rollback

本任务不新增state/statistics schema；只新增可缺失默认空的retryRules配置和既有action到样本的映射。回滚selector和映射代码不得迁移或清空既有Provider state/health。若发布后已保存retryRules，回滚到不识别字段的旧版本前保留配置备份；不得恢复multi-provider order。
