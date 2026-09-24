# 官方价格与现有 usage 能力（规划证据）

## 官方来源（2026-09-24 读取）

- ClinePass 官方说明：https://docs.cline.bot/getting-started/clinepass
- 原文关键点：ClinePass 为 $9.99/month 包月；“you are not charged the individual API prices below. These reference prices show the underlying per-1M-token rates for each model and can help you understand how usage is measured against your ClinePass quota”。因此官网表格可做**参考用量等值估算**，不能标为实际扣费或厂商渠道账单。
- 官方表列模型 Input、Output、Cached Read，部分有 Cached Write；DeepSeek V4 Pro/Flash 区分 peak/off-peak，Qwen3.7 Plus 区分 ≤256K 与 >256K context。价格与模型 ID 映射需要版本化来源/日期，并覆盖下架/新增/变价。
- 官网确认 5h rolling、weekly、monthly 三层额度，但未在该页给出每层美元绝对上限；另一张用户截图中的约 $10/$25/$50 是社区推算，不能与官网模型单价混为同一个官方承诺。

## 本地代码事实

- `server.js:2138-2154` 的 `normalizeUsage()` 仅保存 input/output/total/cached-read Token 和其字段存在性；缺失为 `null`，已知 0 是 0。没有 cached-write/token 的独立字段，也无实际账单/价格接口投影。
- `server.js:4276-4282` 的 `/api/statistics` 已按 resolved model 聚合最近 24h usage，但 provider-model 维度只保存成功健康样本；按渠道拆分 Token 需要在原统计 owner 中建立可验证的归属，不能把失败尝试重复记为用量。

## 待产品决策

- 已确认：使用 ClinePass 官网页面价格做“参考用量等值（USD），非实际扣费”，不是另有上游实际账单来源。
- 某些模型按时段/上下文分档；在可靠条件缺失时显示费用不可计算，还是使用明确标注的粗略区间；不能静默择一价格。
