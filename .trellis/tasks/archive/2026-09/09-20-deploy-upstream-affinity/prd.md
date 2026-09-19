# 部署上游亲和版本

## Goal

将 `feat/quota-forecast-panel` 已提交的 `HEAD=3ccb92984eca4b282e158027bf571b7ffab06bb0` 以全新不可变 release 部署到既定生产服务器，使生产获得 Codex/Claude Chat 会话亲和、安全缓存日志提示、账号作用域 provider 校验、一键配置、provider cooldown/half-open 和 routing statistics；完整保留当前账号、缓存池、错误规则、模型路由、代理/Header、日志和运行数据。

## Background

- 固定生产目标：`ubuntu@167.114.158.4:49555`；远程根 `/opt/cline-pass-switcher`；Compose/service/container 为 `compose.yml` / `cline-pass-console`。
- 当前生产 release 为 `20260919-110817-b2d676d-stats-logs-rules`，commit `b2d676d11e0d4422aef83854670b6bceb89401a0`，exact image `sha256:fb5d9de7dc6643201a333ed47e7064464df3615598cd0fb3c91ad3ffc2f91cf2`；容器 healthy、restart=0、OOM=false，旧 image 可 inspect。
- 当前安全配置投影：10 个账号、8 个启用，sticky、wait 2000、`cachePoolSize=5`、5 条状态规则、0 条内容规则、16 条全局模型路由、0 条账号路由。
- 当前 metadata 为 statistics v2、653 个分钟桶，model tracking 已启用，routing tracking 尚不存在；普通日志 3 个文件、5,842,489 bytes。
- 本次启动会执行受控 schema 迁移：16 条全局 route 缺失时补 `providerCooldownMs: 0`；statistics v2→v3 为固定 aggregates 增加 routing counters，并新增 `routingTrackingStartedMinute`。不得产生其他配置语义变化。
- 当前内部 Docker 网络为 `ai-internal`，服务别名为 `cline-pass-switcher`；从 `new-api` 容器访问 `/api/meta` 已通过。公开域名仍无 DNS，属于切换前既有外部依赖故障。
- committed-source 独立导出已通过 server/lib/UI syntax、完整 165 项测试和 production archive allowlist。固定 release 名为 `20260919-172057-3ccb929-upstream-affinity`，archive SHA-256 为 `95969d2f49c303d646f981cfefd23a87d51c7e9097cc6bdfa87dde34249776b6`。
- 当前工作树仍有无关的 `AGENTS.md`、`untitled.md`、`.pi/subagents/`；生产包只来自 committed HEAD allowlisted `git archive`，不得包含工作树、`.trellis`、`.pi`、本地数据或 SSH identity。

## Requirements

- 在任何生产写入前再次核对 identity 固定路径/gitignore/0600、非交互 SSH、host Python/Docker/Compose、当前 exact image/health、磁盘、Compose/deployment/config/metadata/logs 哈希和安全 API 投影。
- 上传并核验固定 allowlisted archive，安装到从未存在的新 release；目录统一 0755、文件 0644，关键源码哈希与 committed HEAD 一致。
- 在最终生产根目录生成 candidate Compose，只改变 image tag 与 `build.context`；通过该 candidate Compose 仅构建一次并捕获 exact image ID，后续 rehearsal/switch/rollback 均禁止 rebuild。
- 在 0700/0600 私有数据副本中，以生产 UID/GID 1000:1000 和相同 hardening 运行 exact candidate image。要求启动、健康、普通日志恢复和 API readiness 通过。
- 副本迁移必须证明：config 只为现有 route 补 `providerCooldownMs:0`；statistics v2→v3 保留全部既有 global/account/model/health/cache facts，仅新增 routing counters 与 routing coverage；普通日志仍完整可查。任何额外差异停止切换。
- 切换前备份 compose、deployment、config、metadata 和普通 logs，记录 manifest；保留旧 exact image、release、build cache、详细日志和全部操作员数据。
- 正式切换仅原子替换 candidate Compose，执行 `docker compose -f compose.yml up -d --no-build`；要求 candidate exact image、running/healthy、restart=0、OOM=false、预测 config hash、源码哈希和 bounded startup logs 通过。
- 发布后验证 `/api/meta`、认证 accounts/models/statistics/request/error logs/detailed settings、非法 quota-refresh 400、内部 `new-api → cline-pass-switcher`、UI 亲和/一键配置/内容规则标记；不发送真实模型请求。
- 90 秒后重复 exact image、health/restart/OOM/config/API/log readiness；公开 DNS 继续按预先存在的外部故障报告，不单独触发回滚。
- 任一硬门禁失败时，仅在 live 文件仍匹配本次预期且无未知外部漂移时，恢复备份 config/metadata/logs/compose/deployment，并用旧 exact image `up -d --no-build` 回滚；不得 stop-first、不得 rebuild。
- 部署成功后原子更新 `deployment.json`，写入 release、commit、exact image、source hashes、previous release 和安全门禁事实，不含秘密。
- 不修改 NewAPI/CPA，不调整账号、缓存池成员、priority、mode、wait、错误规则、模型/provider 路由、Key、代理、Header 或 quota；不推送、不清理生产 release/image/log/cache/backup。

## Acceptance Criteria

- [x] committed source、archive、identity 和只读生产预检全部通过。
- [x] 新 release/candidate/exact image 唯一，源码/权限/Compose 差异符合固定合同。
- [x] 私有副本预演证明 config route 默认与 statistics v3 迁移精确、日志恢复正常且无额外语义变化。
- [x] 切换前备份、manifest、旧 exact image 与 no-build 回滚路径可用。
- [x] 新容器 exact image 匹配、healthy、restart=0、OOM=false，config hash 与副本预测一致。
- [x] 认证 API、日志、统计 routing coverage、控制台标记和内部别名门禁通过；90 秒复核稳定。
- [x] 公开 DNS 仅按切换前既有故障报告；未修改 NewAPI/CPA，未发送真实模型请求。
- [x] 完整脱敏部署证据已持久化并提交；秘密模式扫描为零命中，无生产数据正文或原始会话进入证据。

## Out of Scope

- 修改或重新配置 NewAPI/CPA。
- 修改生产业务配置，或启用非零 `providerCooldownMs`。
- 真实模型/付费请求和缓存命中率效果验证。
- 清理任何生产 release、image、build cache、日志、详细日志、备份或操作员数据。
