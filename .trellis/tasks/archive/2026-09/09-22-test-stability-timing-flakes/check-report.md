# Check Report — 09-22 测试稳定性（消除时钟/负载依赖 flake）

检查范围：未提交工作区改动
- `server.js`（+1/−1：`CLINE_PASS_TEST_ACCOUNT_MINUTE_CELL_LIMIT`）
- `test/integration.test.js`（+35/−16）
排除：`.trellis/spec/**`、task 目录内容、其他未改动文件。
检查者在本轮额外改动 1 行（见 §6 问题 1，已重新验证全量）。

---

## 1. 结论

**通过（Accepted）**，附 1 处低危修复（`waitUntil` label）与 1 份残留风险清单。

- 3 个已知 flake 的根因均被独立定位并通过**变异实验**证明「修前失败 / 修后通过」；
- 未放宽任何断言、未删除/跳过任何用例，断言数 +2（新增同步断言）；
- 空载 7 次、10 进程负载 5 次、20 进程强负载 1 次全量运行，全部 `194 pass / 0 fail`；
- 无残留负载进程；工作区除 `server.js` + `test/integration.test.js` 外无其他改动。

---

## 2. 环境与执行过的命令

- Node `v26.8.1`，`os.availableParallelism()=10`，提交基线 `2c25cc7`。
- 本次检查执行的命令（关键结果见括号）：

| 命令 | 结果 |
|---|---|
| `node --check server.js`、`for f in lib/*.js; do node --check $f; done` | OK |
| `git diff --check` | clean |
| inline `<script>` VM 语法校验（AGENTS.md 中的一条） | OK |
| 空载 `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test` ×3（修复前）+ ×1（label 修复后） | 194/194 ×4，耗时 26.7–29.7s |
| 10 进程 CPU 负载全量 ×1（修复前）+ ×1（修复后） | 194/194 ×2，37.9–39.3s，`pgrep -f Math.sqrt` 收尾为 0 |
| 20 进程 CPU 负载全量 ×1 | 194/194，40.3s |
| 聚焦：`--test-name-pattern='50,000 account-minute union cap\|canonical scoped error rules\|shared quota admission coalesces'` ×3 | 3/3 pass ×3 |
| 交付方已跑（本轮复核日志一致）：空载 ×3、10 进程负载 ×3、反向复现 ×1 | 见 §4 证据表 |

- 日志：`/tmp/check-evidence/*.log`（本轮）与 `/tmp/stab-*.log`（交付方）。

---

## 3. 计数与等价性（不缩减覆盖）

| 指标 | HEAD | 工作区 | 说明 |
|---|---|---|---|
| `test/integration.test.js` 顶层 `test(` | 69 | 69 | 无减少 |
| `assert.` 调用数 | 1323 | **1325** | +2（新增 `aborted page owners settle as aborted` ×2） |
| `skip`/`todo`/`only` | 0 | 0 | 无 |
| `waitUntil` 调用点 | 102 | 104 | 默认 `timeoutMs=5000` 未变，仅新增可选 `label` |
| 固定睡眠 `new Promise(…setTimeout…)` | 计数 `20ms`×13、`110ms`×1、`510ms`×1 | `20ms`×10、命名有界 helper×1、无 110/510 | 4 处替换/删除，1 处命名兜底 |
| 全量用例数（`npm test`） | 194 | 194 | 无减少 |

50k 用例断言等价性：逐条比对 **11 → 11**，一一对应，仅把规模常量 `50000→cap=3`、`a50000→a3`；
`cells.size`、`accounts/health/accountHealth.a0 === undefined`、`accounts+accountHealth[fresh]`、
`droppedAccountMinuteCells===1`、`accountIncompleteAt/accountHealthIncompleteAt.a0===minute` 全部保留。

---

## 4. 变异检查证据（每条：变异 → 期望 → 实际）

所有产品代码变异都用备份文件恢复（未用 `git checkout`）；收尾 `diff /tmp/w-server.bak server.js` = identical。

### 4.1 绝对截止断言的判别力（最高优先）

`test/integration.test.js:1809`：`assert.ok(elapsed < 2*QUOTA_DEADLINE_MS+1000, …)`

| # | 变异 | 期望 | 实际 |
|---|---|---|---|
| A2 | 测试注入 `CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'15000'`（=生产默认，等效移除短截止），临时把用例 `{timeout:10000}` 放宽到 60000 以便断言先于用例超时触发 | 断言失败并打印实际耗时 | **失败**：`absolute quota deadline took 30014ms (budget 3000ms = two 1000ms job batches plus 1000ms load margin)`（日志 `mut-a2`）。若不放宽用例超时，失败形式是用例 10s 超时（同样失败） |
| A3 | `server.js: QUOTA_GLOBAL_LIMIT 2 → 1`（串行化，暴露「应有 2 个批次」的判别力） | 该用例失败 | **失败**：`Error: condition timeout: condition (5000ms)` —— 由 `await waitUntil(()=>active===2)` 守卫（两条活动传输/合并不变量）先触发 |
| 余度实测 | 把预算临时改为 `elapsed<-1` 强制失败以打印真实耗时（20 进程负载） | 输出真实 elapsed | `elapsed = 2007ms`，预算 3000ms → **1.5× 余度**（下限 2×1000ms 之上还有 ~993ms）。日志 `mut-elapsed` |

结论：断言仍能发现「无短截止 / 截止被串行化」，同时 1000ms 的语义截止相比真实开销（本机 ~5–20ms）有 1–2 个数量级余度。

### 4.2 被删除的 `setTimeout(510)`（成功缓存过期）不等于断言巧合

| # | 变异 | 期望 | 实际 |
|---|---|---|---|
| B1 | 测试注入 `CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'500' → '10000'`（缓存窗口内不会过期） | 路由侧刷新拿不到 key-b 的上游 hold 请求，同步点超时 | **失败**：`Error: condition timeout: condition (5000ms)`（日志 `mut-b1`）。证明 `refreshed:3` / `percentUsed:77` 依赖「路由任务真的打到 mock 上游」，不是缓存恰好过期造成的巧合 |
| B2 | `server.js: withdrawRoutingQuotaOwnership()` 去掉 `if (!quotaJobHasOwner(job))` 守卫，无条件 `cancelQuotaJob(job)`（模拟"路由关闭连带取消页面 owner 的任务"） | `refreshed` 不再是 3 | **失败**：`test/integration.test.js:1817` `1 !== 3`（`assert.equal(sharedResult.json.refreshed,3)`，日志 `mut-b2`） |

补充机制说明：`server.js:2614` 测试环境调度器每 10ms 重排一次，`server.js:1207` 把 `nextAttemptAt` 设为 `lastSuccessAt + QUOTA_SUCCESS_MS`；因此删除 510ms 睡眠后，`waitUntil(key-b hold)` 会把「缓存到期 + 调度重试」这段延迟（实测 ~500ms）吸收进 5s 预算内，而不是靠固定睡眠。

### 4.3 `canonical scoped error rules`（`test/integration.test.js:2568`）根因

根因是**读日志投影的发布竞态**，不是"5s 预算不够"：
- `server.js:2183` `void Promise.all(writes);` —— 普通日志写入相对响应是 fire-and-forget（`lib/jsonl-log-store.js:342` 经 `this.queue` 异步落盘）；
- `lib/jsonl-log-store.js` `query()` 先 `_assertReady()`，目录仍初始化时抛错 → 路由返回 **503 `{"error":{"message":"ordinary logs initializing"}}`（无 `items` 字段）**；
- 原代码 `page.items[0]?.status` + `setTimeout(20)` 两种写法都会在负载下炸。

| # | 变异 | 期望 | 实际 |
|---|---|---|---|
| D1 | `lib/jsonl-log-store.js` `_mutate` 注入 200ms 发布延迟 + **新** waitUntil 版本 | 通过 | **pass 1 / fail 0**（日志 `mut-d1`） |
| D2 | 同上延迟 + **旧** `setTimeout(20)` 版本 | 失败 | **fail 1**：`TypeError: Cannot read properties of undefined (reading '0')`（日志 `mut-d2`） |
| D3 | 同上延迟 + 只把 `coolingLog` 的 `page.items?.[0]` 改回 `page.items[0]` | 失败 | **fail 1**：`TypeError …reading '0'`；探针实测响应 `status=503 body={"error":{"message":"ordinary logs initializing"}}` |
| D4 | 同上延迟 + 新代码（`page.items?.[0]`） | 通过 | **pass 1 / fail 0** |

结论：`page.items?.[0]` 与 `waitUntil(ruleId==='provider-combined')` 都是**功能性**修复（把"还没发布/暂时 503"与"已发布"区分开），不是风格改写。

### 4.4 50k → cap=3 的等价性（原子淘汰 + coverage 标记）

| # | 变异 | 期望 | 实际 |
|---|---|---|---|
| C1 | `server.js:1956` 只 `delete bucket.accounts[id]`（不再同时删 `health`/`accountHealth`） | 失败 | **失败**：`test/integration.test.js:1649` `4 !== 3`（`assert.equal(cells.size,cap)`）→ 直接证明断言仍在检查**跨三张表的原子淘汰** |
| C2a | 去掉 `coverage.accountIncompleteAt[id] = …` | 失败 | **失败**：`actual: undefined, expected: 29835036` |
| C2b | 去掉 `coverage.accountHealthIncompleteAt[id] = …` | 失败 | **失败**：`actual: undefined, expected: 29835036` |

两个 coverage 标记各自被独立断言守护；`droppedAccountMinuteCells===1` 亦保留。

### 4.5 `server.js` 测试钩子行为（实测启动矩阵）

在 `metadata.json` 中预置「1 个 bucket、4 个 account cell」后启动 `node server.js`（`DATA_DIR=/tmp/hookcheck`）：

| 环境 | 结果 |
|---|---|
| `NODE_ENV=test CLINE_PASS_TEST_ACCOUNT_MINUTE_CELL_LIMIT=3` | **拒绝启动**：`Error: statistics account-minute cell limit exceeded`（`server.js:731`） |
| `NODE_ENV=test`（不设变量） | 正常启动 → 默认仍是 50000（= 生产值） |
| `NODE_ENV=production` + `…LIMIT=3` | 正常启动 → 钩子被忽略 |
| `NODE_ENV` 未设置 + `…LIMIT=3` | 正常启动 → 钩子被忽略 |
| `NODE_ENV=test …LIMIT=4` | 正常启动（4 ≤ 4） |
| `NODE_ENV=test …LIMIT=abc` / `…LIMIT=0` | 正常启动（`Number(...)||50000` → 50000） |

结论：仅 `NODE_ENV==='test'` 且显式设置时生效；非 test 分支是常量 `50000`，与 `CLINE_PASS_TEST_MODEL_CELL_LIMIT` / `CLINE_PASS_TEST_PROVIDER_HEALTH_CELL_LIMIT` 现有形态一致，不改变生产路径。

---

## 5. `design.md` §3 不变量逐条对照

| # | 不变量 | 守护断言（工作区行号） | 结果 |
|---|---|---|---|
| 1 | 同账号页面需求合并为一次上游调用；离开的 owner 不取消其他 owner 的工作 | `:1804` `waitUntil(active===2)` + `assert.equal(total,2)`；`:1805` `waitUntil(rows.length===4)`；`:1806` `assert.equal(survivor.json.refreshed,4)`、`assert.equal(total,4,'same-account page demand is coalesced')`；`assert.equal(active,2,'one page leaving must not cancel work owned by other pages')` ×2；新增 `firstLeaving/secondLeaving.aborted===true` | ✅（B2 证伪） |
| 2 | 全局活动上游配额调用 ≤ 2；批量过载（16 页批次上限）不放大上游并发 | `:1804`、`:1806` `assert.equal(maxActive,2)`；`:1807` `waitUntil(statuses.includes(429))`、`statuses.filter(429).length===1`、`waitUntil(active===0)`、`assert.ok(maxActive<=2,'batch overload never widens upstream admission')` | ✅（A3 证伪） |
| 3 | 绝对截止到期后安全失败且不接收迟到响应 | `:1809` `assert.equal(slow.json.failed,4)`、`elapsed<2*QUOTA_DEADLINE_MS+1000`（含预算说明）；`stats.accounts.every(errorCategory==='timeout')` | ✅（A2 / 交付方反向复现 `2 !== 4` 证伪） |
| 4 | stale generation / 禁用 / key 轮换的完成不得发布快照、样本或 backoff | `:1811` `disabled.refresh.reason==='disabled'`、`disabled.lastSuccessAt===before.lastSuccessAt`、`five_hour.percentUsed===before`；`:1817` `percentUsed===77`；`total===totalAfterRoutingOff` | ✅ |
| 5 | 取消不产生 health/statistics/错误行副作用；终态 `499 / client_cancelled` | 未改动用例 `:218–222`（`status===499`、`result==='client_cancelled'`、`/api/logs/requests?result=client_cancelled` 行数） | ✅（全量绿） |
| 6 | 快照 5 分钟成功缓存 / 15 分钟路由新鲜度 / 失败 backoff / `force:true` 只绕过成功缓存 | 未改动用例 `:1783+`（`{ok:true,refreshed:1,cached:1,…}`、`deferred`、`nextAttemptAt`）与 `:1828/1845/1859/1876` | ✅（全量绿） |
| 7 | 50k cell 原子淘汰 + `coverage`/`incompleteAt` 标记；provider/model cell 上限独立 | `:1649`（`cells.size`、三表 `a0` 消失、`fresh` 存在、`droppedAccountMinuteCells`、两个 `incompleteAt`）；provider cell 独立用例未改动 | ✅（C1/C2a/C2b 证伪） |
| 8 | 错误规则动作→样本矩阵（0/1/1/1）与 hard quarantine 持久化 | `:2597` `degrade===0 / successes===1`；`:2598` post-start 不重放；`:2599` 重启后 `hardQuarantined===true`；`:2603` 账号级 `account-hard` scope 规范化；`:2602` `matchedBy=['status','body','header','provider','model']` 与敏感值不泄漏 | ✅（全量绿） |

无断言放宽：`elapsed<500 → elapsed<2*QUOTA_DEADLINE_MS+1000` 是**随语义截止同步放大**的预算（80ms→1000ms 截止），
判别力由 A2/A3 与「20 进程负载下 elapsed=2007ms」共同证明仍然成立；`page.items[0] → page.items?.[0]` 只是让轮询不抛异常，不改变被断言的取值。

---

## 6. 问题清单

### 已修复（本轮，1 行，test-only）

1. **[低] 关键同步点缺少失败信息（`test/integration.test.js:1815`）**：`waitUntil(()=>rows.some(row=>row.phase==='hold'&&row.auth==='Bearer key-b'&&!row.closed))` 是本次改动**新承担**的同步点（吸收了被删除的 510ms 睡眠 + 调度重试延迟），但超时信息只有默认 `condition timeout: condition (5000ms)`。已补 label：
   `…,5000,'routing-owned key-b quota job reached the mock upstream after the success cache expired'`。
   影响：仅诊断信息；未改断言、未改预算、未改语义。修复后重跑全量空载 194/194、10 进程负载 194/194。

### 复核确认无缺陷（保留）

2. `OWNER_DETACH_WINDOW_MS = 50`（`:143–146`）是**有上界的负向窗口**，并且已用 `await pending[0]`（客户端 settle）+ 后续正向断言 `refreshed===4` 双重加固；服务端无"取消已处理"的可观测投影，注释已说明（与 `design.md` 一致）。相对旧的 20ms 窗口是**加强**。
3. `waitUntil(async()=>…nextAttemptAt<=Date.now(),10000,'quota failure backoff elapsed')` 取代 110ms 睡眠：等待可观测量（投影字段），预算 10000ms vs 50ms 注入 backoff，余度充足；backoff 语义本身仍由未改动用例断言（`deferred` + `hits.length` 不变）。
4. 未改动用例整体绿（194/194，6 次不同负载条件下），无跨用例夹具污染。

---

## 7. 残留同类风险清单（**本次未改**，按要求仅登记）

### 7.1 「与真实开销同量级的注入截止」

| 位置 | 注入 | 分类 | 说明 |
|---|---|---|---|
| `test/integration.test.js:1748` | `CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'80'`（同处 `SUCCESS_MS:'50'` / `FAILURE_MS:'50'` / `STALE_MS:'120'`） | **语义时间 + 被当同步用** | mock 的 `finish` 定时器为 30ms，客户端截止 80ms → 仅 50ms 余度；`phase='success'` 下若 30ms 回包在负载中被推迟过 80ms，会翻成 `timeout`，`waitUntil(status==='fresh')` 将 5s 超时。本协议下未复现，但机制成立。**建议下一步**：把 `TIMEOUT_MS` 提到 1000（语义不变，断言都等可观测状态），或把 mock 的 30ms 与 80ms 的关系写死为显式契约 |
| `:1027 / :1097 / :1317 / :1364 / :1828 / :1845 / :1859 / :1876` 的 `QUOTA_SUCCESS_MS/FAILURE_MS/STALE_MS/TIMEOUT_MS` 取 50–5000ms | 语义时间 | 这些用例的同步点已是 `waitUntil`/可观测状态；500/1000ms 相对本地 RTT 仍有 1–2 个数量级余度，不属"同量级" |
| `:1368` | `assert.ok(elapsed<200,…)` | 语义墙钟断言（fail-fast 429） | 未被本次改动触及，协议下未失败；若日后 flake，按 `design.md` §2.4 重设预算 + 失败信息 |

### 7.2 「固定睡眠后读正/负向投影」——与 flake #2 同类（未证明在负载下失败，故未改）

- **正向（负载下可能失败，值得关注）**：
  - `:994` `setTimeout(30)` → `/api/logs/requests` 后 `logs.items[0].resolvedModel`（`items` 为空会 TypeError，与 D2 完全同型）
  - `:1036` `setTimeout(20)` → `logs.items.some(x=>x.category==='proxy')`
  - `:1578` `setTimeout(20)` → `capacityLogs.items.some(x=>x.selectedQuotaPool==='reserve'&&x.capacityFallback===true)`
  - `:1582` `setTimeout(20)` → `stickyLogs.items.some(x=>x.selectionReason==='pipeline-sticky-primary')`
  - 建议：统一改为 `waitUntil(… items?.[0]/some …, label)`，语义不变，只是把"20ms 足够"换成"直到发布"。
- **负向（负载只会让它更容易通过，不构成 flake 源）**：`:622`、`:998`、`:1319`(80ms)、`:1327`(100ms)、`:1737`、`:1756`、`:1760`、`:1762`(各 120ms)、`:1817`(100ms)。
- **有意的语义时间（TTL/过期）**：`:1481`/`:1483`(180ms)、`:1484`(330ms)、`:1487`(80ms)（配 `CLINE_PASS_TEST_BINDING_TTL_SCALE`）。
- **顺序 nudge（10–35ms）**：`:377`、`:523`、`:525`、`:701`、`:759`、`:791`、`:978`、`:985`、`:1034`、`:1619`、`:1626`、`:1631`、`:1816`、`:1850`、`:1865` 及 `disconnectRequest()` 的 20ms socket 销毁定时器——这些是"让服务器观察到某事件"的短窗口，不是发布完成同步点。
- 另：`test/integration.test.js` 中仍有 30 个未带 label 的 `waitUntil`（默认 `condition timeout: condition (5000ms)`）——属既有风格，本次按最小改动纪律未批量改造。

---

## 8. 加速比与耗时

| 指标 | HEAD | 工作区 |
|---|---|---|
| 50k 用例单跑（含 node 启动） | 1.12–1.26s | **0.084–0.086s**（≈13×） |
| 50k 用例框架计时（20 进程负载） | — | **110.8ms**（fixture 从 50001 账号/50000 cell 降到 4 账号/3 cell） |
| 共享准入用例（空载） | — | 2887–2910ms（用例自身 `{timeout:10000}`，20 进程负载下 2952ms） |
| 全量 `npm test` 空载 | ~35s（取证基线） | 26.7–29.7s |
| 全量 `npm test` 10 进程负载 | ~77s（取证基线，含 1 例失败） | 37.9–39.3s，0 失败 |
| 全量 `npm test` 20 进程负载 | — | 40.3s，0 失败 |

收尾：`pgrep -f 'Math.sqrt' | wc -l` = 0；无残留 `node server.js` 进程；`git status --short` 仅 `server.js`、`test/integration.test.js`、task 目录。

---

## 9. 给主会话的建议

1. 本改动可提交；如需进一步降低 flake 面，按 §7.2 的 4 处正向「睡眠 + 读日志」做一轮 `waitUntil` 化（另立小任务，不建议在本任务范围内扩大）。
2. `.trellis/spec/**` 是否需要写入"测试同步点规则"（同步预算 vs 语义预算、禁止睡眠→断言）请按 §Phase 3.3 决定；本报告可直接作为素材。
3. 临时证据（`/tmp/check-evidence/`、`/tmp/mut-*.mjs`、`/tmp/w-*.bak`、`/tmp/head-integration.test.mjs`）等待主会话确认后清理；仓库内无中间产物。
