# 父任务实施计划

## 1. 规划门禁

- [x] 完成父/子 PRD convergence，确保无阻塞产品问题；部分成功快照的 unknown/恢复语义已按父需求澄清。
- [x] 完成四个子任务的 `design.md`、`implement.md` 和 context manifests（均已归档）。
- [x] 既有 `09-20-dynamic-cache-pool-growth` 保留 total target/grow owner；成员资格由低额度子任务扩展，不持久化第二份成员表。
- [x] 用户批准串行任务执行；父任务仅在四个子任务合入 `main` 后启动集成验收。

## 2. 串行执行

1. `09-21-error-detail-log-performance`
2. `09-21-account-rpm-limits`
3. 既有 `09-20-dynamic-cache-pool-growth`
4. `09-21-low-quota-pool-refresh-cooling`
5. `09-21-newapi-chat-keepalive`

每次只 `task.py start` 当前实现 owner。完成 focused/full check、spec update和独立 commit后再进入下一项。

## 3. 跨任务集成检查

- [x] error detail off/on/full 三种模式无重复、无敏感 ordinary 字段。
- [x] concurrency failure 不消耗 RPM；真实 provider retries 每次消耗；RPM-only 阻塞不扩池。
- [x] dynamic target 持久化、低槽固定、高槽随扩容增加，额度角色不足有真实投影。
- [x] low account-scope failure -> quota hold -> high fallback -> refresh/exhaustion/recovery。
- [x] keep-alive/SSE heartbeat 不改变 attempt 数、RPM、usage、错误规则、日志或 lease finalization。
- [x] 客户端取消、首包前失败、起流后失败、账号替换和 shutdown 保持 exactly-once。

交叉场景与变异判别、性能事实见 `research/cross-task-acceptance-check.md`；真实 Chrome 375px 的抽屉、错误详情与焦点/键盘 5/5 证据见 `research/browser-verification.md`。

## 4. 最终验证

```bash
node --check server.js
for file in lib/*.js; do node --check "$file"; done
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/jsonl-log-store.test.js
node --test test/detailed-log-capture.test.js test/detailed-log-store.test.js test/detailed-log-ui.test.js
node --test test/ui-contract.test.js test/account-draft.test.js
node --test test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

最终 Node26 项目门禁：**242/242**；server/lib 语法、生产内联脚本 VM、普通/详细日志聚焦测试、UI 草稿、integration、`git diff --check` 均通过。临时目录/local mock 的 ordinary queue、error-only/full capture、metadata finalization、事件循环延迟、HTTP 连接数和 SSE 静默段事实见交叉检查报告；这些同机样本不是跨机性能阈值，也不证明 CPU 脱敏真正非阻塞。不访问生产。归档的 New API 子任务还记录官方 SHA256 校验的 Node18.20.8 全量 **241/241**；本父任务新增用例未在 Node18 重跑。

## 5. 完成

- [x] 复核 backend/frontend/cross-layer specs，修正过时的 Node18 验证表述；README 的 RPM 诊断措辞已与代码对齐。
- [x] 父任务在四个子任务和既有 dynamic dependency 均完成并合入 `main` 后进行了最终集成评审。
- [x] Trellis Phase 3 规格复核、集成测试与文档已分别提交（`1fd8e35`、`7b02dfd`）；归档与 journal 由接续脚本完成。
- 生产部署、开关启用和旧产物清理需另行授权，本轮未执行。
