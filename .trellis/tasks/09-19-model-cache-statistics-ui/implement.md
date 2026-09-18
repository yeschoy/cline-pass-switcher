# 模型缓存统计与展示实施计划

## 1. 基线与红灯

- [ ] 读取 backend/frontend/cross-layer specs 和父任务 research。
- [ ] 冻结工作树，排除用户现有未提交路径。
- [ ] 在 integration 中加入 v1 迁移、模型 exactly-once、别名、未知/0、coverage 和 provider 发现失败用例并确认旧实现失败。
- [ ] 在 UI/VM 测试中加入模型列、账号摘要和“只显示剩余”契约红灯。

## 2. 统计 v2

- [ ] 扩展 create/validate/migrate/prune statistics，增加 models bucket 与独立覆盖上限。
- [ ] 迁移 v1 时保留原字段并原子保存；损坏/未来版本仍 fail-closed 且不覆盖原 bytes。
- [ ] 给 request-scoped finalizer 固定注入 resolved model ID，并把 global delta exactly-once 合并到模型 bucket。
- [ ] 增加 model range/project helper 和 `/api/statistics.models` 安全数组。

回滚点：统计测试未通过时只回滚 schema/finalizer 改动，不继续 UI。

## 3. 上游发现

- [ ] 统一 harvest 的字符串/结构化错误提取。
- [ ] 严格过滤 provider slug，集合包含实际 `finalProvider`。
- [ ] 增加明确 discovery 状态并保持校验状态独立。
- [ ] 覆盖 planner/direct、结构化 envelope、无 list 和已有 metadata 的回归。

## 4. 账号与模型 UI

- [ ] `loadAll()` 并发读取模型所需统计并绑定到 `DATA`，不得触碰统计页面 generation owner。
- [ ] 模型表增加 24h 缓存 Token 占比/覆盖列，处理无数据、已知 0、积累中和转义。
- [ ] `/api/accounts` 增加按 ID 的只读摘要；`renderAccounts()` 展示缓存、健康、24h/累计失败。
- [ ] 确认 `collectAccounts()` 不提交任何运行统计字段。
- [ ] 把 quota 窗口文案改为仅剩余百分比和重置时间，预测函数不变。

## 5. 验证

依次运行：

```bash
node --check server.js
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/ui-contract.test.js test/account-draft.test.js
node --test test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- [ ] 真实浏览器检查桌面和 390px：横向滚动、未知/0、重复名称、搜索草稿、额度文案。
- [ ] 更新 backend/frontend specs；如 API/operator 文档暴露字段则同步 README。
- [ ] 只提交本子任务拥有的代码、测试、spec 和 Trellis 文件。
