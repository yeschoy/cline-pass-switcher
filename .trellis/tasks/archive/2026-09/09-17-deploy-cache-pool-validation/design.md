# 缓存活跃池生产部署与验证设计

## 1. 固定边界

- 生产目标：`ubuntu@167.114.158.4:49555`
- 根目录：`/opt/cline-pass-switcher`
- Compose：`/opt/cline-pass-switcher/compose.yml`
- 容器：`cline-pass-console`
- 源提交固定为：`cbdee55f1b78fdc41a69bfa9773ff73798b63057`
- 发布内容只来自该提交的 allowlisted `git archive`，不读取工作树；`untitled.md` 删除、当前 Trellis 任务和其他窗口的 `09-17-investigate-empty-content-errors` 均不进入发布包。
- NewAPI/CPA 不修改；生产请求正文、原始会话、Key、代理和 Header 值不读取、不输出。

发布命名使用执行时 UTC 时间、源短提交和 `cache-pool` 后缀，例如：

```text
20260917-HHMMSS-cbdee55-cache-pool
```

远程 release 目录、镜像 tag、验证目录使用同一名字且必须事先不存在。

## 2. 本地 committed-source 门禁

在独立临时目录中从固定提交导出：

```text
Dockerfile
package.json
package-lock.json
server.js
lib/
public/
README.md
LICENSE
.dockerignore
config.example.json
```

`test/` 单独从固定提交导出用于完整测试，但不进入生产 archive。要求：

- `node --check server.js`；
- 清除真实环境覆盖后 `npm test`，预期 146/146；
- `git diff --check <source>`；
- archive 成员严格等于 allowlist；
- 记录 archive、`server.js`、`public/index.html` 和三个 `lib/` 安全模块的 SHA-256。

固定源关键哈希：

- `server.js`: `11742c8d33c94f211914277b904d3dc1c2344aaeca13ea3fb9245d76bd26412d`
- `public/index.html`: `8bac00406459e941b0d366789cf99946c2398e76582d3ddffd442ba4d6c46834`
- `lib/jsonl-log-store.js`: `6471348de5fa4b43c56eb950e5903e749a939d930299fef6c3e1ae6e896861f8`
- `lib/detailed-log-capture.js`: `cec4581fc4cadf198f68f55a7766b1bac9bfb5e758d8d4cae06546abd7ba13ad`
- `lib/detailed-log-store.js`: `18c123b35f2d465c4d977d96f726b35fc23092be029bffa38bf90a34e9f56254`

## 3. 只读生产预检

使用固定仓库内 SSH identity，仅验证普通文件、0600、gitignore 和非交互认证。读取安全投影：

- 主机磁盘、容器 image/status/health/restart/OOM/start time；
- compose/deployment/config/metadata 哈希；
- 本地 `/api/meta` 和公开 DNS/HTTP；
- 账号数、模式、pipeline、并发等待；
- 每账号仅用报告内哈希别名投影 enabled、priority、maxConcurrent、health、quota 与 24h cache 指标；
- 最近 24h 全局 cache 请求命中率、Token 占比、usage/cache 覆盖、最终失败率、P95、overflow/capacityFallback/switched。

当前快照只用于规划。任何生产写入前再次冻结 T0 基线，并重新选择两个账号；容器不健康、空间不足、SSH/identity 异常、当前配置无法解析、少于两个合格账号或 app allowlist 源不一致时停止。

## 4. 不可变安装、精确 Compose 镜像与迁移预演

首次 release `20260917-084457-cbdee55-cache-pool` 已因直接 build 与 Compose build 的 manifest ID 不一致而在账号配置前回滚；该 release、镜像与证据只保留，不复用。重试必须使用新 release。

1. 上传唯一 archive 到远程临时路径，校验本地/远端 SHA-256。
2. 安装到唯一 release 目录，验证成员和关键文件哈希。
3. 在 `/opt/cline-pass-switcher/` 根目录生成唯一 candidate Compose，使相对 build context 与最终 compose 完全一致。
4. 先执行 `docker compose -f <candidate> build`，捕获 Compose 注入标签/provenance 后的 exact image ID；禁止另走直接 `docker build` 路径。
5. 建立 0700/0600 私有预演目录，复制当前 `config.json`/`metadata.json`。
6. 使用上述 exact Compose-built image、复制数据和禁网/隔离网络启动一次预演，只允许新代码规范化复制品。
7. 对原始复制品与预演结果做安全结构差异：切换前预期只新增 `accountPipeline.cachePoolSize: 0`。出现其他配置差异则停止，不触碰 live 文件。
8. 记录 exact image ID 与预测迁移后的完整 SHA-256，作为切换后精确门禁。

不得在预演后再次 build：BuildKit 即使复用相同层，也可能因 Compose 标签/provenance/attestation 重新导出不同 manifest。

## 5. 备份、Compose 候选与代码切换

切换前在版本化验证目录保存：

- `compose.yml`
- `deployment.json`
- live `config.json`
- live `metadata.json`
- 归档/源哈希、预检和迁移预演报告

生成 Compose 候选，仅允许：

- image → `cline-pass-switcher:<release>`
- build context → `./releases/<release>`

切换前记录并证明旧 tag 的 exact image ID 仍存在。原子安装候选后执行一次：

```text
docker compose -f compose.yml up -d --no-build
```

要求在有界时间内：容器 exact image ID 等于迁移预演 image ID、running/healthy、restart 0、非 OOM、无 fatal/config/metadata/persistence 指示，`/api/meta` 200。首次启动后的 live config 必须精确等于预演迁移哈希。

任一失败：恢复原始 config、旧 compose/deployment，并使用 `docker compose -f compose.yml up -d --no-build` 恢复切换前已记录的 exact old image；要求 image ID 与切换前完全一致并恢复 healthy。不得在回滚中重建旧 tag。保留全部证据。

## 6. 双活跃账号选择和配置事务

新镜像代码门禁通过后，使用远程本机脚本在内存中读取管理密钥并调用认证 loopback API；秘密不进入命令行或输出。

### 合格条件

- persisted enabled 且有 Key；
- quota `status=fresh`、pool 非 reserve；
- health 非 banned/cooling/disabled/unhealthy；
- 优先使用 health available 且最近 24h `cacheKnownRequests >= 100`。

### 排序

对合格账号计算：

```text
selectionScore = cacheHitRequestRate * 100 - maxPercentUsed
```

按 score 降序、health score 降序、稳定 ID 排序取前 2；不足 2 个时停止。选择前输出报告专用哈希别名、额度、健康、缓存样本和选择分数。

当前预检建议结果为 `account#eb683cec24` 与 `account#3efe425de6`；写入前必须重算，不能硬编码别名或账号 ID。

### API 保存

从认证 `GET /api/accounts` 获取完整账号快照，在内存中构造完整 POST：

- `mode = sticky`
- `concurrencyWaitMs = 5000`
- `accountPipeline.cachePoolSize = 2`
- 第一名 priority=1，第二名 priority=2
- 其他账号 priority 保持原值
- 其他 pipeline、错误规则、active index、账号全部字段保持原样

调用一次 `POST /api/accounts`。随后要求：

- config 最终语义差异仅限 migration 字段、mode/wait、两个 priority；当前 mode 已为 sticky，因此不得出现无关 mode diff；
- 账号数、稳定 ID 集、enabled、名称、Key 哈希、代理、Header、perModel 和全局路由全部相等；
- `GET /api/accounts` 显示恰好两个 `cachePoolRole=active`，其余合格启用账号为 standby；active 与选中别名一致；
- `accountPipeline.cachePoolSize=2`、wait=5000、mode=sticky。

保存、差异或角色门禁失败时执行完整 image+config 回滚，不重试第二次写入。

## 7. 发布后硬门禁

配置事务后验证：

- container image/ID、running/healthy、restart 0、非 OOM；
- bounded startup/runtime 日志无 fatal/config/metadata/persistence；
- local `/api/meta`；
- 认证 `/api/models`、`/api/accounts`、`/api/statistics`、request logs、detailed settings；
- 非法 quota-refresh 在工作前返回 400；
- `new-api` 容器内 `ai-internal` 的 `cline-pass-switcher` 别名可解析并访问 `/api/meta`，不改 NewAPI；
- 控制台包含 `cachePoolSize` 与“缓存命中优先”标记；
- public endpoint：若 DNS 在切换前已不可用且本地/独立解析均复现，则记录 pre-existing；否则失败触发回滚；
- 90 秒延迟稳定性重复 exact image ID/health/restart/config/API/roles 门禁。

全部通过后原子更新 `deployment.json` 和安全报告。不得清理 release、镜像、构建缓存、日志、备份或旧版本。

## 8. 观察窗口与自动复核

记录策略激活时间 `T`：

- `T` 至 `T+2h`：自然预热窗口，单独统计，不作为 70% 判定窗口；
- `T+2h` 至 `T+26h`：正式 24 小时窗口。

部署成功后创建一次性只读复核，目标时间约为 `T+26h`。复核必须：

- 仅 SSH/API/日志/metadata 聚合，不修改配置或服务；
- 使用精确时间窗而非模糊“最近一天”；
- 要求至少 1,000 个明确 cache 样本；
- 计算命中率、Token 占比、usage/cache 覆盖、失败率、P95、cachePoolFallback/standby overflow、active/standby 请求分布与 active 额度/健康；
- 对照 T0 基线：命中率 ≥70%，Token 占比下降 ≤3pp、失败率上升 ≤1pp、P95 恶化 ≤20%、standby overflow <1%、active 未 reserve/持续 unhealthy。

自动复核只写安全报告并通知结果。未达标或护栏失败时不得自动回滚，等待用户确认。

## 9. 证据与安全

本任务保存：

- preflight、candidate/migration、install、config-diff、API/internal/public、delayed-stability 报告；
- 本地部署报告与后续 26h 验证报告；
- 只含哈希、计数、状态、脱敏账号别名和时间。

远端脚本不得打印完整配置、密钥、Authorization、账号名称/ID、代理、Header 值、请求正文或原始会话。所有写操作前后均验证当前哈希，检测漂移即停止或回滚，不覆盖未知并发修改。
