# 部署单渠道健康重试到生产

## Goal

将已推送且与远程一致的 `origin/main@9ecc84d` 构建为全新不可变 release，部署到既定生产服务器，使生产获得单 provider 外层重试、保守 429 归属分类和持久化 `模型 × provider` 健康路由，同时完整保留现有账号、会话亲和、缓存池、内容错误规则、详细日志、统计、路由和业务数据。

## Background

- 固定源分支为 `main`，本地 `main` 与 `origin/main` 当前均为 `9ecc84d`；不得从 `排查问题` 或工作树文件构建。
- 固定生产目标为 `ubuntu@167.114.158.4:49555`，远程根 `/opt/cline-pass-switcher`，Compose/service/container 为 `compose.yml` / `cline-pass-console`。
- 上一份已归档生产证据显示旧 release `20260919-172057-3ccb929-upstream-affinity` 曾健康运行；本次必须重新只读冻结实际当前 release、exact image、配置、metadata、日志和 API 状态，不能假定生产仍停留在该版本。
- `main@9ecc84d` 已在合并后通过完整 166/166 测试；部署前仍需对 committed archive 再执行源门禁。
- 本版本不新增静态配置字段，但启动时会把既有 `metadata.models[*].upstreamStatus[provider]` 规范化为新的持久化 provider-health 结构；必须在生产数据副本上验证唯一允许的 metadata 差异。`config.json` 不允许出现未声明语义变化。
- 生产发布遵循 `.trellis/spec/backend/deployment-guidelines.md`，只允许 immutable release、exact Compose-built image、生产 hardening 副本预演、no-build 切换和可验证回滚。

## Requirements

1. 在生产写入前证明：当前工作目录为 `main`、提交为 `9ecc84d`、本地 `main == origin/main`，构建包来自 committed allowlist archive；任务/Trellis 工作树改动不得进入 release。
2. 验证仓库内固定 SSH identity 路径、gitignore、0600、BatchMode；重新读取生产当前 exact image/health/restart/OOM、磁盘、Compose/deployment/config/metadata/logs 哈希、安全配置投影、管理 API、内部网络别名和公开 DNS 基线。
3. 创建从未存在的新 release，目录 0755、文件 0644；核对 archive、release 成员及关键源码哈希。
4. Candidate Compose 只能改变 image tag 与 `build.context`；使用最终 candidate Compose 构建一次并锁定 exact image，后续预演、切换和回滚均不得 rebuild。
5. 在私有生产数据副本上，以 UID/GID 1000:1000、read-only root、cap drop、no-new-privileges、tmpfs 和隔离网络运行 exact candidate image；验证启动、健康、API 与普通日志恢复。
6. 副本预演必须证明：`config.json` 无未声明语义变化；metadata 只发生本版本 provider-health 规范化及当前代码已经声明的幂等迁移，既有 statistics/account quota/model discovery/provider status 核心事实不丢失；第二次启动幂等。
7. 切换前备份 compose、deployment、config、metadata 和 ordinary logs，生成 manifest；验证旧 exact image 可 inspect、scratch 原子 install/restore helper 和 pre-mutation no-op guard。
8. 正式切换只允许原子安装 candidate Compose并执行 `docker compose -f compose.yml up -d --no-build`；任一硬门禁失败且无未知漂移时恢复备份和旧 image。
9. 即时和 90 秒延迟门禁要求：candidate exact image、running/healthy、restart=0、OOM=false、config 预期 hash、源码 hash、bounded logs、`/api/meta`、认证 accounts/models/statistics/request/error logs/detailed settings、非法 quota-refresh 400、内部 `new-api → cline-pass-switcher` 别名全部通过。
10. UI/source 门禁必须包含单 provider `only`、provider health/cooldown、429 scope/evidence 字段，同时保留 affinity、content rules、detailed logging、cache pool 等 main 现有标记。
11. 不发送真实模型或付费请求；不修改 NewAPI/CPA、账号配置、mode、wait、缓存池、错误规则、模型路由、Key、代理、Header、quota；不清理生产 release/image/log/cache/backup。
12. 成功后原子更新 `deployment.json`，保存不含秘密的完整 evidence、回滚材料和独立只读 postcheck。

## Acceptance Criteria

- [x] 部署源被证明为 committed `origin/main@9ecc84d`，archive allowlist/hash/权限/源码门禁通过。
- [x] 生产当前状态和公开 DNS 在切换前完成只读冻结，无秘密进入本地或远端 evidence。
- [x] 新 release、candidate Compose 和 exact image 唯一；Compose 除 image/context 外无差异。
- [x] 私有数据副本预演通过生产 hardening，config/metadata/logs 差异精确且二次启动幂等。
- [x] 切换前备份、manifest、旧 exact image、原子 helper 和 no-build rollback 均可用。
- [x] 新容器 exact image 匹配，healthy、restart=0、OOM=false，配置和关键源码校验通过。
- [x] 即时、90 秒延迟和独立 postcheck 的本地/认证/内部 API 及日志门禁全部通过。
- [x] 未修改 NewAPI/CPA 和业务配置，未发送真实模型请求，未清理生产制品。
- [x] 脱敏部署报告和 Trellis evidence 已持久化；非业务本地/远端临时产物按用户授权清理。

## Out of Scope

- 修改生产业务配置或启用/调整 route `providerCooldownMs`。
- 真实 Chat、缓存命中率、供应商故障注入或付费请求验证。
- 修复公开 DNS、修改 NewAPI/CPA 或其他服务。
- 删除任何生产 release、image、build cache、日志、详细日志、备份或操作员数据。
