# 官方价格与现有 usage 能力（规划证据）

## 官方来源（2026-09-24 读取）

- ClinePass 官方说明：https://docs.cline.bot/getting-started/clinepass
- 原文关键点：ClinePass 为 $9.99/month 包月；“you are not charged the individual API prices below. These reference prices show the underlying per-1M-token rates for each model and can help you understand how usage is measured against your ClinePass quota”。因此官网表格可做**参考用量等值估算**，不能标为实际扣费或厂商渠道账单。
- 官方表列模型 Input、Output、Cached Read，部分有 Cached Write；DeepSeek V4 Pro/Flash 区分 peak/off-peak，Qwen3.7 Plus 区分 ≤256K 与 >256K context。价格与模型 ID 映射需要版本化来源/日期，并覆盖下架/新增/变价。
- 官网确认 5h rolling、weekly、monthly 三层额度，但未在该页给出每层美元绝对上限；另一张用户截图中的约 $10/$25/$50 是社区推算，不能与官网模型单价混为同一个官方承诺。
- 本次再次读取官网（2026-09-24）：该参考价格表**没有逐行生效日期或版本号**。不能把采集日期冒充官方生效日期；价格快照可标记本项目采集时间与内部版本，官方生效时间应显示未知。来源表格如下（单位 USD / 1M Token；`—` 表示官网无该项价格）：

| Model ID | Input | Output | Cached read | Cached write | Tier |
|---|---:|---:|---:|---:|---|
| cline-pass/glm-5.3 | 1.40 | 4.40 | 0.26 | — | single |
| cline-pass/glm-5.2 | 1.40 | 4.40 | 0.26 | — | single |
| cline-pass/kimi-k3 | 3.00 | 15.00 | 0.30 | — | single |
| cline-pass/kimi-k2.7-code | 0.95 | 4.00 | 0.19 | — | single |
| cline-pass/kimi-k2.6 | 0.95 | 4.00 | 0.16 | — | single |
| cline-pass/deepseek-v4-pro | 1.32 / 0.66 | 3.96 / 1.98 | 0.044 / 0.022 | — | peak / off-peak |
| cline-pass/deepseek-v4-flash | 0.44 / 0.22 | 1.32 / 0.66 | 0.014 / 0.007 | — | peak / off-peak |
| cline-pass/mimo-v2.5 | 0.14 | 0.28 | 0.0028 | — | single |
| cline-pass/mimo-v2.5-pro | 1.74 | 3.48 | 0.0145 | — | single |
| cline-pass/minimax-m3 | 0.30 | 1.20 | 0.06 | — | single |
| cline-pass/qwen3.8-max | 2.00 | 6.00 | 0.25 | 2.50 | cached-write count required |
| cline-pass/qwen3.7-max | 2.50 | 7.50 | 0.50 | 3.125 | cached-write count required |
| cline-pass/qwen3.7-plus | 0.40 / 1.20 | 1.60 / 4.80 | 0.04 / 0.12 | 0.50 / 1.50 | ≤256K / >256K context + cached-write count required |

Source: https://docs.cline.bot/getting-started/clinepass (read 2026-09-24); the table has no official effective timestamp. No production account/API key was used.

## 本地代码事实

- `server.js:2138-2154` 的 `normalizeUsage()` 仅保存 input/output/total/cached-read Token 和其字段存在性；缺失为 `null`，已知 0 是 0。没有 cached-write/token 的独立字段，也无实际账单/价格接口投影。
- `server.js:4276-4282` 的 `/api/statistics` 已按 resolved model 聚合最近 24h usage，但 provider-model 维度只保存成功健康样本；按渠道拆分 Token 需要在原统计 owner 中建立可验证的归属，不能把失败尝试重复记为用量。

## 已确认边界与价格展示口径

- 已确认：使用 ClinePass 官网页面价格做“参考用量等值（USD），非实际扣费”，不是另有上游实际账单来源。优先 Kimi K3、GLM-5.3、DeepSeek V4 Flash/Pro；后两者因峰谷档无法归属，仅在明确 Token usage 完整时显示对应两档的**参考区间**，不静默择一档。其他模型先可展示统计但无可靠定价则不可计算。
- 现有 `normalizeUsage()` 仅支持 input/output/total/cached-read 的存在性；对官网列 Cached Write 费率的 Qwen 模型，缺少独立写入计数时不能可靠计算全价，也不能把该项当零。其余单档且 Cached Write `—` 的模型可在 input、output、cached-read 均明确返回且计数一致时给出参考估值。
- 官网没有价格生效时间。页面与版本快照只能标示本项目采集时间/内部版本和“官方生效时间未知”，不能将采集日伪装成官网生效日。
