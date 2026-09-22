# 测试稳定性：消除集成测试时钟/负载依赖 flake

## Goal

让 `test/integration.test.js` 的失败只反映产品行为回归，而不是机器负载：消除"用墙钟当同步点"的模式，使已知 3 个 flake 在有界负载压测下稳定通过，同时**不放宽任何既有断言、不减少用例、不跳过任何用例**。

## Background

本任务来自实现/检查流程中的观察：同一个提交在空载下连续 4 次全量 `npm test` = 194/194，但在 10 个 CPU 占位进程的受控负载下一跑即复现 1 个失败（`test/integration.test.js:1788`，`refreshed` 3 ≠ 4）。另有两个历史上偶发失败的用例（5s `waitUntil` 超时、50k 单元重 CPU 用例）。

取证见 `research/flake-evidence.md`（复现命令、失败片段、风险面量化）。

根因类别：测试用**墙钟**做同步 —— 固定 `setTimeout` 睡眠（32 处）、与真实开销同量级的注入截止（如 `CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'80'`）、固定 5s `waitUntil` 预算（97 处）。`node --test` 默认按 CPU 并行测试文件（10 进程），外部负载会把这些预算推到临界之外。

## Requirements

1. **不变量优先**：不得通过放宽/删除断言、`skip`、加大被测语义容差来"修" flake。每个被测不变量（同账号需求合并、两路活动传输上限、绝对截止、批量过载不放大上游并发、stale generation 丢弃、取消无副作用、失败记账等）必须原样保留并在报告中逐一列出。
2. **只改测试与既有测试钩子**：允许修改 `test/**`；若必须新增测试钩子，只能沿用既有 `CLINE_PASS_TEST_*` 模式（仅 `NODE_ENV==='test'` 生效、默认值等同生产行为、不得改变生产路径）。不改变产品超时/退避/默认值。
3. **关键路径改为条件等待**：新增的每个同步点必须等待**可观测状态**（内存计数、`refresh.state`、HTTP 响应、`metadata.json` 字段、trace 行数等），固定睡眠只能作为有上界的兜底并注明原因。
4. **墙钟预算必须留有负载裕度**：与"真实开销"同量级的注入截止（例如 80ms）不得再充当发布完成的同步手段；若断言的是截止语义本身，预算必须显著大于负载下的真实开销，并给出明确的失败信息。
5. **已知 3 个 flake 必须定位根因并修复**（不接受"重跑就过"）：
   - `test/integration.test.js:1777` `shared quota admission coalesces page owners, enforces two live transports and uses an absolute deadline`（已复现）
   - `test/integration.test.js:2549` `canonical scoped error rules …`
   - `test/integration.test.js:1621` `the 50,000 account-minute union cap …`
6. **修复必须可证伪**：每个修复点要给出"修复前会失败 / 修复后稳定"的证据；能回退验证的要做一次反向复现，不能的要在报告中说明原因。
7. **覆盖不缩减**：用例总数与断言数量不得减少（允许为新增同步点增加断言/等待）。

## Acceptance Criteria

- [ ] **有界负载协议下**连续 3 次全量 `npm test` 全部 0 失败。协议固定为：10 个 CPU 占位进程（`node -e` 空转 75s）+ `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test`，用例数保持 194 或更多，且负载进程在每次运行后清理干净。
- [ ] 空载连续 3 次全量 `npm test` 全绿（用例数不减少）。
- [ ] 3 个已知 flake 各自的根因与修复在报告中给出文件:行、机制、修前/修后证据。
- [ ] `test/integration.test.js` 中不存在"与真实开销同量级的墙钟截止被当作发布完成同步点"的残留；所有新增/保留的固定睡眠都有有界理由。
- [ ] 既有不变量清单逐条对照通过（报告中列出）；无断言放宽、无用例删除/跳过。
- [ ] `node --check server.js`、`git diff --check` 通过；`git diff --stat` 仅涉及 `test/**`（若新增钩子则仅限 `server.js` 的 `CLINE_PASS_TEST_*` 分支）。

## Out of Scope

- 改变生产超时、退避、配额准入、错误规则、路由等任何产品语义或默认值。
- 引入 CI 流水线、测试框架替换、mock 库或新依赖。
- 为提速而重构被测产品代码结构。
- 其他测试文件（除非某个 flake 证明根因在其内部依赖的共享夹具中，需在报告中说明）。
- 生产部署。
