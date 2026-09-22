# Flake 取证记录（只读，2026-09-22）

## 环境

- 仓库：`cline-pass-switcher`，被测提交：`2c25cc7`（分支 `feat/provider-success-retry-selection`）
- Node：`v26.8.1`；CPU：10
- 测试入口：`npm test` → `node --test`（**默认并行**，跨测试文件并发度 = `os.availableParallelism()` = 10）
- 夹具：`test/integration.test.js` 内 `waitUntil(check, timeoutMs = 5000)` 每 5ms 轮询一次（`test/integration.test.js:125`）

## 1. 空载基线（4 次连跑）

| 运行 | 结果 |
|---|---|
| 1 | 194 pass / 0 fail |
| 2 | 194 pass / 0 fail |
| 3 | 194 pass / 0 fail |
| 4 | 194 pass / 0 fail |

日志：`/tmp/flake-run-1..4.log`（收尾时清理）

## 2. 受控负载复现（1 次即中）

复现命令（负载为 10 个 CPU 占位进程，75s 后自退，已 kill 清理）：

```bash
for i in $(seq 1 10); do (node -e 'const t=Date.now();while(Date.now()-t<75000){Math.sqrt(Math.random())}' &) ; done
sleep 1
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
```

结果：**193 pass / 1 fail**，总耗时 77.4s（空载约 35s）。

```
test at test/integration.test.js:1777:1
✖ shared quota admission coalesces page owners, enforces two live transports and uses an absolute deadline (367.268375ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  3 !== 4
      at TestContext.<anonymous> (file://…/test/integration.test.js:1788:114)
```

命中断言（`test/integration.test.js:1788` 第 114 列起）：

```js
const survivor=await pending[2]; … assert.equal(survivor.json.refreshed,4);
```

失败时用例仅运行 367ms（用例自带 `{timeout:10000}`）。

## 3. 机制判断（待实现阶段证实）

该用例为 4 个账号注入**墙钟绝对截止**：

- `test/integration.test.js:1782` → `CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'80'`、`CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'500'`、`CLINE_PASS_TEST_QUOTA_FAILURE_MS:'50'`
- 服务端消费点：`server.js:2420` `QUOTA_TIMEOUT_MS = NODE_ENV==='test' ? Math.max(20, env值 || 15000) : 15000`

用例在 `await waitUntil(()=>active===2)`、若干 `setTimeout(20)` 之后分两批放行 mock 响应。CPU 被抢占时 80ms 绝对截止先于第 4 个（或第 3 个）账号的回包被接纳而到期，于是 `refreshed` 少 1。

即：**断言本身正确（不变量是"同账号合并 + 两槽上限 + 绝对截止"），但测试用 80ms 这种与真实开销同量级的墙钟预算去同步"发布完成"，负载下不成立。**

## 4. 历史 flake（来自本会话两个独立代理的运行报告，均未留原始日志）

| 用例 | 现象 |
|---|---|
| `canonical scoped error rules match status/body/header, isolate state, persist hard quarantine and project direct rates`（`test/integration.test.js:2549`） | 一次运行中 `waitUntil` 5s 超时（默认预算） |
| `the 50,000 account-minute union cap evicts an aggregate/health cell atomically and marks coverage`（`test/integration.test.js:1621`） | 一次运行中失败；fixture 生成 50,000 个 cell 并整体 `JSON.stringify`，属重 CPU 用例 |

## 5. 风险面量化（`test/integration.test.js`）

| 模式 | 数量 |
|---|---|
| 固定 `setTimeout` 睡眠（`new Promise(r=>setTimeout…`） | 32 |
| `waitUntil(...)` 轮询点（默认 5s 预算） | 97 |
| 墙钟耗时断言（`elapsed<200` / `elapsed<500`） | 2 处（`:1355`、`:1790`） |
| 测试注入的时间旋钮（`CLINE_PASS_TEST_QUOTA_*`） | TIMEOUT 7 / SUCCESS 10 / STALE 2 / FAILURE 4 |
| 其他测试专用上限钩子 | `CLINE_PASS_TEST_PROVIDER_HEALTH_CELL_LIMIT`、`CLINE_PASS_TEST_MODEL_CELL_LIMIT`、`CLINE_PASS_TEST_BINDING_TTL_SCALE` |

既有可用于缩小夹具规模的测试钩子先例：`CLINE_PASS_TEST_PROVIDER_HEALTH_CELL_LIMIT` / `CLINE_PASS_TEST_MODEL_CELL_LIMIT`（`server.js`）。

## 6. 结论

- 根因类别：**测试同步依赖墙钟**（固定睡眠 + 与真实开销同量级的 deadline + 固定 5s 轮询预算），在并行文件（10 进程）与外部 CPU 竞争下不成立。
- 需要修复的最小集合：上述 3 个已知 flake 的同步点；同时建立"关键路径条件等待"的通用规则，避免同类复发。
- 验收必须包含**有界负载协议**，否则空载全绿无法证明修复（空载 4/4 本来就绿）。
