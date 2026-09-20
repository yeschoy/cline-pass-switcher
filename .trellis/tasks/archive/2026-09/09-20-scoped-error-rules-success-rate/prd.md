# 统一双维度错误规则与成功率

## Goal

交付父任务中可复用的规则与健康基础：统一有序 `errorRules`、账号与 `(resolvedModel, provider)` 双维度动态状态、最近24小时直接成功率、旧配置迁移、恢复 API 和完整管理面。

## Background

父任务：`../09-20-scoped-error-rules-dynamic-routing/`。本子任务必须先完成；Provider 健康重试和动态热池子任务消费这里建立的 state/rate/pipeline contract。

## Requirements

1. `errorRules` 是唯一权威规则数组，支持稳定 ID、`account`/`provider-model` scope（输入 `credential` 为账号别名）、`ignore`/`degrade`/`cooldown`/`hard-quarantine`、可选 Provider/model 适用范围，以及 status/body/Header AND 匹配。
2. `body_contains` 支持字符串或 ANY 数组；所有 contains 均为大小写不敏感普通文本，不支持正则。第一条命中即停止。
3. cooldown reset 支持显式 Header format、strict duration、fallback/max；完整输入在任何 mutation/network 前验证。
4. 无显式命中时只按保守归属产生 account/provider-model `degrade` 或 `ignore`，不隐式冷却/隔离；retry classification 独立。
5. 账号 cooldown/quarantine 复用账号 state owner；Provider-model state 复用 model/provider metadata owner。hard quarantine 跨重启且只能手动恢复或随身份失效清理。
6. 新 statistics 从迁移时刻分别记录账号 request-dedup 样本与具名 Provider attempt 样本，投影24小时 `success/(success+degrade)`、计数和 coverage；不转换旧加权历史。
7. 健康 UI 只展示成功率/样本/coverage与独立 hard state，不生成 available/degraded/unhealthy 阈值状态。
8. 账号流水线删除 `excludeUnhealthy` 语义，旧 true 合并为 `healthSort`；规范执行只包含 quotaPool、healthSort、sticky。账号 rate 排序绝不读取 Provider 数据。
9. 旧内容规则先于旧状态规则迁移；ban → account hard-quarantine；旧客户端缺失 `errorRules` 时保留，试图经 legacy fields 修改时返回409。
10. UI 的 visual/advanced JSON/preset/full-account save 共用一个完整 rule draft，保留所有隐藏账号字段并安全渲染。
11. 所有 metadata/log/API/UI 投影不得包含 rule needle、Header/body、Key、代理、消息、session 或 fingerprint。

## Acceptance Criteria

- [ ] 规则所有合法形状、组合匹配、first-match、ANY body、Provider/model 范围、duration format 与非法输入均有确定测试。
- [ ] 同一错误只改变声明 scope；账号和 Provider-model cooldown/quarantine/recover/restart/identity cleanup 均正确。
- [ ] 未匹配默认 degrade/ignore 与 retry 控制解耦，客户端取消和管理流量无健康/状态副作用。
- [ ] 两维度最近24小时成功率按各自基数精确记录；null/zero/coverage/cell cap/overflow/migration 均真实。
- [ ] 三步账号流水线稳定按账号 rate 排序；旧四步/`excludeUnhealthy` 输入安全迁移且无隐藏阈值。
- [ ] legacy rules 迁移顺序和 old-client 409 行为正确；新 UI 完整 round-trip。
- [ ] 非流式、首事件前/后流式错误、账号替换、取消和 finalizer exactly-once 保持。
- [ ] 聚焦测试、全量项目门禁与相关 spec/docs 更新通过。

## Out of Scope

- 动态热池扩容。
- Provider strict/preferred 的新健康选择顺序（由 sibling 子任务实现）。
- 生产部署。
