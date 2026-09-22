# 技术设计：测试时钟依赖消除

## 1. 根因分类与对策

| 类别 | 现象 | 对策（原则） |
|---|---|---|
| A. 与真实开销同量级的注入截止 | `CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'80'` 在负载下先于 mock 回包被接纳而到期 → `refreshed` 少 1 | 把"截止语义"与"发布完成"解耦：先对**每个账号进入 `quota.refresh.state` 的期望状态**做条件等待，再放行响应；截止值改为负载下有裕度的预算（并断言"到期后 ≤ 裕度内结束"而不是硬等值） |
| B. 固定睡眠当同步点（32 处） | `setTimeout(20/30/100/110/510)` 假设"这么久之后状态一定到了" | 替换为对可观测状态的 `waitUntil`（计数、`state`、文件字段、trace 长度）；确需保留的睡眠加注释 + 上界 |
| C. 固定 5s `waitUntil` 预算（97 处） | 负载下条件本身在 5s 内不可能成立（等的是后续睡眠触发的状态） | 先修"等错对象"；对确实需要更长的等待显式传 `timeoutMs` 并说明理由；不得全局放大默认值来掩盖问题 |
| D. 重 CPU 夹具 | `the 50,000 account-minute union cap …` 生成 50k cell 并整体 `JSON.stringify`，10 并发文件下拖长 | 复用既有测试钩子先例（`CLINE_PASS_TEST_PROVIDER_HEALTH_CELL_LIMIT` / `CLINE_PASS_TEST_MODEL_CELL_LIMIT`）把上限调小到"仍能证明原子淘汰与 coverage 标记"的最小规模；若不可行则减少 fixture 构造开销（复用对象、避免重复序列化） |

## 2. 同步点规则（本任务建立，供后续沿用）

1. 一个测试里的每次"推进"都必须由**可观测状态**驱动：要么 mock 侧已收到请求/连接计数变化，要么服务端投影（`/api/statistics`、`/api/accounts`）或磁盘产物（`metadata.json`）已经出现目标值。
2. 禁止"睡眠 → 断言"两段式；如必须等待时间流逝（例如验证冷却/过期），必须断言**时间的可观测后果**（`cooldownUntil`、`resetsAt`、`state` 变化）而不是睡眠时长本身。
3. 时间预算分两类，不得混用：
   - **语义预算**（被测产品行为要求：绝对截止、冷却时长、TTL）：由 `CLINE_PASS_TEST_*` 注入，取值必须与真实开销差一个数量级；
   - **同步预算**（等待测试环境就绪）：由 `waitUntil` 的 `timeoutMs` 表达，取值按负载上限设定，失败信息必须包含等待条件。
4. 断言墙钟耗时的用例（`:1355`、`:1790`）保留语义，但给出裕度与明确失败信息；裕度取值需在负载协议下有实测依据。

## 3. 不变量清单（修复过程中必须原样保留，逐条在报告中对账）

- 同账号页面需求合并为一次上游调用；离开的页面 owner 不取消其他 owner 的工作。
- 全局活动上游配额调用 ≤ 2；批量过载（16 页批次上限）不放大上游并发。
- 绝对截止到期后请求以安全失败结束且不接收迟到响应。
- stale generation / 禁用 / key 轮换的完成不得发布快照、样本或 backoff。
- 取消不产生 health/statistics/错误行副作用；终态为 `499 / client_cancelled`。
- 配额快照的 5 分钟成功缓存、15 分钟路由新鲜度、失败 backoff、`force:true` 只绕过成功缓存。
- 50k cell 原子淘汰 + `coverage`/`incompleteAt` 标记；provider/model cell 上限独立。
- 错误规则的动作→样本矩阵（0/1/1/1）与 hard quarantine 持久化。

## 4. 验收协议（可复现）

```
# 空载
for i in 1 2 3; do env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test; done   # 3× 全绿

# 有界负载（每次运行前起负载，运行结束 kill；负载 75s 后自退）
for i in 1 2 3; do
  for n in $(seq 1 10); do (node -e 'const t=Date.now();while(Date.now()-t<75000){Math.sqrt(Math.random())}' &) ; done
  sleep 1
  env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
  pkill -f 'Math.sqrt'   # 注意：不要用 pkill -f 'while(Date.now()-t<75000)'，括号是正则分组，pkill 会因非法正则静默失败
done
# 收尾必须确认：pgrep -f 'Math.sqrt' | wc -l 为 0
```

判据：6 次运行全部 `fail 0`，且用例数 ≥ 194。运行后确认无残留负载进程（`ps` 计数为 0）。

## 5. 风险与回滚

- 风险：把截止预算调大可能让测试失去判别力（例如不再能证明"未等满 15s 就提前结束"）。缓解：只要断言仍比较"到期时间点之后的收敛行为"而不是绝对常量，判别力保留；实现阶段必须为每个调整给出"修前失败/修后通过"的反向验证。
- 风险：条件等待写错会变成永久挂起。缓解：所有 `waitUntil` 必须显式给出与场景匹配的预算与失败信息；禁止无预算的忙等。
- 回滚：本任务只改 `test/**`（必要时 `server.js` 测试钩子），`git revert` 单个提交即可回到当前状态；不得触碰产品默认值，因此无运行时回滚需求。
