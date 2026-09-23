# 总体技术设计：上游诊断、账号限流、热池调度与长连接兼容

## 1. 范围与所有权

本父任务不直接实现业务代码，负责统一需求、子任务边界、依赖顺序和最终跨层验收。实现继续复用现有 owner：

```text
server.js
  ├─ account lease / provider attempts / quota jobs / metadata
  ├─ HTTP transport / SSE lifecycle
  └─ management APIs / static console
lib/jsonl-log-store.js
  └─ ordinary request/error projections
lib/detailed-log-capture.js + lib/detailed-log-store.js
  └─ opt-in full detail + new error-only detail profile
public/index.html
  └─ account drafts, scheduling controls, logs and detail viewer
```

不引入框架、数据库、共享限流服务、第二套日志存储、第二个额度调度器或 New API 代码改动。

## 2. 任务拆分与依赖

| 顺序 | 任务 | 责任 |
|---|---|---|
| 1 | `09-21-error-detail-log-performance` | 错误详情开关、错误页联动、队列边界、重复 metadata 写入优化、日志 drain |
| 2 | `09-21-account-rpm-limits` | `maxRpm` 配置、并发优先的 RPM 预留/提交、每真实 Chat attempt 计数 |
| 3 | 既有 `09-20-dynamic-cache-pool-growth` | `cachePoolMaxSize`、持久化 target、只扩不缩；仍由原父任务拥有 |
| 4 | `09-21-low-quota-pool-refresh-cooling` | 高/低额度成员组成、低额度优先、刷新驱动冷却、耗尽状态 |
| 5 | `09-21-newapi-chat-keepalive` | HTTP/1.1 连接复用、SSE 心跳、首事件/流空闲超时 |

共享 `server.js`、`public/index.html` 和 integration tests，必须串行执行和提交。低额度热池依赖 RPM 的可调度判定及既有动态 target；不能与前两项并行写入。

## 3. 跨子任务数据流

### 3.1 请求准入与真实 attempt

```text
hard eligibility
  -> cache membership / quota role
  -> maxConcurrent check
  -> reserve first RPM slot
  -> lease
  -> create ClientRequest + commit RPM at req.end()
  -> reserve+commit one slot before every provider retry
  -> classify attempt result
  -> account/provider action
  -> release lease (RPM committed facts never refund)
```

并发检查永远先于RPM。首次permit保证账号选中后可发一个attempt；后续retry没有permit时立即本地429，不重新等待或换号。RPM exhaustion不触发动态池扩容；动态扩容只由所有活跃账号都具有有限并发且同时`blockedBy=concurrency`触发，mixed/RPM block均不grow。

### 3.2 额度角色与恢复

额度快照仍由现有 quota job owner 获取和规范化：

- `hot`: 最大已用比例 `<80%`，作为高额度兜底；
- `warm`: `80%.. <95%`，作为低额度消耗层；
- `reserve`: `>=95%`，不进入常规活跃池；
- `unknown`: 保持未知，不伪装为 0 或高额度。

池target来自既有min/max/metadata grow-only owner。`cachePoolLowQuotaSize=0`时完全绕过role-aware membership并保留基线priority/ID成员；大于0时固定该数量的warm槽，其余target为high槽。低层可准入时确定性优先，受并发/RPM/quota disposition阻塞时立即回退high，不等待低层；known candidate不足时unknown最后补位并投影真实组成。

只有low角色快照上最终`account/degrade`设置持久化`waiting-refresh`并产生独立request-local removal outcome。下一次真实额度刷新决定解除、继续hold或转为`quota-exhausted`。启用role-aware pool后，最新成功快照的任一已知窗口100%（即使partial）都设置exhausted；到最早有效未来`resetsAt`后重评，只有真实成功且三个窗口齐全、均低于100%才恢复；部分非100%仍属未知，不改写人工`enabled`。

### 3.3 错误诊断

普通 JSONL 继续只保存安全索引事实。新 `errorDetailLogging` 开关开启时，将每个真实失败 attempt 的脱敏 Header 和有界正文发布到现有 detailed store：

```text
ordinary error row (requestId + attemptIndex + optional detailProfile/callId intent)
  -> authenticated detailed API
  -> attempt metadata / on-demand body
```

native chat attempt token由request-local transport owner统一分配，full/error/off不改变索引。full detail与error-only共用一个request owner；full开启时不重复发布。非流式复用已读响应字符串，SSE只保留错误事件或“已起流后中断”事实，不复制完整成功流。capture intent不代表durable；group 404统一显示安全的详情不可用原因集合。

### 3.4 New API Chat 链路

```text
New API shared HTTP/1.1 pool
  -> switcher inbound keep-alive
  -> switcher explicit direct/proxy keep-alive agent
  -> Cline SSE
  -> switcher post-start ': PING' comments
  -> New API scanner resets idle timeout and ignores comments
```

首个合法 data 事件前保留现有 failover 门禁；起流后才发心跳。首事件期限与已起流后的上游空闲期限分离。HTTP/2/h2c、Realtime WebSocket 和 Responses API 不实现。

## 4. 配置与兼容

- 新布尔开关缺失时为 false；旧部署不扩大敏感数据面。
- `maxRpm` 缺失/0 表示不限。旧客户端省略该字段时，服务端按稳定账号 ID 保留既有值。
- `cachePoolMaxSize` 缺失时等于 `cachePoolSize`；`cachePoolLowQuotaSize` 缺失时为 0。
- 新建/预设启用低额度池时 low 槽默认 1；旧配置不自动改变流量。
- 新 quota hold/exhausted 状态只存在于 metadata，和人工 disabled、hard quarantine、固定 cooldown 分开投影。
- malformed/unreadable config/metadata 仍启动失败且不覆盖原字节。

## 5. 性能与失败隔离

- ordinary projection先限制单条reason/record，再序列化并进入pending record/byte fence；超限只丢诊断。
- error-only 模式不复制 ingress body、成功 body 或完整 SSE。
- 同一请求终态的 statistics + record metadata mutation 合并一次原子保存；不得创建多个异步 snapshot writer。
- detailed/ordinary/metadata 写失败均 fail-open，不改变响应、重试、健康归因或 lease 释放。
- graceful shutdown先停止新接入/调度，保持store可写并等待active request finalizer；随后fence新日志、drain stores，最后destroy agents/sockets。总deadline到期才强制abort/exit，不能被长流或blocked writer无限阻塞。

## 6. 验证与回滚

每个子任务先跑 focused tests，再跑全项目 gate并独立提交。父任务最终执行跨功能场景：低额度账号取得 lease、多个 Provider attempt 消耗 RPM、失败详情可查、账号进入 quota hold、高额度接管、SSE 心跳通过 New API 等价 scanner。

配置级回滚：关闭 error detail；`maxRpm=0`；`cachePoolLowQuotaSize=0`；`cachePoolMaxSize=cachePoolSize`；关闭 SSE heartbeat。旧二进制不认识新字段，生产回滚必须配套发布前 config/metadata 备份；本任务不执行部署。
