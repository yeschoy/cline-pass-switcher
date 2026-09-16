# 全量部署额度预测面板

## Goal

将当前分支已提交的额度预测面板直接全量部署到固定生产服务器，在不灰度、不修改生产配置或账号数据的前提下完成版本化发布，并通过健康、API、内部网络及配置不变性门禁。

## Background

- 待发布功能提交为 `8b727b1 feat: add quota forecast panel`；当前已提交 `HEAD` 包含该功能及后续 Trellis 归档/会话记录，生产白名单发布包中的应用代码与已验证功能一致。
- 本次改动仅涉及静态控制台、前端测试和规范，不改变后端 API、持久化结构、配置 schema、额度刷新、调度或路由行为，因此没有配置迁移。
- 本地完整测试已通过 139/139，发布仍需从已提交 `HEAD` 生成白名单归档并核对应用文件哈希。
- 用户明确要求直接全量部署，不做灰度。
- 固定生产目标及发布契约由 `.trellis/spec/backend/deployment-guidelines.md` 定义。

## Requirements

- **R1 — 发布源：** 仅部署当前已提交 `HEAD` 的白名单归档；不得包含未提交工作区、SSH 私钥、本地配置、`.pi`、`.trellis` 或其他任务文件。
- **R2 — 安全预检：** 切换前验证 SSH 身份文件路径、gitignore、`0600` 权限和非交互认证；记录当前 release/image/container、健康、重启数、磁盘空间、账号数/模式及 `config.json` 哈希。
- **R3 — 不可变发布：** 使用唯一 release 名安装到 `/opt/cline-pass-switcher/releases/<release>/`，验证上传归档及关键应用文件哈希，不覆盖既有 release。
- **R4 — 备份与回滚：** 切换前版本化备份 `compose.yml`、`deployment.json`、`data/config.json` 和 `data/metadata.json`；保留旧镜像和 release。构建、启动、健康、镜像、配置哈希、必要 API 或内部网络检查失败时恢复旧 compose，并等待旧容器恢复健康。
- **R5 — 全量切换：** 不做灰度或双实例分流；预检通过后一次性将 compose 的 image 和 build context 切换到新 release，再执行 `docker compose up -d --build`。
- **R6 — 发布验证：** 新容器必须 running/healthy、RestartCount 0、镜像正确、无 OOM；本地 `/api/meta`、认证管理 API、quota-refresh 非法输入拒绝和 `ai-internal` 别名通过。控制台 HTML 必须包含额度预测面板标记。
- **R7 — 数据不变性：** 因本次无 schema 迁移，发布前后 `data/config.json` 必须字节哈希一致；账号数和账号模式必须保持不变。不得输出 `proxyKey`、账号 Key、Authorization、代理凭据或原始敏感响应。
- **R8 — 记录与保留：** 成功后原子更新无敏感信息的 `deployment.json`，保存验证报告和构建/哈希/备份证据；不清理 release、镜像、缓存、日志或生产数据。

## Acceptance Criteria

- [x] **AC1 / R1-R3：** 可证明远程 release 来自当前已提交 `HEAD` 的白名单内容，归档和关键应用文件哈希一致，且没有本地敏感/未提交文件进入发布物。
- [x] **AC2 / R2-R5：** 预检、备份和回滚材料完整后执行一次全量切换，没有灰度流量步骤或非必要生产修改。
- [x] **AC3 / R6：** 新容器运行健康、零重启、镜像匹配；本地、认证管理和内部网络门禁通过，控制台包含额度预测面板。
- [x] **AC4 / R7：** `config.json` 前后哈希一致，账号数/模式不变，验证输出不含凭据或敏感正文。
- [x] **AC5 / R4,R8：** 任一硬门禁失败时旧版本恢复健康；成功时 deployment/verification 记录完整且旧发布和备份均保留。

## Out of Scope

- 灰度、蓝绿流量分配、负载均衡拓扑调整或 NewAPI 渠道变更。
- 修改生产账号、Key、代理、路由、额度数据、日志保留策略或配置 schema。
- 合并分支、清理旧镜像/release/cache/log，或部署其他未提交工作区内容。
