# 上游亲和版本生产发布设计

## 1. 固定源与 release

- Commit: `3ccb92984eca4b282e158027bf571b7ffab06bb0`
- Release: `20260919-172057-3ccb929-upstream-affinity`
- Archive SHA-256: `95969d2f49c303d646f981cfefd23a87d51c7e9097cc6bdfa87dde34249776b6`
- Archive allowlist: `Dockerfile`, package manifests, `server.js`, `lib/`, `public/`, `README.md`, `LICENSE`, `.dockerignore`, `config.example.json`。
- 生产根/release/verification: `/opt/cline-pass-switcher`、`releases/<release>`、`verification/deploy-<release>`。

所有运行与发布内容来自 committed archive；本地未提交文件不进入 release。

## 2. 当前生产边界

基线为 release `20260919-110817-b2d676d-stats-logs-rules` / exact image `sha256:fb5d9de7dc6643201a333ed47e7064464df3615598cd0fb3c91ad3ffc2f91cf2`。切换前重新冻结：

- container image/health/restart/OOM/start time；
- compose/deployment/config/metadata SHA-256；
- ordinary logs 文件数/总字节；
- config 安全计数和 statistics version/coverage；
- local/authenticated APIs、`ai-internal` 网络上的 `cline-pass-switcher` 服务别名、公开 DNS。

admin key 仅由远端 Python 进程或容器内部读取用于 loopback，不进入 argv/stdout/证据。

## 3. Candidate build

1. 上传唯一临时 archive，远端核对固定 SHA-256。
2. 解包到全新 release，拒绝已存在路径；目录 0755、普通文件 0644。
3. 核对成员及 `server.js`、`public/index.html`、三个安全模块哈希。
4. 从 live Compose 生成 candidate，只修改：
   - image → `cline-pass-switcher:<release>`；
   - build.context → `./releases/<release>`。
5. 使用最终根目录的 candidate 执行一次 `docker compose build` 并记录 exact image ID。之后不再 build。

## 4. Schema rehearsal

在 verification 私有目录复制 live config、metadata、ordinary logs，创建与生产相同文件布局。用 exact candidate image、UID/GID 1000:1000、read-only root、cap-drop、no-new-privileges、tmpfs 和隔离端口/网络启动。

### Config expected diff

- 账号、mode、wait、pipeline、status/content rules、aliases、known models、代理/Header/Key 均不变。
- 全局/账号 `perModel` 每个 normalized route 的既有字段不变。
- 仅缺失时新增 `providerCooldownMs: 0`。

通过安全结构 diff（不输出 Key、代理、Header、名称/ID），并记录完整预测 config hash。

### Metadata expected diff

- statistics version 2 → 3；
- 所有既有 aggregate 原字段、minute/account/model/health cells 和 coverage 保持；
- 每个 aggregate 新增五个 routing counters，迁移初值 0；
- `recentCoverage.routingTrackingStartedMinute` 为 rehearsal 启动分钟；
- 新版本再次启动幂等，不重置 routing counters/start minute。

普通日志在后台恢复期间允许日志 API 503，但 `/api/meta` 必须可用；恢复后 request/error 历史可查询，文件 retention 变化必须符合现有边界。

## 5. Backup, switch, rollback

切换前以最新 live 数据重新做 migration rehearsal/预测，避免 preflight 后动态 metadata 漂移。备份：

- compose/deployment/config/metadata；
- ordinary logs 目录及 manifest；
- candidate Compose、source/archive/build/rehearsal 证据。

先对私有 scratch 文件演练原子 replace/restore helper，证明 mutation boundary 前失败不会停止旧容器。正式切换：原子安装 candidate Compose，然后 `up -d --no-build`。

Rollback 仅在已跨 mutation boundary 且 live 状态仍属于本次 candidate 时执行：恢复 config/metadata/logs/compose/deployment，再以旧 exact image `up -d --no-build`；未知并发漂移时停止自动覆盖。

## 6. Post-switch gates

即时门禁：

- candidate exact image、running/healthy、restart=0、OOM=false；
- config 等于预测 hash；metadata v3/routing coverage；
- release/container关键源码 hashes；
- `/api/meta`；认证 accounts/models/statistics/request/error logs/detailed settings；
- 非法 quota-refresh 400；
- UI 包含 `upstreamSetupModal`、`affinityLogLabel`、`providerCooldownMs`、内容规则标记；
- `new-api` 容器通过 `cline-pass-switcher:3123/api/meta`；
- bounded logs 无 fatal/config/metadata/persistence 错误。

90 秒后重复 image/health/restart/OOM/config/API/log readiness。公开域名仅在 DNS 可用时验证 HTTP；预切换已无 DNS，保持 degraded 记录。

## 7. Evidence

只保存脱敏 JSON/Markdown、hash、count、status、version、safe enum。Trellis evidence 不清理。部署过程中生成的本地 tar/test 目录属于非业务中间产物，任务结束后经用户同意才清理。
