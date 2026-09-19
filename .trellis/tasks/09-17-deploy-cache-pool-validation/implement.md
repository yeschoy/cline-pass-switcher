# 缓存活跃池生产部署与验证执行计划

> 任何生产写入必须等本计划获用户最终批准并执行 `task.py start`。固定源提交为 `cbdee55f1b78fdc41a69bfa9773ff73798b63057`；不使用后续工作树或并发窗口的提交。

## 1. 固定 committed-source 门禁

- [ ] 在独立临时目录从固定提交导出应用 allowlist 和 `test/`。
- [ ] 核对关键文件 SHA-256 与 `design.md` 固定值。
- [ ] 运行语法、完整 146 项测试和 `git diff --check`，清除真实环境覆盖。
- [ ] 生成唯一 production archive，验证成员严格等于 allowlist，记录大小与 SHA-256。
- [ ] 验证仓库 SSH identity 为普通文件、0600、gitignored，不读取内容。

停止条件：固定提交不存在、测试/哈希/allowlist/identity 任一失败。

## 2. 最终只读生产预检与 T0 基线

- [ ] 非交互 SSH；读取容器/image/health/restart/OOM、磁盘、compose/deployment/config/metadata 哈希。
- [ ] 验证 local `/api/meta`，在生产主机、本地和独立解析器检查公开 DNS/入口。
- [ ] 冻结精确 T0：全局 cache 请求命中率/Token 占比/覆盖、失败率、P95、overflow/capacityFallback/switched。
- [ ] 投影账号 fresh quota、health、样本和 cache 指标；按已审阅评分重算前两名并输出脱敏别名与理由。
- [ ] 要求至少两个 fresh、非 reserve、非 hard-unhealthy 的合格账号。
- [ ] 再次记录 live config 语义和哈希，检测相对规划快照的漂移。

停止条件：当前容器不健康、配置不可解析、空间不足、少于两个合格账号、目标状态在预检期间漂移。

回滚点：仍为纯只读，无生产变化。

## 3. 安装不可变 release 与构建 exact Compose candidate

- [ ] 使用新名称创建唯一 release/verification/upload/candidate-compose 路径并证明不存在；不得复用首次失败 release。
- [ ] 上传 archive，验证远端 SHA-256 后解压到唯一 release。
- [ ] 验证成员清单和关键文件哈希匹配固定源。
- [ ] 在远程根目录生成 candidate Compose，证明只改 image/context 且相对 context 与最终路径一致。
- [ ] 用 `docker compose -f <candidate> build` 只构建不切换，记录 exact image ID；禁止直接 `docker build`。
- [ ] 不删除上传包、build cache、旧 image、失败 image 或 release。

停止条件：路径已存在、上传/成员/源码/构建任一不一致。

回滚点：运行容器与 live 数据尚未变化；保留候选证据即可停止。

## 4. 私有复制数据上的迁移预演

- [ ] 创建 0700 预演目录和 0600 config/metadata 副本。
- [ ] 用 exact Compose-built image 对副本启动一次禁网/隔离预演。
- [ ] 验证原始→预演 config 唯一语义差异为 `accountPipeline.cachePoolSize: 0`。
- [ ] 记录预测迁移 config SHA-256；扫描预演日志无 fatal/config/metadata/persistence。
- [ ] 不打印副本内容或任何 secret。

停止条件：出现额外字段差异、无法启动、哈希/权限/日志异常。

回滚点：仅私有副本发生变化，删除不是必须；live 状态未变。

## 5. 完整备份、Compose 候选与代码切换

- [ ] 在 verification 目录保存 compose、deployment、live config、live metadata 与前述证据。
- [ ] 验证备份权限/哈希和回滚 manifest。
- [ ] 生成 Compose 候选，证明只改 image 与 build context。
- [ ] 切换前记录并证明旧 tag/exact image ID 存在。
- [ ] 原子安装 Compose 候选并执行一次 `docker compose up -d --no-build`，不得再次导出 manifest。
- [ ] 有界等待容器 exact image ID 等于预演 image ID、running/healthy、restart=0、OOM=false。
- [ ] 验证首次启动 config 哈希等于预演迁移哈希，日志无硬错误，local meta 200。

失败动作：立即恢复原始 config、compose、deployment，执行 `docker compose up -d --no-build` 恢复切换前 exact old image ID，要求旧容器恢复 healthy；不得重建旧 tag；保留证据并停止。

## 6. 自动选择账号并执行一次配置事务

- [ ] 远程脚本在内存中读取 admin key，仅调用 loopback 管理 API，秘密不进入命令行/输出。
- [ ] 从最新 `/api/accounts` + `/api/statistics` 重新执行资格门禁和排序。
- [ ] 输出两名报告别名、quota/health/cache 样本/score；确认与 T0 选择一致或记录安全替换原因。
- [ ] 从完整账号快照构造一次 POST：sticky、wait 5000、cachePoolSize 2、priority 1/2，其余字段不变。
- [ ] POST 前再次核对 live config hash；漂移即停止并完整回滚。
- [ ] POST 后验证最终 config 只有批准字段差异；账号数/ID 集及所有敏感字段哈希保持一致。
- [ ] 验证恰好 2 个 active、其他启用合格账号 standby、disabled 为 null，选中别名一致。

失败动作：不执行第二次 POST；恢复原始 config 和旧 image/compose，要求 healthy。

## 7. 发布后全门禁与证据

- [ ] 容器 image/health/restart/OOM 与有界日志。
- [ ] 认证 models/accounts/statistics/request-log/detailed-settings API。
- [ ] 非法 quota-refresh 400 且无工作。
- [ ] `new-api` 内部网络别名解析与 meta 可达，仅只读。
- [ ] 控制台包含 cache-pool 输入/预设标记。
- [ ] 公开入口按预检 DNS 规则判定。
- [ ] 保存 install/config-diff/API/internal/public/rollback-ready 报告。
- [ ] 90 秒后重复稳定性门禁。
- [ ] 全部通过后原子更新 `deployment.json`；不清理任何 release/image/cache/log/backup。

失败动作：任一硬门禁失败自动执行完整 image+config 回滚。

## 8. 预热与一次性自动复核

- [ ] 记录策略激活时间 T、T0 指标和选中脱敏别名。
- [ ] 定义预热 `[T,T+2h)` 与正式窗口 `[T+2h,T+26h)`。
- [ ] 创建项目级一次性计划任务，执行时间约 T+26h；任务只能做只读 SSH/API/日志/metadata 聚合。
- [ ] 计划任务输出到当前 Trellis 任务 research，报告主指标、样本、全部护栏、窗口边界和证据限制。
- [ ] 计划任务失败或无法恢复时通知，不自动回滚。
- [ ] 指标/护栏失败时仅报告并等待用户确认是否恢复旧 config；不得自动写生产。

计划任务创建失败不影响已通过硬门禁的部署，但必须作为未完成验证阻塞项明确报告，并给出手动复核时间/命令。

## 9. 本地记录与阶段状态

- [ ] 写入安全部署报告：固定源、release、前后状态、配置差异、选中别名、API/内部/公开/延迟门禁、回滚材料、T/T0、计划任务 ID。
- [ ] 运行 `trellis-check` 对部署证据做独立只读复核。
- [ ] 提交部署阶段的任务证据时排除 `untitled.md` 和另一窗口任务目录。
- [ ] 当前 Trellis 任务保持 `in_progress`，直到 T+26h 自动复核完成并经最终检查；不得在部署当天提前归档或宣称达到 70%。

## Immediate rollback procedure

1. 校验 live config/compose 仍是本次 candidate 哈希；若发生未知漂移，停止自动覆盖并升级人工处理。
2. 原子恢复备份的原始 `config.json`、`compose.yml`、`deployment.json`。
3. 证明切换前 old image ID 仍存在，执行 `docker compose -f compose.yml up -d --no-build` 恢复旧 release/image；不得重新 build。
4. 等待旧容器 exact image ID 匹配切换前记录、running/healthy、restart/OOM 正常；验证 local/auth/internal API、账号数/模式和原始 config 哈希。
5. 保留新 release/image、失败日志与全部备份，不清理。
