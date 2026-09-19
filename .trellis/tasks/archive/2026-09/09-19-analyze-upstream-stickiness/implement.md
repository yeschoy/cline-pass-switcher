# 双层亲和与 Provider 故障治理实施计划

## 0. 开始门禁与工作树隔离

- [ ] 等待 `09-19-model-cache-statistics-ui` 完成并合入当前分支；读取其最终 verification、`server.js`、`public/index.html`、tests 和已更新 specs。
- [ ] 重新执行 `git status --short`，冻结本任务拥有路径；不得覆盖当前 25 个未提交路径中的其他任务修改。
- [ ] 重新加载 backend/frontend/cross-layer spec，并核对 `META.statistics` 当前版本与 request-log schema。
- [ ] 对 `server.js`、`public/index.html`、`test/` 搜索所有 session、prompt key、usage、provider status、probe/validate/test 调用方。
- [ ] 本计划和 PRD/design 经用户审阅后才运行 `task.py start`。

阻塞规则：模型缓存任务未合入或共享文件仍有无法归属的未提交修改时，不开始代码编辑。

## 1. 红灯：Chat 身份、上游 key 与安全日志

在 `test/integration.test.js` 增加失败用例：

- [ ] Codex parent、turn metadata parent、body `prompt_cache_key`、session header、thread header 的优先级和 `keyType/confidence`。
- [ ] Claude parent-agent、session header、agent header、结构化 metadata parent/current 的优先级。
- [ ] parent/child/subagent 与同值通用载体继续命中相同账号；request ID 不建立亲和。
- [ ] caller `prompt_cache_key` 与 `session_id` 逐字保留且不覆盖。
- [ ] 缺少 body key 的显式 Codex/Claude 请求收到稳定派生 `prompt_cache_key`；多轮、provider retry、账号 replacement 使用同一派生值。
- [ ] `message_hmac` 和无键请求不注入 `prompt_cache_key`。
- [ ] preferred/order 日志标记 override；strict/automatic 事实正确。
- [ ] 非流、流式最终 usage 分别产生 `cacheHit=true/false/null`；失败、取消、容量拒绝为 null。
- [ ] 普通 JSONL/API/history/metadata/响应/控制台输出不包含任何 fixture raw key、派生 key 或 HMAC fingerprint。

在 `test/ui-contract.test.js` 或现有生产脚本 VM 契约中增加：

- [ ] 请求日志主表显示亲和类型、上游 key 来源和缓存三态；所有服务端枚举经安全映射/escape。
- [ ] 旧记录缺字段显示未知，导航/分页/stale guard 不变。

先运行聚焦测试并确认旧实现失败。

## 2. 实现：身份与 prompt key

- [ ] 扩展 `firstIdentity()` / `hmacIdentity()` 的返回事实，不改变现有 fingerprint 算法和 parent 优先级。
- [ ] 为每个候选赋予精确 `keyType` 与 `confidence`；保持 `sessionSource` 兼容字段。
- [ ] 新增纯 `prepareChatAffinity()` helper：验证 caller 字段、保留已有值、仅为显式 Codex/Claude 派生域分离 `prompt_cache_key`。
- [ ] 在 `handleChat()` 中只准备一次 outbound Chat body；账号替换/provider retry 复用，不在 attempt 内重新生成。
- [ ] 确保原始 ingress body 仍供 detailed capture 正确观察，派生后的 outbound body 进入现有 account-bound transport/detailed call capture，不创建第二传输路径。
- [ ] 不向 body 注入 Claude metadata、原始 session、fingerprint 或新未知字段。

聚焦检查：

```bash
node --check server.js
node --test test/integration.test.js --test-name-pattern='session|affinity|prompt cache|sticky'
```

回滚点：若 caller 字段兼容、账号替换或详细捕获边界不能保持，撤销本阶段，不继续日志/UI。

## 3. 实现：普通请求日志与 UI

- [ ] 在一次最终 request projection 中加入安全枚举/布尔与 `cacheHit` 三态；不改 error-attempt projection。
- [ ] 所有 `recordChat()` 结局携带同一 affinity facts；usage 只从已有规范化终态传入。
- [ ] 更新 logging allowlist/spec；明确“字段存在”不等于远端采用，“cacheHit”只来自明确 usage。
- [ ] 控制台主表显示安全标签，旧行兼容；如增加过滤器，服务端严格只接受枚举/布尔并补测试。
- [ ] 验证普通日志保持 bounded projection，详细日志仍是唯一 body/header exception。

聚焦检查：

```bash
node --test test/jsonl-log-store.test.js test/ui-contract.test.js test/account-draft.test.js
node --test test/integration.test.js --test-name-pattern='log|usage|cache|session|affinity'
```

## 4. 红灯与实现：账号作用域 provider 校验

- [ ] 为 `/api/probe`、`/api/validate-upstreams` 增加 accountId 成功、未知 400、不可用 409、满载 429 测试。
- [ ] 证明 probe+harvest、一个 validation 批次固定同一账号并使用同一 proxy/Authorization；provider 候选间不轮询账号。
- [ ] auth/proxy/account quota 错误不会写入全局 provider bad/auth；明确 provider 结果才更新共享 status。
- [ ] checkedAt TTL 过期后排序/预览视为 unknown；启动/读取旧 metadata 兼容。
- [ ] 抽取复用现有管理账号 lease helper，替换 probe/validate 的 `pickAccount()`，finally 释放。
- [ ] GET/API 投影不返回 Key、proxy、Header 值或原始错误 body。

聚焦检查：

```bash
node --test test/integration.test.js --test-name-pattern='probe|validate|account|proxy|provider'
```

## 5. 红灯与实现：缓存优先一键流程

- [ ] 服务端 proposal 仅返回 bounded channel/status/策略建议，不保存。
- [ ] 三个建议策略的候选顺序、exclude、pinMode/sort 语义有纯测试。
- [ ] UI 选择账号与模型后执行 probe/validate，展示 proposal；取消不写配置，测试只发明确测试请求，确认才调用 `/api/config`。
- [ ] 保存使用完整 route shape，账号 scope 不覆盖全局或其他账号；成功后重载服务器状态。
- [ ] UI 原生 dialog/focus/keyboard/aria-live、错误处理和窄宽滚动遵循现有模式。

聚焦检查：

```bash
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/ui-contract.test.js test/account-draft.test.js
node --test test/integration.test.js --test-name-pattern='proposal|probe|validate|config'
```

回滚点：一键流程可单独撤销，不影响阶段 2/3 的 Chat 亲和与日志。

## 6. 设计复核后实现：Provider cooldown / half-open

此阶段在前述指标可观测并经一次单独设计复核后执行；不与阶段 2–5 混成一个不可回滚提交。

- [ ] 扩展共享 route normalizer：`providerCooldownMs` 为 0–300000 整数，默认 0；全局/账号 complete override、old-client preserve、API strict validation、UI draft、example/docs 同步。
- [ ] 红灯覆盖默认 0 与旧行为六模式/attempt sequence 等价。
- [ ] 在 provider routing owner 内增加有界 runtime Map，按 account/model/provider 隔离。
- [ ] 只让允许的首包前 provider 错误进入 cooldown；账号/参数/取消/首包后错误均不进入。
- [ ] TTL 内跳过 provider；到期单 owner half-open；成功清除，失败固定/有界延长。
- [ ] 全部候选冷却且 half-open 已占用时返回明确、可重试的安全错误，不自动切账号、不绕过 exclude、不首包后重放。
- [ ] 配置保存/账号删除/model route 删除清理对应 runtime state；Key/proxy rotation 不把旧运行结果复活。
- [ ] request log 增加安全 action/reason/延迟，不记录 provider 原始错误 body之外的新敏感事实。

聚焦检查：

```bash
node --test test/integration.test.js --test-name-pattern='provider cooldown|half-open|failover|cancel|stream'
```

## 7. 聚合指标（依赖模型缓存任务最终 schema）

- [ ] 在现有 statistics owner 中追加 session source、provider fallback/首选失败、cooldown/half-open 计数；不新建统计 store。
- [ ] 保持每请求 exactly-once、未知/零、coverage 与 overflow 语义。
- [ ] 管理/probe/validate/test 不进入 Chat 缓存统计；setup 自身只进入管理诊断。
- [ ] API/UI 只展示产品需要的安全聚合，避免高基数 account×model×provider 无限展开。

## 8. 文档、spec 与全量验证

- [ ] 更新 `README.md`：Chat 范围、Codex/Claude key 优先级、message HMAC 局限、strict/preferred/auto 差异、日志不显示实际 key。
- [ ] 更新 `config.example.json`：补 `cachePoolSize`；阶段 6 实施时补 `providerCooldownMs: 0`。
- [ ] 更新 backend quality/logging/persistence 与 frontend state/quality specs；不覆盖并行任务的未提交知识。
- [ ] 执行完整门禁：

```bash
node --check server.js
for file in lib/*.js; do node --check "$file"; done
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/ui-contract.test.js test/account-draft.test.js test/detailed-log-ui.test.js
node --test test/jsonl-log-store.test.js
node --test test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- [ ] 对请求日志新列和一键 dialog 执行真实浏览器桌面/390px、键盘、焦点和横向滚动检查；若环境阻塞，报告准确阻塞，不伪称通过。
- [ ] 检查 git diff 只包含本任务拥有的路径/区块，不包含 NewAPI、生产配置、账号数据或并行任务未提交修改。

## 9. 提交与部署边界

建议拆分提交：

1. `feat: add chat prompt affinity diagnostics`
2. `feat: add account-scoped provider setup`
3. `feat: add provider circuit breaker`（仅阶段 6 单独复核后）
4. 对应 specs/docs 可与各功能提交同批或作为紧邻 docs 提交。

不推送、不部署。生产验证需要新的独立部署任务与明确授权；本任务本地通过不能证明缓存命中率提升。

## 10. Completion status

- Phases 0–8 implementation and automated gates are complete in the isolated `feat/upstream-session-affinity` worktree.
- Full project gate: 162/162 tests passed; syntax, embedded-script compilation, example JSON and `git diff --check` passed.
- Real-browser interaction/layout remains unverified because `agent_browser` is unavailable on PATH; exact evidence is in `research/verification.md`.
- No NewAPI/CPA/production change or live/paid model request was performed.
