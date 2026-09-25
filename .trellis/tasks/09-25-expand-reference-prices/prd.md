# 扩展 ClinePass 模型参考消费等值

## Goal

在“模型和渠道”页面，依据**上游明确返回的实际输入、输出、缓存读取 Token**，乘用户指定的现行模型参考费率，展示便于统计的消费等值（USD）；不把它当作 ClinePass 订阅的实际扣费或账号额度余额。

## Confirmed source and existing behavior

- 用户先给出一张旧价格截图，后来询问当前官价并明确要求“按照这上面价格”在模型/渠道页面按实际使用 Token 计算；对于 DeepSeek 专门指定 https://api-docs.deepseek.com/quick_start/pricing/ 。因此本次**新**快照应采用 2026-09-25 读取的最新 ClinePass 官网 12 个模型，而不将旧截图 13 个模型误称为当前价；证据见 `research/price-source-drift-2026-09-25.md` 与 `research/deepseek-prices-2026-09-25.md`。官网未公布逐行生效日期。
- ClinePass 官网页面称订阅 $9.99/月，表中 USD/百万 Token 是**参考价格**而非额外逐 Token 扣费；DeepSeek 官网则是直接 API 的收费价格。本代理的显示应写“参考消费等值（USD），非订阅实际扣费”，不能从该值推导订阅剩余额度。
- **账号推测剩余额度不变**：月窗每账号 = 原社区参考上限 `$50 × (100 − monthly.percentUsed) / 100`，只加符合条件账号的月窗剩余；5h/周窗口及“当前可用”沿用独立旧规则。`public/index.html:1323-1347` 与 `test/account-draft.test.js` 已实现并覆盖；这不是模型/渠道页面的消费价格计算，除非发现实际回归，本子任务不改额度公式。
- `server.js:872-910` 旧价格快照 v1 仅给 Kimi K3、GLM-5.3、DeepSeek V4 Flash/Pro 估值；`normalizeUsage()` 只有 input/output/total/cached-read，没有 cached-write 或可证上下文档位。旧版本的请求时金额已经冻结，不能按今天费率重算。

## Requirements

1. **来源与价格**：新冻结快照覆盖当前 ClinePass 表 12 个精确模型 ID。GLM-5.3 Flash、DeepSeek V4.1 Flash、Muse Spark 与已不在当前表的旧 GLM/Kimi/DeepSeek Flash ID 不得混同。DeepSeek V4 Pro 和 V4.1 Flash 的高峰/低峰三种费率按用户指定的 DeepSeek 官网记录，并注明这与 ClinePass 页 Flash 仅列高峰行的来源区别；其官网时段涉及中国法定节假日，本服务无可靠档位事实时只显示**峰谷参考区间**，不猜单档实际扣费。每行仍能展示输入/输出/缓存读/缓存写单价、来源与快照版本。
2. **模型/渠道消费等值**：只计算最终成功请求中有明确、非负且一致的 input/output/cached-read 的部分；公式为 `(input − cachedRead) × 非缓存输入费率 + output × 输出费率 + cachedRead × 缓存读费率`，除以一百万 Token 单位。渠道行仅在唯一确认最终成功渠道时归属该用量；失败重试不重复计费，未知渠道保留单独行。缓存写入定价模型或上下文分档无法证明必要 usage/档位时，可展示费率但金额显示不可计算，不假定零。已计金额若只覆盖一部分请求，必须标示已计覆盖数而非完整费用。
3. **兼容与标签**：沿用现有请求时版本冻结的统计 owner、旧金额和独立覆盖/溢出语义；保留明确零与未知之别。页面标注“参考消费等值（USD），非订阅实际扣费”，并说明来源、项目采集时间不是官方生效时间；不增加实时价格查询或收费账单接口。

## Acceptance criteria

- [ ] 新价格快照逐行匹配经核对的 ClinePass 当前 12 模型和 DeepSeek 官方峰谷费率/来源；重启后旧 v1 已计金额与当时版本不变；旧版模型不借用今天近似名称的单价。
- [ ] 集成测试覆盖完整 usage、显式零、缺失缓存读、cached-read 大于 input、DeepSeek 两档区间、Qwen 缓存写/上下文档位未知、未支持模型、最终成功渠道/失败重试、部分覆盖/计数溢出及历史价格快照。
- [ ] 统计 API/管理台显示各模型参考单价与已计消费等值及覆盖说明；DeepSeek 不伪称精确档位，订阅账号月参考剩余仍为 `$50 × 月剩余百分比`。测试仅使用临时 `DATA_DIR`/本地 mock，不使用生产数据、密钥或付费上游。

## Out of scope

真实 ClinePass 账单、把 DeepSeek 直连 API 扣费误写成 ClinePass 实扣、从模型消费等值反推订阅月余额、旧价历史重算、猜测缓存写入次数/分档/节假日、将直连 DeepSeek 的 legacy alias 自动视为 ClinePass 的同名别名。
