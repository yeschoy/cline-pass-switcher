# 总实施计划

## 1. 完成并审阅子任务规划

- [x] 将用户需求和决策收敛到父任务 `prd.md`。
- [x] 记录代码、截图、历史生产事件和本地性能基线。
- [x] 创建三个独立子任务并写明顺序。
- [x] 审阅三个子任务的 PRD、设计、执行计划和上下文清单。
- [x] 用户批准整体规划后，按序执行三个子任务；父任务保持 planning 直至最终集成复核。

## 2. 子任务一：普通日志性能

- [x] 启动 `09-19-optimize-ordinary-jsonl-logs`。
- [x] 先补文件系统调用计数和旧实现性能红灯。
- [x] 实现监听优先、后台恢复、增量段目录、异步追加和局部维护。
- [x] 验证既有 JSONL、查询、游标、保留、安全和 fail-open 契约。
- [x] 同机 5,000 条追加提升 51.12 倍并提交 `d0dbc74`。

回滚点：只回滚该子任务提交；旧 JSONL 文件不迁移、不删除。

## 3. 子任务二：统计与展示

- [x] 启动 `09-19-model-cache-statistics-ui`。
- [x] 先补统计迁移、exactly-once、unknown/zero 和 UI 契约红灯。
- [x] 增加按解析模型的滚动 24h 聚合与覆盖语义。
- [x] 修正 provider harvest/finalProvider 集合和未知展示。
- [x] 增加账号主表摘要并将额度列精简为剩余百分比。
- [x] 自动化与 VM 验证通过并提交 `74913e0`；真实浏览器因基础设施阻塞，残余项已记录。

回滚点：回滚统计/UI 提交；迁移必须保持旧元数据可恢复且不触碰普通日志。

## 4. 子任务三：错误规则

- [x] 启动 `09-19-visual-content-error-rules`。
- [x] 先补配置兼容、匹配顺序、流式边界和草稿 UI 红灯。
- [x] 增加独立内容规则字段与严格 validator/normalizer。
- [x] 在统一规范化失败文本上执行有界、大小写不敏感的首条包含匹配。
- [x] 实现可视化表格与同一草稿的高级 JSON 编辑。
- [x] 自动化与 VM 验证通过并提交 `939b62e`；真实浏览器因基础设施阻塞，残余项已记录。

回滚点：回滚规则子任务提交；既有 `accountErrorRules` 保持原样可用。

## 5. 父任务集成复核

依次运行：

```bash
node --check server.js
for file in lib/*.js; do node --check "$file"; done
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/jsonl-log-store.test.js
node --test test/ui-contract.test.js test/account-draft.test.js test/detailed-log-ui.test.js
node --test test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- [x] 复核所有规范更新和 operator-facing 文档同步。
- [x] 复核无未授权生产操作、无真实数据/凭据进入测试或提交。
- [x] 三个业务提交已推送；父任务最终集成门禁 161/161 通过，待归档任务树。
