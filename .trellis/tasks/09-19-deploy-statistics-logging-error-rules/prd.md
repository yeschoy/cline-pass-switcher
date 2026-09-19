# 部署统计、日志与错误规则版本

## Goal

将当前已提交并推送的 `feat/quota-forecast-panel` 最新 `HEAD` 安全部署到既定生产服务器，使生产获得普通 JSONL 日志优化、按模型 24 小时缓存 Token 统计、上游发现修正、账号统计/剩余额度展示，以及可视化内容错误规则；不改变当前缓存活跃池策略和其他业务配置。

## Background

- 固定生产目标为 `ubuntu@167.114.158.4:49555`，远程根目录 `/opt/cline-pass-switcher`，Compose 服务/容器 `cline-pass-console`。
- 待发布固定源为 `b2d676d11e0d4422aef83854670b6bceb89401a0`；业务提交为 `d0dbc74`、`74913e0`、`939b62e`，其后仅有 Trellis 归档与 journal 提交。
- 2026-09-19 只读预检确认当前生产已经在后续 release `20260918-070946-2e7dc37-empty-content-r3` / commit `2e7dc37355fe9385a44d7de7c2da5015fd391f82`，exact image `sha256:a5ffbbc7a1185e69bf3d9e6767d80ff86bb20762dce456d90833d6179e0f1d7d`；容器 healthy、restart=0、OOM=false。该事实 supersede 旧缓存池部署报告中的当前版本假设。
- 当前安全配置投影为 10 个账号、sticky、`cachePoolSize=5`、`concurrencyWaitMs=2000`、5 条状态规则，且尚无 `accountContentErrorRules` 字段；本次必须完整保留这些当前值，只允许启动时新增空内容规则数组。
- metadata 仍为 statistics v1（776 个 minute buckets），普通日志为 2 个文件/5,285,403 bytes；新版本必须在副本上证明 v2 迁移和后台日志恢复。
- 现有任务 `09-17-deploy-cache-pool-validation` 的原始 size=2/wait=5000 观察边界已被后续生产版本/配置变更打断；本次只记录新的版本边界，不得把跨版本样本解释为同一连续验证窗口。
- 当前工作树包含与本任务无关的修改/未跟踪路径。生产包必须只来自 committed `HEAD` 的 allowlisted `git archive`，不得上传工作树、`.git`、`.trellis`、`.pi`、本地数据或 SSH identity。
- 新版本可能规范化缺失的 `accountContentErrorRules` 为 `[]`，并把 statistics v1 迁移为 v2；普通日志改为后台恢复。所有变化必须先在生产数据副本上预演并形成安全结构差异。

## Requirements

- 部署前从固定提交的独立导出运行完整语法与测试门禁，验证 archive allowlist、关键源码哈希、SSH identity 路径/gitignore/0600 及非交互认证。
- 在任何生产写入前执行只读预检，记录当前 release/exact image、容器健康/restart/OOM、主机资源、Compose/deployment/config/metadata/logs 哈希或安全大小投影、内部和公开入口状态。
- 创建全新的不可变 release，使用最终根目录下的 candidate Compose 构建 exact image；迁移预演、正式切换和必要回滚均使用已捕获的 image ID，切换/回滚禁止重新 build。
- 在权限受限的生产数据副本上预演 config、metadata 和普通日志恢复：要求服务在日志恢复完成前即可监听，日志 API 明确返回初始化状态并在有界时间内恢复；副本中的 schema/retention 变化必须完全符合规范。
- 切换前备份 Compose、deployment、config、metadata 和普通日志目录，保留旧 exact image；不得清理 release、镜像、构建缓存、日志、详细日志或操作员数据。
- 正式切换只修改 Compose 的 image 与 build context。除已预演的 schema 默认/迁移外，不修改账号、缓存池、priority、mode、wait、Key、代理、Header、perModel、错误规则内容、quota 或其他生产配置语义。
- 切换使用 `docker compose -f compose.yml up -d --no-build`；要求 exact image、running/healthy、restart=0、OOM=false、源码哈希、config 预测哈希、启动日志和普通日志恢复门禁通过。
- 发布后验证本地 `/api/meta`、认证 accounts/models/statistics/request logs/error logs/detailed settings、非法 quota-refresh 拒绝、内部 `ai-internal` 别名、控制台新功能标记和公开入口；90 秒后重复稳定性检查。当前公开域名在生产侧预检仍无 DNS 解析，按既有外部依赖故障记录，不因其单独回滚通过全部本地/内部门禁的 release。
- 任一硬门禁失败时恢复原始 config/metadata/logs、Compose/deployment，并以 `up -d --no-build` 恢复切换前 exact image；检测到未知并发漂移时停止自动覆盖并升级人工处理。
- 证据只记录哈希、计数、状态、版本和安全枚举，不输出 admin key、账号 Key/ID/名称、代理、Header、消息正文、原始会话、普通/详细日志内容或 HMAC 指纹。
- 不修改 NewAPI/CPA，不执行真实模型付费请求，不部署未提交工作树内容。

## Acceptance Criteria

- [x] 固定提交独立导出通过 syntax、完整测试、diff、allowlist、关键哈希和 SSH identity 门禁。
- [x] 只读生产预检证明切换前 exact image、健康、配置/数据哈希、资源、内部/公开入口和回滚基础可用。
- [x] 新 release/image 唯一且不可变；candidate Compose、复制数据预演与正式运行使用同一 exact image ID。
- [x] 副本预演证明 config/statistics 迁移仅含文档允许变化，普通日志后台恢复不阻塞监听且恢复后历史可查询。
- [x] 正式 Compose 仅改变 image/context；生产缓存池、账号配置和其他业务语义保持不变。
- [x] 新容器 exact image 匹配、healthy、restart=0、OOM=false，源码/config 哈希与预期一致。
- [x] 认证管理 API、普通/详细日志边界、内部入口、控制台标记和公开入口门禁通过；90 秒稳定性复核通过（公开域名维持切换前既有 DNS 故障）。
- [x] 旧 exact image、原始 Compose/deployment/config/metadata/logs 备份和无重建回滚路径保留可用。
- [x] 缓存活跃池观察任务明确记录本次版本切换边界，不虚构连续 24 小时验证结论。
- [x] 全过程无秘密泄露、无 NewAPI/CPA 或真实模型调用、无 release/image/log/cache/operator-data 清理。

## Out of Scope

- 调整缓存池成员、账号优先级、账号模式、容量等待或错误规则内容。
- 修改模型/provider 路由、账号启用状态、Key、代理、Header 或 quota 策略。
- 部署后立即宣称缓存命中率达到 70%，或篡改既有观察窗口。
- 清理旧 release、失败证据、镜像、构建缓存、日志或备份。
