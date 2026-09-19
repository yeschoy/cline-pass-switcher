# 生产发布执行计划

> 固定源：`b2d676d11e0d4422aef83854670b6bceb89401a0`。实际生产写入前必须完成计划审阅并执行 `task.py start`。

## 1. Committed-source 与身份门禁

- [x] 从固定提交导出独立测试树和严格 allowlisted production archive。
- [x] 运行 server/lib/UI syntax、完整 161 项测试、production allowlist diff 与 archive 成员检查。
- [x] 记录 archive 和关键源码 SHA-256。
- [x] 验证 SSH identity 固定路径、普通文件、0600、gitignored和非交互认证；不读取内容。

停止：任一源码、测试、archive 或身份门禁失败。

## 2. 只读生产预检

- [x] 记录当前 release/tag/exact image、容器 health/restart/OOM/start time、磁盘和 Docker/Compose 可用性。
- [x] 记录 compose/deployment/config/metadata 哈希及普通日志文件数/总字节。
- [x] 验证 local meta、认证 API、安全日志 readiness、内部别名和公开 DNS/HTTP。
- [x] 证明旧 exact image 仍存在且可 `--no-build` 回滚。
- [x] 记录缓存池观察窗口状态和本次版本边界影响。

停止：生产不健康、空间/helper/config/identity/rollback 不满足或只读状态漂移。

## 3. 安装不可变候选

- [x] 创建唯一 release/upload/candidate/rehearsal/verification 名称并证明不存在。
- [x] 上传 archive、核对双端哈希、解包并规范化 0755/0644。
- [x] 验证成员与关键源码哈希。
- [x] 生成 candidate Compose，证明只改变 image/context。
- [x] 用 candidate Compose 构建一次并记录 exact image ID；此后未 rebuild。

回滚点：live compose/data/container 未改变；失败只停止并保留证据。

## 4. 私有复制数据预演

- [x] 复制 config、metadata、普通 logs 到 0700/0600 rehearsal 目录。
- [x] exact image 以生产 UID/GID/hardening 和隔离网络启动。
- [x] 验证监听不等待普通日志恢复；恢复期间明确 503，约 411ms 完成后历史可查。
- [x] 验证 config 只按需新增空 `accountContentErrorRules`。
- [x] 验证 statistics v1→v2 保持事实；验证 JSONL 兼容且当前 corpus 字节不变。
- [x] 记录预测 config hash、metadata 安全 schema diff 和日志恢复指标。

停止：任何额外语义变化、启动/恢复失败、容量 fence 或敏感投影。

## 5. 最终冻结、备份与切换

- [x] 切换前重新冻结 live hashes，检测漂移并基于最新副本确认预测。
- [x] 私有备份 compose/deployment/config/metadata/logs，生成 manifest；首个脚本故障后重新冻结 `backup-attempt2`。
- [x] 证明旧 exact image/tag 可用；准备恢复命令与哈希门禁。
- [x] 修复并记录首个切换脚本的预安装路径错误后，原子安装 candidate Compose，执行 `up -d --no-build`。
- [x] candidate exact image、running/healthy、restart=0、OOM=false、config hash、日志恢复和 bounded startup logs 全部通过。

失败：仅在无未知漂移时恢复原始 config/metadata/logs/compose/deployment，以旧 exact image `up -d --no-build` 回滚并验证；有外部漂移则停止自动覆盖并报告。

## 6. 发布后即时与延迟门禁

- [x] 验证 meta、认证 accounts/models/statistics、request/error logs、detailed settings。
- [x] 验证非法 quota-refresh 400、statistics model projection、stable-ID account summary、content rules 投影。
- [x] 验证控制台模型缓存/上游状态/剩余额度/可视规则标记。
- [x] 验证 `ai-internal` 别名；未修改 NewAPI。
- [x] 验证公开入口；生产与独立本机均复现切换前既有 DNS 不可用。
- [x] 153 秒后重复 image/health/restart/OOM/config/API/log readiness。
- [x] 全部通过后原子更新 deployment.json 和 rollback-ready 报告。

失败：任一硬门禁触发完整回滚；不得重建旧镜像。

## 7. 记录、检查和提交

- [x] 写入本任务脱敏 deployment report 与证据文件。
- [x] 向缓存池观察任务记录版本切换边界，不改写旧基线。
- [x] 运行本地/远端证据一致性检查和 `git diff --check`。
- [x] 更新 deployment spec，要求预切换失败走 no-op 保护并先做原子 helper 私有自检。
- [x] 提交并推送本任务 Trellis 证据，排除所有既有无关工作树变化。
- [ ] 如生成本地非业务临时目录，完成后先征得用户同意再清理；Trellis/部署证据不清理。

## Immediate rollback

1. 验证 live config/metadata/logs/compose 仍属于本次 candidate 状态；未知漂移时停止覆盖。
2. 原子恢复版本化备份的 config、metadata、logs、compose 和 deployment。
3. 证明切换前 old exact image ID 仍存在，执行 `docker compose -f compose.yml up -d --no-build`，禁止 rebuild。
4. 要求 old exact image、running/healthy、restart/OOM、local/auth/internal API 和原始 config hash 恢复。
5. 保留失败 candidate release/image/logs/backup/build cache 和全部证据，不清理。
