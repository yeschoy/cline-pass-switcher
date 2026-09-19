# 生产发布执行计划

## 1. Source and preflight

- [x] 固定 committed HEAD、release name、allowlisted archive 和 SHA-256。
- [x] 独立导出通过 server/lib/UI syntax 与 165/165 tests。
- [x] SSH identity 固定路径、0600、gitignored、BatchMode 和 host Python/Docker/Compose 通过。
- [x] 只读生产预检记录当前 release/image/health/hash/config/statistics/log/API/internal/public 状态。
- [ ] 用户审阅计划后 `task.py start`。

## 2. Install immutable candidate

- [ ] 证明远程 release/upload/verification/candidate 路径唯一。
- [ ] 上传 archive 并核对双端 hash。
- [ ] 解包并规范化 0755/0644，验证 allowlist 和关键源码 hashes。
- [ ] 生成仅 image/context 变化的 candidate Compose。
- [ ] 最终 candidate Compose build 一次，记录 exact image ID；后续禁止 rebuild。

停止点：live compose/data/container 未改变，旧容器继续 healthy。

## 3. Private rehearsal

- [ ] 私有复制 config/metadata/logs，权限 0700/0600。
- [ ] exact image 以生产 UID/GID/hardening 在隔离环境启动。
- [ ] 验证监听与普通日志后台恢复。
- [ ] config diff 仅为 route `providerCooldownMs:0`。
- [ ] statistics v2→v3 仅新增 routing counters/coverage，既有 facts 完全保留且重启幂等。
- [ ] 记录预测 config hash、metadata projection 和日志恢复证据。

停止点：任何额外 diff、启动/恢复失败、capacity fence 或敏感投影。

## 4. Final freeze and backup

- [ ] 重新冻结 live hashes；若动态 metadata/logs 变化，使用最新副本重做 rehearsal。
- [ ] 备份 compose/deployment/config/metadata/logs 并生成 manifest。
- [ ] 验证 old tag/exact image 可 inspect。
- [ ] 私有 scratch 验证原子 install/restore helper 与 pre-mutation no-op guard。

## 5. Switch

- [ ] 原子安装 candidate Compose。
- [ ] `docker compose -f compose.yml up -d --no-build`。
- [ ] 要求 exact image、healthy、restart=0、OOM=false、config predicted hash、source modes/hashes 和 startup logs 通过。
- [ ] 失败时按 design 的 mutation/drift guard 完整 no-build rollback。

## 6. Immediate and delayed gates

- [ ] local meta、认证 accounts/models/statistics/request/error logs/detailed settings。
- [ ] 非法 quota-refresh 400，无真实模型请求。
- [ ] statistics v3/routingCoverage、UI affinity/setup/circuit/content-rule markers。
- [ ] `new-api → cline-pass-switcher` 内部别名。
- [ ] 公开 DNS/HTTP 按 preflight 基线判定。
- [ ] 90 秒后重复 image/health/restart/OOM/config/API/log readiness。
- [ ] 原子更新 deployment.json 与 rollback-ready report。

## 7. Record and finish

- [ ] 写入脱敏部署报告与证据。
- [ ] 检查 secrets、JSON、local/remote evidence consistency 和 `git diff --check`。
- [ ] 提交本任务 Trellis 证据，不包含 `AGENTS.md`、`untitled.md`、`.pi/subagents/`。
- [ ] 不推送、不清理生产数据或制品。
- [ ] 本地临时产物经用户同意后清理；Trellis evidence 保留。

## Immediate rollback

1. 检查 live 状态仍是本次 candidate 且无未知外部漂移。
2. 原子恢复备份 config/metadata/logs/compose/deployment。
3. 证明旧 exact image 存在，执行 `up -d --no-build`，禁止 rebuild。
4. 要求旧 image、healthy、restart/OOM、config hash、local/auth/internal API 恢复。
5. 保留失败 release/image/logs/backup/build cache/evidence。

## Completion status

- Release `20260919-172057-3ccb929-upstream-affinity` 已部署，exact image 为 `sha256:5a26c0c0fd6f78b0c19fc72d840f00cfcb87e990e74d1e32646843ff56577935`。
- Config 仅新增 16 个 `providerCooldownMs:0`；statistics v2→v3 升级 2169 个 aggregate；普通日志字节保持。
- 即时、90 秒延迟和独立 postcheck 全部通过；容器 healthy、restart=0、OOM=false。
- 公开 DNS 保持切换前既有不可用；未修改 NewAPI/CPA，未调用真实模型。
- 三次 pre-live 工具/观测失败均已留证，均未跨 live mutation boundary。
