# 技术设计：Provider 成功率重试选择

## 1. Owner

保留 `injectPrefs()` 作为唯一singleton payload owner，将 `buildProviderAttempts()/planProviderAttempts()` 改为候选快照+逐次选择接口，而不是再创建一条transport/retry链。

## 2. Candidate plan

建立稳定base plan：`configured | discovered | auto`、source order、static excludes、hard/cooldown availability、maxAttempts。Configured非空始终权威；known-all-excluded和known-all-hard安全失败；仅source完全为空时生成一次compat auto。

每次named attempt前从remaining选择：

- strict index0：source order首个available；
- strict retry：provider rate desc/null last/source index tie；
- preferred every attempt：provider rate desc/null last/source index tie。

attempt完成后将provider加入request-local attempted set，再根据independent retry classification决定是否继续。`maxRetries+1`限制真实outer attempt数。

## 3. State actions and health samples

规则的处置动作与直接成功率样本在同一个attempt settlement中原子决定，但各自保持单一owner：

- `ignore`：不写直接健康样本，也不建立动态处置；
- `degrade`：只写一个失败样本；
- `cooldown`：写一个失败样本，并持久化有界`cooldownUntil`；
- `hard-quarantine`：写一个失败样本，并持久化隔离状态。

Provider-model scope按每个具名真实attempt最多写一次Provider失败样本；account scope保持现有request/account去重，任一account-scope degrade/cooldown/quarantine使该账号在该请求中最多写一个失败样本。Provider失败后同账号另一Provider成功时，前者degrade、后者success，账号仍可记success；account removal后替换账号各自结算。首事件已提交的SSE只在最终流状态结算，不能把stream-start placeholder记为success后再记failure。取消、管理流量、unattributed auto、stale generation和重复finalizer均不写样本。

Provider cooldown/quarantine保证该provider不再进入本次/未来候选；account cooldown/quarantine结束账号chain并遵守最多一次replacement。健康样本和处置都不决定retry classification。下一账号重新建立其route plan，但Provider-model hard state按共享model/provider继续生效。

## 4. Transport and stream

Named attempt通过planner gateway.only/direct provider.only（unknown pipeline二者相同）注入一个provider并删除order。Sort保留在singleton provider内部。相同account attempts保持同一Authorization/proxy/affinity key。

首个有效SSE event后绝不replay；late error只更新future state/health；cancel终止planner并释放half-open/lease且无health action。

## 5. Projection/UI

Plan/log投影source/strategy/planned providers和真实attempts，但不声称gateway内部行为。UI保留persisted strict/preferred值，文案改为“首选固定+健康回退”和“Switcher健康自动选择”。Provider列表显示rate/state但静态展示顺序不冒充实际runtime order。

## 6. Rollback

逐次selector可回退到原planner，但不得恢复multi-provider order。本任务不新增state/statistics schema，只修正既有action到样本的映射并让选择器消费同一24小时投影；回滚selector和映射代码不得迁移或清空既有Provider state/health。
