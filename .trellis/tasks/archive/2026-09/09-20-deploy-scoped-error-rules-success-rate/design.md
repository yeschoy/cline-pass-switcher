# 双维度错误规则与成功率生产发布设计

## 1. Source and target

- Source：用户批准后提交本任务规划/激活状态，推送本地 `main`，再冻结 exact `main == origin/main` commit；实现提交 `cb19f2e` 和规范提交 `1008fc8` 必须是其祖先。
- Target：部署规范中的固定 SSH/remote root/Compose/service；identity 仅作为 `ssh/scp` 路径参数使用，绝不读取或输出内容。
- Package：只从冻结 commit 生成 allowlisted `git archive`。Trellis 任务和工作树文件不进入 release。
- Release：UTC 时间 + 短 commit + `scoped-rules-rate`，创建后不可覆盖。

## 2. Read-only production freeze

写入前用远端内部 helper 输出 bounded JSON：

- deployment release/commit/image、live Compose hash；
- container exact image、running/health/restart/OOM/start time；
- disk、旧 image inspectability、helper/runtime 可用性；
- config/metadata/logs hashes 与安全计数/枚举；
- statistics version/coverage/cell 计数和双维度状态行计数；
- local/authenticated management API 状态、内部 alias、public DNS/HTTP 基线。

远端进程只在内部读取 admin key 并立即 unset；不得出现在 argv、stdout、文件或本地 evidence。

## 3. Immutable candidate

1. 从冻结 commit 生成 allowlisted tar，记录 tar 与关键源码 hash。
2. 上传唯一临时名并比较远端 hash；拒绝已存在 release/candidate/verification path。
3. 解包后强制目录 0755、普通文件 0644，验证成员 allowlist 和 source hash。
4. 从 live Compose 生成 candidate，语义 diff 只能含 image tag 与 `build.context`。
5. 通过最终 candidate Compose 构建一次，捕获 exact image ID；后续预演、切换和回滚均使用 `--no-build`。

## 4. Copied-data rehearsal

将当前 config、metadata、ordinary logs 复制到远端私有 verification 目录。Exact candidate 在隔离网络和生产 hardening 下启动，不连接真实 upstream。

结构比较由远端脚本完成，只输出安全 projection：

- config：legacy 规则按内容数组后 exact status 顺序迁移为 canonical rules；legacy ban/cooldown 语义映射正确；四步 pipeline 合并为三步；账号与 route/credential/network/scheduling 业务投影不变。
- metadata：旧 statistics 完整事实保留，version 升至 4，account/provider direct-health owner 从迁移分钟空开始；state 新字段仅是规范化，不生成针值/body/Header/credential。
- logs：文件 hash/bytes 不变，异步 recovery 后管理 API 可查询。
- 第二次启动必须使 config、metadata、logs hash 不再变化。

如果 live metadata 在预演期间变化，比较冻结副本而非移动 live 文件；最终备份前重新冻结并必要时重跑预测。

## 5. Backup and rollback boundary

切换前版本化备份 Compose、deployment、config、metadata、ordinary logs，并创建 hash manifest。先在 scratch 文件上演练原子 replace/restore。记录 live mutation boundary 前的 exact hashes/image。

Rollback 只在 live state 仍属于本部署且无未知 operator drift 时执行：恢复备份数据/Compose/deployment，使用旧 exact image `up -d --no-build`，验证旧服务恢复。切换前失败必须证明 no-op，不能停止健康旧容器。

## 6. Switch and verification

正式变更只有 candidate Compose 的原子安装和 no-build `up -d`。即时与 90 秒门禁验证 exact image/health/restart/OOM、source/config hashes、schema projection、日志、API、internal alias 和 UI markers。Fresh independent postcheck 重新执行关键只读检查。

Public ingress 以 preflight 基线处理：切换前可用则切换后失败回滚；切换前 DNS 已坏则作为外部降级报告。

## 7. Evidence and cleanup

Trellis research 只保存 hashes、counts、statuses、safe enums、release/image refs、rollback refs 和命令结果摘要，不保存业务 JSON、日志记录或秘密。远端 release/image/log/backup 永久保留。Local tar、scratch 和 remote upload 是非业务中间物，仅在成功且用户明确同意后清理。
