# 父任务实施计划

## 1. 规划门禁

- [ ] 完成父/子 PRD convergence，确保无阻塞产品问题。
- [ ] 完成四个子任务的 `design.md`、`implement.md` 和 context manifests。
- [ ] 修订既有 `09-20-dynamic-cache-pool-growth` 的设计冲突：其 target/grow owner保留，membership 允许后续按 quota role扩展。
- [ ] 用户评审总体拆分和执行顺序；不要启动父任务。

## 2. 串行执行

1. `09-21-error-detail-log-performance`
2. `09-21-account-rpm-limits`
3. 既有 `09-20-dynamic-cache-pool-growth`
4. `09-21-low-quota-pool-refresh-cooling`
5. `09-21-newapi-chat-keepalive`

每次只 `task.py start` 当前实现 owner。完成 focused/full check、spec update和独立 commit后再进入下一项。

## 3. 跨任务集成检查

- [ ] error detail off/on/full 三种模式无重复、无敏感 ordinary 字段。
- [ ] concurrency failure 不消耗 RPM；真实 provider retries 每次消耗；RPM-only 阻塞不扩池。
- [ ] dynamic target 持久化、低槽固定、高槽随扩容增加，额度角色不足有真实投影。
- [ ] low account-scope failure -> quota hold -> high fallback -> refresh/exhaustion/recovery。
- [ ] keep-alive/SSE heartbeat 不改变 attempt 数、RPM、usage、错误规则、日志或 lease finalization。
- [ ] 客户端取消、首包前失败、起流后失败、账号替换和 shutdown 保持 exactly-once。

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

另外运行临时目录/local mock性能与连接复用验证，记录 ordinary queue、error-only/full capture、metadata finalization、事件循环延迟、HTTP连接数和SSE静默段事实；不访问生产。

## 5. 完成

- [ ] 复核 backend/frontend/cross-layer specs。
- [ ] 父任务只在全部子任务和既有 dynamic dependency完成后做最终集成评审。
- [ ] 按 Trellis Phase 3 更新规格、提交、归档和记录 journal。
- [ ] 生产部署、开关启用和旧产物清理需另行授权。
