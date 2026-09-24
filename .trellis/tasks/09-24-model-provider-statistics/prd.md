# 模型和渠道统计页面

## Goal

在网页顶层导航现有“详细日志”右侧增加“模型和渠道”页面，按每个模型/渠道展示成功率、缓存率、Token 使用与计费，明确每项数据的口径及可信度。

## Background

- 导航与统计页都在 `public/index.html:124-151`；当前 `/api/statistics` 返回按 resolved model 的最近 24 小时用量聚合，Provider-model 的 24 小时成功健康样本属于另一个现有投影（`server.js:4276-4282`、`test/integration.test.js:1245-1246`）。
- 现有计费数据没有按模型/渠道持久化的账单或单价事实；Token 仅从上游明确 usage 记录，缺失不能估算为 0（`.trellis/spec/backend/quality-guidelines.md` Usage, statistics, and health）。官网 ClinePass 模型价格是每百万 Token **参考费率**，官网明确说包月用户不会逐 Token 付这些价；部分模型又有峰谷/上下文分档（见 `research/official-pricing-and-usage.md`）。

## Requirements

- 清晰展示模型与渠道维度，成功率口径说明样本范围/时间窗/无样本状态；缓存率分别区分有 usage 的 Token 占比与命中请求率。
- 显示有来源的 input/output/total/cached Token，缺失值为未知且提供覆盖量；区分请求终态与渠道尝试，避免一次多渠道重试重复记模型 Token。
- **已确认计费口径**：记录上游明确返回的 Token usage，按 ClinePass 官网参考单价估算金额；页面必须标注 **“参考用量等值（USD），非实际扣费”**。用户两次描述的优先范围合并为 `cline-pass/kimi-k3`、`cline-pass/glm-5.3`、`cline-pass/deepseek-v4-flash`、`cline-pass/deepseek-v4-pro` 四个官网模型 ID；其他模型仍可展示有证据的统计，未支持价格不可计算，不能当零。官网没有单独的“GLM 5.3 Flash”模型 ID。缺失 usage 或可靠官方价格的单元显示不可计算，不能用 $10/$25/$50 社区额度推算渠道成本；缓存读写等分项仅在 usage 与价格都有明确对应时计算。
- 新页面只读，加载/筛选/导航不会清掉账号/路由草稿；服务端字段安全投影，浏览器安全渲染，键盘/移动端可用。

## Acceptance Criteria

- 对同一请求多渠道重试、流式无 usage、明确 0、缓存命中、无渠道归属、成功样本为空分别显示正确口径；估算费用能逐项追溯官网来源、币种、适用模型、本项目价格快照版本/采集日，并明确官方生效时间未知，不能计算的显示不可得。DeepSeek V4 Flash/Pro 在峰谷条件未知时只给两档参考金额形成的区间，绝不输出声称实际档位的单一金额。
- 页面导航出现在截图指定位置；前端 VM/真实浏览器与本地模拟上游集成测试覆盖数据/无数据及窄屏交互。

## Scope assumptions for design review

- 无归属渠道的模型请求保留“未知渠道”，不把用量分摊到多次尝试。历史参考金额按请求时有据可查的价格版本冻结，不因官网改价悄悄重算。官网未提供各价格的官方生效日期，须如实标注本项目采集时间/内部版本与“官方生效时间未知”。DeepSeek V4 Flash/Pro 的峰谷档无法从现有 usage 可靠判定，按用户重点需要定价的目标采用**明确标注的峰谷参考区间**，不静默择一档，不称为实际扣费；若 usage 不完整仍不可计算。其他分档模型与缓存写入证据不足的模型首版不报价。
