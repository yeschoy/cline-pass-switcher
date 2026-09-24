# 模型和渠道统计页面

## Goal

在网页顶层导航现有“详细日志”右侧增加“模型和渠道”页面，按每个模型/渠道展示成功率、缓存率、Token 使用与计费，明确每项数据的口径及可信度。

## Background

- 导航与统计页都在 `public/index.html:124-151`；当前 `/api/statistics` 返回按 resolved model 的最近 24 小时用量聚合，Provider-model 的 24 小时成功健康样本属于另一个现有投影（`server.js:4276-4282`、`test/integration.test.js:1245-1246`）。
- 现有计费数据没有按模型/渠道持久化的账单或单价事实；Token 仅从上游明确 usage 记录，缺失不能估算为 0（`.trellis/spec/backend/quality-guidelines.md` Usage, statistics, and health）。官网 ClinePass 模型价格是每百万 Token **参考费率**，官网明确说包月用户不会逐 Token 付这些价；部分模型又有峰谷/上下文分档（见 `research/official-pricing-and-usage.md`）。

## Requirements

- 清晰展示模型与渠道维度，成功率口径说明样本范围/时间窗/无样本状态；缓存率分别区分有 usage 的 Token 占比与命中请求率。
- 显示有来源的 input/output/total/cached Token，缺失值为未知且提供覆盖量；区分请求终态与渠道尝试，避免一次多渠道重试重复记模型 Token。
- **已确认计费口径**：记录上游明确返回的 Token usage，按 ClinePass 官网参考单价估算金额；页面必须标注 **“参考用量等值（USD），非实际扣费”**。缺失 usage 或可靠官方价格的单元显示不可计算，不能用 $10/$25/$50 社区额度推算渠道成本；缓存读写等分项仅在 usage 与价格都有明确对应时计算。
- 新页面只读，加载/筛选/导航不会清掉账号/路由草稿；服务端字段安全投影，浏览器安全渲染，键盘/移动端可用。

## Acceptance Criteria

- 对同一请求多渠道重试、流式无 usage、明确 0、缓存命中、无渠道归属、成功样本为空分别显示正确口径；估算费用能逐项追溯官方价格来源、币种、适用模型与生效时间，不能计算的显示不可得。
- 页面导航出现在截图指定位置；前端 VM/真实浏览器与本地模拟上游集成测试覆盖数据/无数据及窄屏交互。

## Scope assumptions for design review

- 若当前 usage 不能确定峰谷/上下文分档，则金额显示不可计算，而非猜一个价；无归属渠道的模型请求保留“未知渠道”，不把用量分摊到多次尝试。历史参考金额按请求时有据可查的价格版本冻结，不因官网改价悄悄重算；这些选择在设计评审中核对。
