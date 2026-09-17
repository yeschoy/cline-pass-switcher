# 优化详细日志扫描与生产 CPU

## Goal

消除 Cline Pass 详细日志在发布、查询和分钟级维护中的重复全量磁盘扫描，降低生产 CPU、I/O 与 Node.js 堆压力，同时完整保留详细日志、安全、保留期、容量、清理和查询契约。

## Background

- 生产主机为 16 核，今天整机平均 CPU 忙碌约 2.26%，前几天通常约 1.1%–1.3%；当前没有整机资源压力，但 `cline-pass-console` 存在周期性单核 100% 峰值。
- 生产详细日志当前约 393 MiB，包含 4,754 个请求目录、22,812 个文件。
- `lib/detailed-log-store.js:42` 每分钟执行维护；`expire()` 在 `lib/detailed-log-store.js:142-146` 至少扫描语料两遍；每次 publication 在 `lib/detailed-log-store.js:180-181` 又执行 `expire()` 和 `admit()`，正常写入可触发约三轮全量扫描。
- 生产 Node 进程今天在 13:09 和 13:32 两次出现 JavaScript heap OOM；当前容器限制为 1 CPU、512 MiB 内存并使用 `unless-stopped`。
- 当前版本始终实例化 `DetailedLogStore`（`server.js:98`）。关闭 `detailedLogging` 只停止新捕获和请求驱动扫描，不会停止旧实现的分钟级后台扫描。
- 生产运行源码与本地已提交应用源码一致；本地工作树另有用户未提交/未跟踪内容，必须保持不变且不得进入本次提交或生产 archive。

## Requirements

### R1 — 安全止损

- 通过现有认证 loopback 管理 API 将生产 `detailedLogging` 临时关闭，不打印或传递管理密钥到命令行参数。
- 写入前后记录安全状态、配置哈希和开关值；除 `detailedLogging: true -> false` 外不得改变配置语义。
- 不删除、移动或改写现有详细日志。

### R2 — 消除热路径全量扫描

- 详细日志 publication、metadata listing 和分钟级过期维护在正常运行时不得重新遍历全部请求目录/manifest/body 文件。
- 进程启动时允许对现有目录做一次有界磁盘校准，运行期间通过轻量内存索引维护已验证记录、总字节数和时间顺序。
- 七天过期维护仍按分钟执行，但必须只使用索引定位待删除记录。
- 可保留低频全量磁盘校准来发现进程外变更或遗留临时目录；生产频率不得高于每小时一次。

### R3 — 保留详细日志契约

- 保持固定 7 天和 1 GiB 两个独立限制、按时间/UUID 删除最旧完整 root、无记录数上限。
- 保持 0700 目录、0600 文件、UUID-v4 身份、临时目录写入和原子 rename 行为。
- 保持 clear generation、过期/淘汰/clear 后晚到 completion 不得重建 root、进程中断的 open root 恢复为 interrupted。
- 保持损坏、不可读、未知或 symlink 数据不被自动修复、跟随或误删；它们必须阻止不安全的容量淘汰，而不是被当作可删除成功记录。
- 详细正文仍只按需读取；metadata listing 不得读取正文内容。
- 存储故障继续只影响诊断记录，以安全 404/503 和健康计数体现，不得改变模型流量结果。

### R4 — 资源和一致性

- 不新增外部依赖或持久 sidecar 索引；索引可由磁盘在启动时重建，并具有固定条目数/投影字节安全上限，超限时必须保留磁盘数据并安全停用详细存储而不是 OOM 或按记录数删数据。
- publication 成功后才更新索引；删除、淘汰、clear、直接过期读取和失败临时目录处理必须与索引保持一致。
- 全量校准先构建独立快照，只有完整成功后才能替换活动索引；校准失败不得发布部分索引或删除未知数据。
- 现有 128 个 pending publication 上限、64 MiB capture reservation 和请求转发时序保持不变。

### R5 — 测试、部署和恢复

- 新增可执行回归测试，证明大语料初始化后 publication、query 和分钟维护不再对既有语料做全量 `opendir`/manifest 读取。
- 现有 retention、restart、corruption、temporary cleanup、clear/eviction race、path/symlink 和 integration 测试必须继续通过。
- 部署必须来自本次 committed `HEAD` 的 allowlisted `git archive`；不得上传工作树、真实配置、Trellis 内容或无关未提交文件。
- 部署前备份 compose、deployment、config、metadata 并记录旧 image ID；失败时恢复旧 compose/image 和原配置。
- 新版本通过健康、认证 API、内部网络、配置哈希和稳定性门禁后，将 `detailedLogging` 恢复为原始开启状态并观察 CPU、OOM 和 restart。

## Acceptance Criteria

- [ ] 临时止损已验证：生产详细日志开关为 false，配置唯一语义变化是该布尔值，现有日志目录保持完整。
- [ ] 正常 publication、query 和分钟过期维护使用内存索引，不对预存语料执行全量目录/manifest 扫描；自动化测试可检测回归。
- [ ] 启动和低频校准可以从磁盘完整重建索引，并安全处理 open、expired、over-budget、inventory-overflow、corrupt、unknown、symlink 和 abandoned temporary 情况。
- [ ] 7 天、1 GiB、最旧优先、无记录数上限、clear generation、晚到 completion、权限和原子写入契约保持不变。
- [ ] `node --check`、详细日志 focused tests、相关 integration tests、完整 `npm test` 和 `git diff --check` 全部通过。
- [ ] 只提交本任务拥有的代码、测试、规范/任务记录；现有 `untitled.md` 删除、`.pi/subagents/` 和其他任务目录保持原样。
- [ ] 生产部署来自 committed archive，容器 healthy、目标 image 匹配、restart=0、OOM=false，配置和账号语义未发生未批准变化。
- [ ] 重新开启详细日志后至少观察 5 分钟：不再出现旧版每分钟语料全扫导致的重复单核峰值，无新 heap OOM/容器重启，详细日志新增和查询可用。
- [ ] 旧 release/image、配置备份和验证证据保留，可执行回滚。

## Out of Scope

- 修改普通 JSONL 日志、详细捕获/脱敏规则、UI、账号路由、额度或模型请求行为。
- 删除、压缩或迁移现有详细日志内容。
- 将 7 天/1 GiB 改为用户配置项。
- 优化 `CLIProxyAPI`、`new-api` 或其他容器的 CPU/内存。
