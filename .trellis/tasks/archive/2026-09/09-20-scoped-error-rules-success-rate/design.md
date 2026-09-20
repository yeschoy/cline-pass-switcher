# 技术设计：统一规则与双维度成功率

## 1. Owner

扩展 `server.js` 中现有 config/meta normalization、attempt classification、account/provider state、statistics finalizer、management routes；扩展 `public/index.html` 现有 `ACCS` 和统一 rule draft。不得新增第二个 store、队列、transport 或前端 generic store。

## 2. Config schema

建立 `normalizeErrorRules(value,{strict})` / shared validators，canonical 规则见父 `design.md`。上限沿用最多100条/64KiB，并为 ID、providers/models/status/body arrays、Header和duration设置更小字段界限。strict mode拒绝 unknown/missing/duplicate/empty；startup legacy migration整体成功后才保存。

Legacy effective order：content array原序 → exact status object有效枚举序。status range 可在迁移时展开成 bounded statuses 数组；ban→hard quarantine；cooldownMs→`duration` fallback/max。保留 legacy API projection，但 canonical `errorRules` 是唯一 match source。

Old POST 不带 errorRules：比较 legacy fields 与当前兼容投影；未变则保留 canonical，变化则409。带 errorRules：忽略 legacy mirrors并执行完整 strict replacement。

## 3. Match and action

`matchErrorRule(ctx)` 只读取 bounded/redacted failure text、normalized response headers、status、resolved model和named provider。第一条命中返回 `{ruleId,scope,action,cooldownMs,matchedBy}`；不返回/持久化 needle/value/body。无命中调用保守 default classifier。

账号 state 延伸现有 `accountStates`；Provider state 延伸 `models[model].upstreamStatus[provider]`。hard quarantine 独立于 success data。Provider recovery 是精确 authenticated API；account recovery复用现有 API。

Attempt trace只携带 bounded enum/id/action facts。account-scope removal控制账号链；provider-model removal控制当前Provider。degrade/ignore不控制retry。

## 4. Statistics vNext

minute bucket增加 `accountHealth` 和 `providerHealth`。迁移不转换旧 `health`; 设置两个 tracking start minute并保留旧 aggregate/token/cache/routing事实。新增 exact validation、provider cell cap和coverage owner。

finalizer从完整 trace 构造：

- account sample：每账号最多一条，account degrade优先，否则最终成功；
- provider sample：每个named attempt一条 success/degrade；
- cancel/management/auto忽略。

API projection仅输出 rate/counts/coverage。`null` rate与0%严格区分。

## 5. Pipeline/UI

canonical pipeline为 quotaPool/healthSort/sticky。Legacy exclude true folds into healthSort；server strict accepts canonical three and recognized legacy four. `healthSort`稳定按account rate细分，null最后。

`ERROR_RULE_DRAFT`改为一个有序数组；visual editor和advanced JSON共享generation。UI展示scope/applicability/conditions/action/reset，任意server text escaped。健康表只显示rate/sample/coverage以及独立disabled/cooling/quarantine。新增Provider恢复native button和aria-live反馈。

## 6. Security and lifecycle

Body matching使用现有redaction边界后的bounded view；Header值仅请求内比较。metadata/ordinary logs禁止raw match输入。Stream post-start action只更新future state；client cancel不匹配。Diagnostic persistence failure fail-open，config write failure不改变已确认runtime。

## 7. Rollback

statistics/config schema写入后，旧版本回滚需要发布前JSON备份。实现中先落validators/tests，再迁移，再runtime consumers，减少不可逆窗口。
