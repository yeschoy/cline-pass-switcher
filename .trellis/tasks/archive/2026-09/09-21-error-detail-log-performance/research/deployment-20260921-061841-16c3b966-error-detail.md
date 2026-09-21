# 错误详情与日志热路径版本生产部署报告

## 结果

- 状态：部署成功。
- 源码：`origin/main@16c3b966df3c47771e276df42cad5c838002d2a0`。
- Release：`20260921-061841-16c3b966-error-detail`。
- Exact image：`sha256:9e852b57984076f583715414138993dadf5be747c46ae4a4b27292d31509bcc3`。
- 上一 release/image：`20260920-045938-c78d8bbb-scoped-rules-rate` / `sha256:615df03dddc5883a769024e5f34146d6fbaf02a13cc9694feab3d1a16939ce55`。
- 正式切换使用已由候选 Compose 构建的 exact image，并通过 `docker compose up -d --no-build` 完成；切换时没有重建。
- 未发送真实模型/付费请求，未修改 NewAPI/CPA，未清理生产 release、image、日志、缓存、备份或数据。

## Source 与候选镜像

- 本地 `main`、`origin/main` 和部署 commit 完全一致，工作区干净。
- committed-source 完整门禁通过：语法、生产内联脚本编译、`git diff --check` 和 **180/180** tests。
- 白名单 archive SHA-256：`abd8a6aba4af57643eb02e52e3106819ffecef3d2947784e9ea5338299317f3b`，共 14 个允许成员。
- release 目录/文件模式规范化为 0755/0644；候选镜像以 UID/GID 1000:1000、read-only root、cap drop、no-new-privileges 通过源码可读性和语法检查。
- `server.js`、`public/index.html` 和三个日志模块的镜像内哈希与 committed source 一致。
- 候选 Compose 相对旧 Compose 只改变 image 与 build context。

## 复制数据预演

最终 `rehearsal3` 使用最新生产 config/metadata/ordinary logs 的私有副本、隔离内部网络及生产硬化参数启动 exact candidate image 两次：

- 两次启动、日志恢复、`/api/meta`、详细设置和 ordinary 日志 API 均成功。
- `config.json`、`metadata.json` 和 ordinary logs 字节不变；第二次启动幂等。
- 缺失的 `errorDetailLogging` 按兼容契约解释为 `false`，不会为了默认值重写配置。
- 现有 `detailedLogging=true` 保持不变；新 `errorDetailLogging=false`，未自动开启。
- 预演期间操作者新增了一条错误规则（3 → 4）。部署检测到 config hash 漂移后停止，保留新规则并从新鲜副本重跑预演；最终生产基线和所有门禁均使用 4 条规则。

## 备份、回滚与切换

- 最终备份：`/opt/cline-pass-switcher/deployments/20260921-061841-16c3b966-error-detail/backup-final3`。
- 备份包含 Compose、deployment state、config、metadata 和 ordinary logs；旧 exact image 仍可 inspect。
- 原子 install/restore helper 在私有 scratch 上通过。
- 一次候选切换因门禁脚本误查不存在的 `beginShutdown` 字符串而触发自动回滚；实际实现标记为 `function shutdown`。旧 Compose、配置、deployment state 和旧镜像随后恢复，容器重新达到 healthy。修正门禁后重新完整切换并通过。
- 所有预切换停止、外部配置漂移和该次成功回滚均记录在 `deployment-attempts.json` / `rollback-ready.json`。

## 正式门禁

即时、90 秒延迟和新的独立只读 postcheck 均通过：

- exact image 匹配，running/healthy，restart 0，OOM false；
- `config.json` SHA-256 保持 `95e7b78de7c955acd1a6c6ae9c2bb334d3c5862d6602d2137816383901097cf6`；
- 10 个账号、8 个启用、sticky、等待 0 ms、cache pool 5、4 条错误规则、16 条全局 route 均保持；
- `/api/meta`、accounts、models、statistics、request logs、error logs、detail settings 均返回 200；非法 quota-refresh 返回 400；
- `detailedLogging=true` 保持，`errorDetailLogging=false`；
- `new-api → cline-pass-switcher` 内部别名通过；
- 启动日志未命中配置/metadata/权限/语法致命标记；
- 受控安全 evidence 对生产已知凭据内存扫描命中 0。

公网域名在本地独立客户端和部署主机上于切换前均不可用，切换后仍记录为既有 DNS 外部依赖故障；本地、认证和内部网络硬门禁均正常，因此没有仅因该既有故障回滚。

## 浏览器边界

尝试经临时 SSH 隧道执行真实浏览器加载，但本机 Pi 环境缺少 `agent-browser` 二进制，工具以 `missing-binary` 停止。临时隧道已关闭。生产 HTML/source marker、VM/static UI tests 和管理 API 均通过，但不把这些证据描述为真实浏览器键盘、焦点或窄屏验证。

## Evidence 与回滚

本目录保存以下无秘密 evidence：

- `deployment-report.json`
- `immediate-gates.json`
- `delayed-gates.json`
- `independent-postcheck.json`
- `deployment-attempts.json`
- `rehearsal3.json`
- `rollback-ready.json`
- `backup-manifest.json`

如需回滚，应先确认当前 Compose/config/image 没有新的操作者漂移，再从 `backup-final3` 原子恢复旧 Compose（配置仅在哈希异常时恢复），并用 `docker compose up -d --no-build` 启动上一 exact image。生产 release/image/log/cache/backup/evidence 必须保留。
