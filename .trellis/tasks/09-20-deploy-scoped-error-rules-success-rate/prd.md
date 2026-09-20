# 部署双维度错误规则与成功率

## Goal

将当前 `main` 上已提交的统一 `errorRules`、账号与 `(resolvedModel, provider)` 双维度状态、statistics v4 24 小时直接成功率、三步账号流水线和管理界面安全部署到既定生产服务器，并以复制数据迁移预演、即时/延迟/独立门禁和可验证回滚证明发布成功。

## Background

- 实现提交为 `cb19f2e`，规范提交为 `1008fc8`；实现任务已归档并记录 journal。部署前会冻结包含这些提交的最终 `main` HEAD，并要求本地 `main == origin/main`。
- 固定生产目标、identity、远程根、Compose 服务、不可变 release、exact image、no-build 切换及回滚契约由 `.trellis/spec/backend/deployment-guidelines.md` 定义。
- 本版本会在启动时把 legacy 规则迁移为 canonical `errorRules`、把四步账号流水线规范化为三步、把 statistics v1/v2/v3 迁移到 v4，并扩展账号及 Provider-model 状态；这些变更必须先在生产数据副本上证明结构差异精确且二次启动幂等。
- 生产配置、metadata、普通/详细日志及凭据不得复制到本地、打印或写入 Trellis evidence。证据只保留哈希、计数、状态和安全枚举。
- 用户已明确授权生产部署与验证；不授权真实付费模型请求、业务配置调整或生产清理。

## Requirements

1. 部署源必须是已提交、已推送且与 `origin/main` 一致的本地 `main`；release 只能来自 allowlisted `git archive`，不得包含工作树、`.git`、`.trellis`、本地数据或 SSH identity。
2. 在任何远端写入前验证 identity 精确路径、gitignore、0600、BatchMode SSH、主机 helper、Docker/Compose、磁盘、当前 container/exact image/health/restart/OOM、Compose/deployment/config/metadata/logs 哈希和安全 API 投影。
3. 冻结切换前 canonical 业务投影：账号数量/启用数、mode、wait、cache pool、规则数量、pipeline、模型/provider/state/statistics 版本与 cell 计数；不得记录账号标识、名称、Key、代理、Header、规则 needle、消息或会话。
4. 创建唯一不可变 release，目录 0755、文件 0644；candidate Compose 只能改变 image tag 和 build context，且只构建一次并锁定 exact Compose-built image。
5. 在私有生产数据副本上以生产 UID/GID 1000:1000 与 read-only root、cap drop、no-new-privileges、tmpfs、隔离网络运行 exact candidate image；不得发起真实模型请求或外部上游流量。
6. 复制数据预演必须证明：
   - config 变化仅为文档声明的 legacy rules → canonical `errorRules`、legacy four-step → canonical three-step 及兼容 mirror；账号、Key、route、proxy/Header、mode、wait、cache size、priority 等业务语义不变；
   - metadata 变化仅为 statistics v4 空成功率 owner/coverage 起点、账号/Provider 状态规范化和既有幂等迁移；旧统计/配额/模型发现事实不丢失；
   - 普通日志字节不变且异步恢复后可查询；第二次启动对 config/metadata/logs 幂等。
7. 切换前备份并 hash 校验 Compose、deployment、config、metadata、ordinary logs；验证旧 exact image 可用、原子 install/restore scratch helper 和 pre-mutation no-op guard。
8. 正式切换仅原子安装 candidate Compose，并执行 `docker compose ... up -d --no-build`；任一硬门禁失败且无未知并发漂移时恢复原始 config/metadata/logs/Compose/deployment 和旧 exact image。
9. 即时、90 秒延迟和独立只读 postcheck 必须验证 candidate exact image、running/healthy、restart=0、OOM=false、源码 hash、预测 config hash、安全迁移投影、启动日志、local `/api/meta`、认证 accounts/models/statistics/request/error logs/detailed settings、非法 quota-refresh 400 和 `ai-internal` 网络别名。
10. UI/source 门禁必须覆盖 canonical errorRules、Provider 精确恢复、账号/Provider 成功率及 coverage、三步 pipeline，并保留既有 affinity、singleton provider、详细日志和 cache pool 标记。
11. 若公开 DNS/HTTP 在切换前可用，则切换后失败是硬门禁；若切换前已复现 DNS 不可用，只记录外部依赖降级，不因其单独回滚全部本地/内部门禁已通过的 release。
12. 成功后原子更新远端 `deployment.json`，持久化不含秘密的部署报告、JSON evidence、回滚引用和独立 postcheck；不清理任何生产 release、image、cache、日志、备份或 operator data。

## Acceptance Criteria

- [x] 最终 source gate 证明本地 `main == origin/main`，committed archive、完整测试、关键 hash、identity/SSH 全部通过。
- [x] 切换前只读预检冻结当前 exact image、健康、配置/数据哈希、安全投影、内部与公开入口基线且无秘密泄露。
- [x] 新 release/candidate Compose/exact image 唯一，Compose 只改变 image/context，release/image 文件权限满足 1000:1000 运行。
- [x] 复制数据 hardening 预演精确证明 config/statistics/state 迁移边界、日志恢复和二次启动幂等。
- [x] 切换前备份、manifest、旧 image、scratch 原子 helper、no-op guard 和 no-build rollback 均可用。
- [x] 新容器 exact image 匹配，healthy、restart=0、OOM=false，预测 config hash、源码 hash 和安全 schema 投影正确。
- [x] 即时、90 秒延迟及独立 postcheck 的本地/认证/内部 API、日志和 UI/source 门禁全部通过。
- [x] 未调用真实模型、未修改 NewAPI/CPA 或业务配置、未清理生产制品；公开入口按切换前基线正确处置。
- [ ] 脱敏部署证据已提交并推送，部署任务完成归档；非业务临时产物仅在用户另行同意后清理。

## Out of Scope

- 发送真实 Chat、付费请求或注入生产 Provider/账号故障。
- 调整账号、规则、mode、wait、cache pool、priority、route、Key、代理、Header、quota 或其他业务配置。
- 修改 NewAPI/CPA、DNS、证书或其他服务。
- 部署后立即宣称 24 小时成功率稳定；新指标从迁移时刻开始积累。
- 删除任何生产 release、image、build cache、日志、详细日志、备份或 operator data。
