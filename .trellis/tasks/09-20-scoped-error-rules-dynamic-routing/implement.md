# 父任务执行计划

本父任务拥有需求源、子任务顺序和最终集成；子任务串行实现并各自完成检查/提交。未经用户审阅规划，不启动任何任务。

## 1. 规划与上下文

- [x] 完成需求访谈和现状调研。
- [x] 定义统一规则、成功率、Provider 选择和动态热池契约。
- [x] 建立三个独立可验收子任务。
- [x] 完成 parent/children 的 PRD convergence pass。
- [x] 为 parent/children 写入 `design.md`、`implement.md` 和 research/spec context manifests。
- [x] 运行 `task.py validate` 并提交全部 Trellis 规划文件（2026-09-22 复验通过，仅剩既有的大文件注入警告）。
- [x] 向用户展示最终任务地图和关键决策，等待实施批准。

实际执行顺序（用户批准的“范围 A”）：子任务 A → 子任务 C → 子任务 B，串行写入 `server.js`/`public/index.html`；另在 C 之后插入一个独立稳定性任务。三个子任务均已完成检查、spec 同步、提交与归档，并在 2026-09-22 合入 `main`。

## 2. 子任务 A：统一规则与成功率

目标任务：`09-20-scoped-error-rules-success-rate`

- [x] 完成统一 `errorRules` schema、duration/reset parser、legacy migration 和 old-client 409 边界。
- [x] 完成 account / provider-model cooldown + hard quarantine owners 和恢复 API。
- [x] 升级 statistics，建立两套24小时 `success/(success+degrade)` owner 和 coverage。
- [x] 迁移三步账号流水线与账号成功率排序。
- [x] 更新管理 UI、预设、advanced JSON、健康显示和恢复控件。
- [x] 聚焦测试、全量门禁、spec 更新、提交并归档子任务。

依赖：无；必须先完成，因为 B/C 消费它提供的 canonical state/rate/pipeline contract。

回滚点：配置迁移与 statistics 版本写入前；新 schema 一旦持久化，旧二进制回滚必须使用备份。

## 3. 子任务 C：单渠道健康重试

目标任务：`09-20-provider-success-retry-selection`

- [x] 将 Provider planner 改为逐次选择，而不是预先固定完整顺序。
- [x] strict 首次按用户顺序，后续排除已尝试项并按 provider-model rate。
- [x] preferred/智能从首次起按 rate，候选 configured → discovered；无候选仅一次 compat auto。
- [x] 保持 singleton `only`、account Authorization、maxRetries、stream/cancel 边界。
- [x] 更新 route UI/帮助、日志策略枚举和集成测试。
- [x] 聚焦测试、全量门禁、spec 更新、提交并归档子任务。
- [x] 追加范围（由生产排查确认）：规则动作→直接健康样本 0/1/1/1 语义、独立 `retryRules` 停止策略、配对“无效 system 消息”手动预设、策略/重试日志证据。

依赖：子任务 A 的 Provider state/rate projection 和规则 action contract。

回滚点：Provider planner/injection；不得以 gateway multi-provider order 作为回滚手段。

## 4. 子任务 B：动态热池扩容

目标任务：`09-20-dynamic-cache-pool-growth`

- [x] 增加 `cachePoolMaxSize` 严格配置与 target-size metadata owner。
- [x] 实现 all-active-full → wait → recheck → grow-one → lease。
- [x] 保持 priority/ID membership、hard eligibility、reserve、quota refresh owner 和 HRW 边界。
- [x] 将账号 rate sorting 限于 active 内部，不改变 membership/expansion candidate order。
- [x] 更新管理 UI、raw scheduling、presets、roles/diagnostics。
- [x] 覆盖并发竞争、restart、explicit clamp、no-shrink 和旧配置 inert 行为。
- [x] 聚焦测试、全量门禁、spec 更新、提交并归档子任务。

依赖：子任务 A 的三步 pipeline、account hard state 和 success projection。

回滚点：设置 max=size 可配置关闭扩容；旧代码回滚仍需 config/metadata 备份。

## 5. 父任务最终集成

- [x] 重新激活父任务，核对三个子任务提交均已合入当前分支且工作树干净。
  - 子任务 A：`cb19f2e` + `1008fc8`；子任务 C：`c952406` + `f12bd64`（merge `3a4e9e6`）；子任务 B：`e6cd568` + `bb974c4`（merge `04138c3`）。当前分支 `main`，工作树干净。
  - 额外保障：`6cc2393` + `6c9cf8e`（测试稳定性，merge `33fe025`）已合入；spec 已固化“语义预算 vs 同步预算”测试契约。
- [x] 执行跨层数据流审查：config → API/UI → runtime state → statistics → routing → logs。
- [x] 检查账号 health pipeline 与 Provider health planner 没有交叉读取。
- [x] 检查规则 first-match、默认 degrade、cooldown/quarantine 和 retry classification 相互独立；并确认 `retryRules` 停止决策只控制重试、不隐式改变健康。
- [x] 检查动态 target、hard-state replacement、Provider retry、`retryStop` 与所有 lease/finalizer exactly-once。
- [x] 完成 README、`config.example.json` 和相关 backend/frontend specs 的统一收敛。
- [x] 运行最终全量质量门禁：

```bash
node --check server.js
for file in lib/*.js; do node --check "$file"; done
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- [x] 若交互式 rule editor、Provider recovery、pipeline reorder 或 responsive layout 发生变化，补充真实浏览器的键盘、焦点、对话框和窄屏证据。
  - 已完成：真实 Chrome + CDP 可信输入事件，13/13 通过（含 420px 窄屏、真实键盘录入、真实拖拽 drovre/drop、配对预设取消/确认、Provider 恢复真实激活）；详见 `research/browser-verification.md`。未发现产品缺陷，也未发现不可达控件。
- [ ] 运行最终 full-scope `trellis-check`、spec review 和父任务提交。

## 6. 验收追踪

- AC1–AC4：子任务 A 所有，父任务复核日志/安全交叉边界。
- AC5：子任务 A 负责三步迁移/账号 rate；子任务 B 负责动态池。
- AC6–AC7：子任务 C。
- AC8：A/C/B 分别覆盖统计、stream/provider、lease；父任务做端到端复核。
- AC9：子任务 A。
- AC10：每个子任务局部门禁 + 父任务最终全量门禁。
- 追加（生产排查后新增，归子任务 C）：动作→直接健康样本 0/1/1/1、`retryRules` 首个命中即停止与健康动作独立、配对手动预设、策略/重试日志证据；父任务复核其与 R1/R2 的一致性。
