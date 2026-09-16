# 额度解析与可排序流水线 — 父任务计划

1. [x] 用户复核父任务和两个子任务的 PRD/设计/计划，明确批准开始。
2. [x] 启动并完成 `09-16-quota-reset-time-precision`：实现、focused tests、完整检查和独立结果记录。
3. [x] 在额度子任务通过且没有并发写者后，启动并完成 `09-16-sortable-account-pipeline`：配置/迁移、执行语义、UI/草稿、focused tests、浏览器检查和完整检查。
4. [x] 父任务执行 combined diff review，确认额度恢复真实参与可排序 `quotaPool`，默认顺序无行为变化。
5. [x] 更新经验证的规范和用户文档；用户已在实现完成后明确授权部署远程服务器。

父任务集成验证：

```bash
node --check server.js
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/account-draft.test.js test/ui-contract.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

停止条件：任何生产数据访问、真实额度变更、Key 输出、并发任务覆盖、无法保持旧配置默认行为或无法定义的排列语义，都必须停止并向用户报告。
