# 缓存活跃池部署独立核验 — 2026-09-17

## 结论

- **当前部署即时硬门禁通过。** 生产仍运行 release `20260917-092017-cbdee55-cache-pool`，固定源为 `cbdee55f1b78fdc41a69bfa9773ff73798b63057`，容器 exact image ID 为 `sha256:b0833b3491f4c7dbfa2c7e83ed5ebdebc84d7f97280960e53cbd475a65e852d2`。
- **当前生产状态健康：** running / healthy、RestartCount=0、OOMKilled=false；最近 500 行有界日志未命中 fatal、配置/metadata 读取失败、未捕获异常或持久化失败指示。
- **配置与角色符合批准范围：** 仅有 `cachePoolSize=2`、等待时间 2000→5000、两个选中账号 priority 100→1/2 四项语义差异；两个任务别名仍为 active，其余 5 个启用账号为 standby，2 个禁用账号角色为 null。
- **可以由主会话安排后续只读复核。** 精确目标时间确认是 `2026-09-18T11:36:42.243000Z`。当前仍不能声明命中率达到 70%，任务必须保持 `in_progress`，直到正式窗口结束且至少有 1,000 个明确 cache 样本。
- 本次核验只执行本地读取/测试和远程只读 SSH、Docker inspect/logs、认证 GET/API 与网络查询；**未发送任何 POST**，未修改配置、Compose、deployment、容器、镜像、NewAPI、CPA，也未创建计划任务。

## 1. 固定源与不可变镜像

- 本地 HEAD 精确为固定源提交，并包含功能/文档前置提交。
- 从固定提交重新生成 allowlisted archive：
  - 文件数：12；成员严格限制为既定 allowlist；
  - SHA-256：`cf11f46027c8ef87d44f166bf5d526b220e9c25508781b26a436ae5457b2ac65`；
  - 远端 `source.tar`、本地重建 archive 与部署记录三方一致；
  - release 文件清单摘要：`89b99b22ecc1f3d75a0131293b7a33b4f7e80f76b2de235d3f797b1b47d36767`。
- release 目录 12 个文件全部与固定提交哈希一致；运行容器中的 `server.js`、`public/index.html` 和三个安全模块哈希也全部一致。
- 本地独立验证：`node --check` 通过，完整测试 **146/146 通过**，`git diff --check HEAD` 通过；部署 allowlist 与 `test/` 相对 HEAD 无工作树差异。
- 当前镜像 tag 与容器均解析到目标 exact image ID；`deployment.json` 为有效 JSON，包含 release、完整源提交和 exact image ID，SHA-256 为 `251af647f6636905acf8b735f6a3d5a02105cc51f5e8c1a629f4ca979dcdbd80`。

## 2. Compose、迁移和运行状态

- 当前 `compose.yml` SHA-256：`4428a6f5541e08b679e879abda745f54987c7a9e155d01388e4a503ed94c16c9`。
- 对切换前备份做规范化 Compose 比较，唯一差异为：
  - `services.cline-pass-console.image`；
  - `services.cline-pass-console.build.context`。
- 当前 build context 精确指向本 release。
- 构建证据、禁网复制数据迁移预演和当前容器均使用同一 exact image ID。
- 迁移预演唯一差异为新增 `accountPipeline.cachePoolSize=0`；预测哈希在代码切换后精确命中。
- 容器启动时间为 `2026-09-17T09:31:46.774558024Z`，独立核验时仍为 running / healthy、0 restart、非 OOM。

## 3. 配置事务和活跃池角色

切换前备份配置 SHA-256 为 `698b889a12b2ef6463a57d78b20ac2dc266799c75f47035dd4f2040bb51d6354`；当前配置 SHA-256 为 `808ac0a541d99efdb79b23dd38ca72f1d49b7706072c8850cd3b82a66ddba1fe`。完整结构差异仅有：

1. `accountPipeline.cachePoolSize`: 缺失 → `2`；
2. `accounts[account#eb683cec24].priority`: `100` → `1`；
3. `accounts[account#ad131bd944].priority`: `100` → `2`；
4. `concurrencyWaitMs`: `2000` → `5000`。

`mode` 原本即为 `sticky`，因此没有无关 mode 差异；账号数仍为 9、启用数仍为 7，其余 pipeline 字段和账号/路由字段无语义差异。

当前安全角色投影：

- `account#eb683cec24`：priority 1，active，health available，quota fresh/hot；
- `account#ad131bd944`：priority 2，active，health available，quota fresh/hot；
- 其余 5 个启用账号：standby；
- 2 个禁用账号：role null。

任务别名通过 T0 有序脱敏投影与未改变的稳定 ID 顺序连接，未输出原始 ID。

关于“一次配置 POST”的证据：

- `config-diff.json.postCount=1`；
- `report.json.postCount=1`；
- 对保留的 `activate.py` 做 AST 检查，仅存在一个 `/api/accounts` POST 调用点，另一个调用点为 GET；
- 最终配置差异、应用时间和角色结果均与该单次事务一致。

这些证据一致支持“恰好一次”；但未保留独立不可变 HTTP access audit，因此无法仅凭当前状态对历史网络调用次数作密码学证明，见残余风险。

## 4. API、内部网络、公开入口和 90 秒稳定性

本次重新执行的只读门禁：

| 门禁 | 结果 |
|---|---|
| `/api/meta` | 200，configured=true，authRequired=true |
| 认证 `/api/accounts` | 200；调用前确认无会触发清理保存的过期 cooldown |
| 认证 `/api/statistics` | 200 |
| 认证 request-log projection | 200 |
| 认证 detailed-log settings | 200 |
| `new-api` 内部 DNS / `/api/meta` | 通过 / 通过 |
| 生产主机公开 DNS | 无 A 地址 |
| 本机公开 DNS | 无 A 地址 |
| 独立 Google DNS-over-HTTPS | DNS 状态成功，但 A 答案为空 |

`/api/models` 的既有 catalog 在本次核验时已超过 1 小时缓存期；重新 GET 会触发上游抓取并写 metadata，因此为严格保持只读，本次没有重放。部署即时、90 秒延迟和先前独立核验均已记录该接口为 200。非法 quota-refresh 400 也只核对保留证据，没有重复发送 POST。

公开入口继续归类为 `dns_unavailable_preexisting`，与切换前、本次生产主机、本机和独立解析器结果一致。

即时门禁时间 `2026-09-17T09:36:42.470159Z`，延迟门禁时间 `2026-09-17T09:38:12.729982Z`，间隔 **90.259823 秒**；延迟门禁再次确认 exact image、健康、0 restart、非 OOM、配置哈希、角色、API、内部网络与既有 DNS 分类。

## 5. T0、激活时间和后续窗口

### T0 重算

`t0-preflight.json.capturedAt=1789637014781` 重算为：

- **T0：`2026-09-17T09:23:34.781000Z`**，与记录值一致。

T0 基线：

- 统计请求：2,405；明确 cache 样本：2,379；命中：1,509；
- 缓存请求命中率：63.4300%；
- 缓存 Token 占比：85.9063%；
- 最终错误：12；失败率：0.4990%；
- 普通请求日志 P95：26,318.7 ms；
- overflow / capacityFallback / switched：0 / 0 / 0。

### 激活时间重算

证据时间序列：

- 最终选择完成：`2026-09-17T09:36:42.228635Z`；
- live `config.json` mtime：`2026-09-17T09:36:42.230237Z`；
- 配置事务完成并记录的策略 T：`2026-09-17T09:36:42.243000Z`。

文件写入与事务完成时间相差约 12.763 ms，顺序合理。部署报告采用事务完成时间作为正式 T；据此重算：

- 预热结束 / 正式窗口开始：`2026-09-17T11:36:42.243000Z`；
- 正式窗口结束 / **T+26h：`2026-09-18T11:36:42.243000Z`**。

后续复核必须使用精确窗口 `[2026-09-17T11:36:42.243000Z, 2026-09-18T11:36:42.243000Z)`，不得用模糊“最近 24 小时”替代。

### 后续判定阈值

- 明确 cache 样本 ≥1,000；
- cache 请求命中率 ≥70%；
- cache Token 占比 ≥82.9063%（相对 T0 最多下降 3pp）；
- 最终失败率 ≤1.4990%（相对 T0 最多上升 1pp）；
- P95 ≤31,582.44 ms（相对 T0 最多恶化 20%）；
- standby overflow / cachePoolFallback <1%；
- 两个 active 不得进入 reserve 或持续 unhealthy。

失败时只生成报告和通知，不得自动修改生产配置。

## 6. 备份、回滚和首次失败证据

- verification、backups、migration-data 目录均为 0700；四项备份均为 0600。
- compose、deployment、config、metadata 四项备份哈希与 backup manifest 全部一致。
- 切换前 old tag 仍精确解析到 `sha256:af7dc2e2ac40edf5b4939e0449e84a4ef077ce8d8a133024252c2333145a1fcd`，该 exact image ID 可 inspect。
- 回滚材料明确要求恢复备份后执行 `docker compose -f compose.yml up -d --no-build`；无需、也不得重建旧 tag。
- 首次失败 release `20260917-084457-cbdee55-cache-pool` 的 release 目录、验证目录、源码哈希、build/switch/rollback 日志、四项备份和失败 Compose 镜像均仍保留；失败后 activation/config-diff/API/delayed/report 文件不存在，与“配置 POST=0、策略未激活”一致。

## 7. 证据安全和一致性

- 扫描 25 个远端安全投影/报告文件：
  - 已知 Key、proxy/admin 值、Header 值和 routing secret 精确命中：0；
  - 原始稳定账号 ID 命中：0；
  - 原始账号名命中：0；
  - Bearer/Basic、私钥头、带认证 URL 通用模式命中：0；
  - JSON 均可解析。
- 20 个本地/远端部署证据文件逐项 SHA-256 一致。
- SSH identity 仅验证固定路径、普通文件、0600、gitignore 和 BatchMode 认证；未读取其内容。
- 工作区仍只有既有 `untitled.md` 删除和两个未跟踪 Trellis 任务目录；本次未触碰 `untitled.md` 或 `.trellis/tasks/09-17-investigate-empty-content-errors/`。

## 8. 差异、限制与残余风险

### 非阻断差异

1. 首次失败尝试的最终 Compose 镜像 `sha256:e53c…d39d` 仍可 inspect，但更早用于迁移预演的直接构建 manifest `sha256:f20f…fc4ca` 当前已不可 inspect。其 archive、release、build log、安装/迁移/回滚证据仍在。这不影响当前 release 或 old exact image 回滚，但若“失败候选镜像全部保留”被解释为两个 manifest 都必须长期可 inspect，则现状与该宽泛表述不完全一致。
2. 当前只读核验没有重放会刷新 metadata 的 `/api/models`，也没有重放任何 POST；相应即时门禁依赖部署时、90 秒延迟和先前独立证据。
3. “一次配置 POST”由双份计数、单一 AST POST 调用点和最终状态共同支持，但没有独立 access audit 可作绝对历史证明。
4. 用户批准发生在会话边界，当前任务文件没有独立的用户批准凭据；主会话应保留该批准上下文。

### 持续风险

- 公开 DNS 仍无 A 记录；这是切换前既有外部依赖故障。
- 流量仍主要使用 `message_hmac` 回退而非 NewAPI 显式稳定会话键。
- 70% 主指标、样本下限和全部 24 小时护栏尚未到判定时间。
- 当前快照和 Compose/config 差异没有显示 NewAPI/CPA 变化，但历史“未修改”是负面事实，无法仅靠事后快照作绝对证明。

## 调度建议

**安全，可以调度。** 主会话应创建一次性、严格只读复核，目标为 `2026-09-18T11:36:42.243000Z` 或稍后；复核只能读取 SSH/API/日志/metadata 聚合并写入本任务 research，不得调用 quota refresh、修改配置/服务或自动回滚。
