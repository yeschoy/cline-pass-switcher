# OVH 生产发布：Cline `providerOptions` 403 兼容修复

## 状态

**已部署，业务请求验证通过；`awaiting-admin-acceptance`（管理员页面待验收）。**

用户明确同意发布及清理本次临时产物。目标为项目约定的 `ubuntu@167.114.158.4:49555:/opt/cline-pass-switcher`。最终容器于 **2026-11-07 10:32:24 UTC** 启动，10:32:30 UTC 通过健康门禁，10:33:23 UTC 完成真实聊天验证。

- 版本目录：`releases/20261107-2e8b32d-provider-options-403/`
- 发布源码：`main = origin/main = 2e8b32d8837b205a99c4d3667e717543c52ef31a`；业务修复提交为 `1d3cf82`。
- 镜像标签：`cline-pass-switcher:20261107-2e8b32d-provider-options-403`
- 镜像 ID：`sha256:519aad452f5ea73f2769195dda0f33141f963817bb562ff72f3d6030812c9b4c`
- 上一版本：`20261105-4c11582-deepseek-official-first`
- 上一镜像：`sha256:2cb390b301cc8ba230116398db50fd7c75a96ce7265466f42cf37eb2ae050485`

## 来源、备份与隔离预演

- 白名单 `git archive HEAD`，只含 `Dockerfile`、包清单、`server.js`、`lib/`、`public/`、README、LICENSE、`.dockerignore`、示例配置；不含本地凭据、数据、Trellis 或其他未提交目录。
- 源码包 SHA-256：`7a8f8c0a1d8ecae50fc608654abc562315148aec107857186347d0f676f65852`。
- `server.js` SHA-256：`3a477205b97d67a9c56dd838e2a02ed4b911cadef1f9fa1670670f5aab364ae2`。
- 全部 23 个归档文件在服务器落地后逐一验哈希；版本目录为 0755、文件为 0644。候选镜像和最终容器里的 18 个运行时文件也逐一验哈希。
- 使用正式 Compose 项目与目录构建候选，语义比较确认仅改变 image 和 build.context；切换采用 `up -d --no-build --no-deps cline-pass-console`，未在切换时重建镜像。
- 私有备份保留在 `backups/20261107-2e8b32d-provider-options-403/`，第二次切换前另存 `retry-2/`。只备份 Compose、部署记录、config、metadata、独立管理员状态；没有复制 raw 详细日志。
- 私有验证证据：`verification/20261107-2e8b32d-provider-options-403/`，保留准备、构建、预演、切换、回滚和验证记录。
- 精确候选镜像在生产数据副本上以 `1000:1000`、只读根、`cap-drop ALL`、`no-new-privileges`、16 MiB `/tmp`、**1 GiB 内存**、`--network none` 预演，启动标记与容器内 `/api/meta` 200 均通过；副本 config 和管理员认证文件哈希不变。容器 Node 为 **v22.23.4**。
- 原子安装/恢复 helper 在私有 scratch 文件上通过自测；首次准备阶段确认原容器、Compose、config 未变。
- 发布前对已提交源码再次运行完整 `npm test`：本机 Node v26.13.0，**675/675 通过**。未以此宣称 Node 18 已验证。

## 首次切换回滚与重试

首次候选已通过本机和内部网络健康检查，但公网 Python-urllib 默认 User-Agent 收到 Cloudflare **403 / error 1010**，触发发布门禁，已自动恢复上一健康镜像。config 与 Compose 的原哈希均复核一致，没有覆盖业务配置。

随后在**上一健康版本**复现：Python 默认 UA 仍为 403，而 `curl/8.5.0` UA 和独立客户端访问相同 `/api/meta` 均 200。因此修正的是公网验证探针，而不是应用或 Cloudflare 策略；未关闭或修改任何防护。补充第二份私有备份后，用同一个已验证候选镜像重试发布，全部机器门禁通过。

## 最终机器验证

| 项目 | 结果 |
|---|---|
| 运行状态 | `running / healthy`，重启 0，非 OOM |
| 本机 3123（Nginx）与 3124（应用）`/api/meta` | 均 200 |
| `ai-internal` 中 `cline-pass-switcher:3123/api/meta` | 200 |
| 公网 `https://clinepass.yeschoy.io/api/meta` | 标准 curl UA 与独立客户端均 200 |
| 有效客户端 key 的 `/v1/models` | 200 |
| 仅客户端 key 访问管理 `/api/models` | 401，管理隔离保持生效；**不是管理员登录成功的证据** |
| 运行时源码 | 18 个文件与已提交归档一致 |
| 配置与管理员状态 | 哈希不变 |
| 账号配置 | 61 个账号，56 个启用，`accountMode: sticky`，未改动 |
| 渠道硬限制 | 预检中规划器模型没有现存全局 exclude、持久隔离或未到期冷却；未自动解除任何限制 |

生产 config SHA-256 从发布前到最终检查保持：

`35a767d55416d9c6fb9b24bc88e24f0cb07bf57123a8cee2669a14f5ea6069a4`

未做配置迁移、未补写 `gatewayRoutingEnabled`；缺省官方接口由新代码选择兼容模式。metadata 为正常运行态写入，第二次切换前 SHA-256 为 `303d871da548a1c5819811c92deb4e76bd6c660fad74586adcb670b01a379990`，聊天验证后记录为 `11c328c8eeff48f50b9d0a0ee08a8ce38421a58b1a94839bddbd5bb5ae27f246`，之后仍可能继续更新。

## 已部署 switcher 的真实聊天验证

通过生产应用的 `/v1/chat/completions` 调用 `cline-pass/minimax-m3`，使用已配置的有效**下游客户端 key**，由原账号池正常选号。测试请求刻意保留客户端 `providerOptions.gateway` 和 `openaiCompatible`，验证部署版本确实清理被拒绝的字段。凭据仅在远端进程内使用，不进入命令参数、报告或本地文件。

| 请求 | HTTP | 可见内容 | SSE DONE | 目标 | 实际 HTTP attempts | 耗时 |
|---|---|---|---|---|---|---|
| 非流式 | **200** | 有 | 不适用 | `auto` | 1 | 0.84 秒 |
| 流式 | **200** | 有 | 完整 | `auto` | 1 | 0.73 秒 |

两次均无错误 envelope、无 `providerOptions` 路由拒绝；验证后容器仍 healthy、重启 0、config 哈希不变。这是本次已上线代码的实际调用证据，不宣称所有模型均已逐一测试，也不证明强制指定渠道仍可用。

## 待管理员验收

本会话没有独立管理员密码或有效管理会话，因此未声称以下受保护检查已通过：模型管理、统计、请求日志、详细日志设置，以及 quota-refresh 非法输入拒绝。请管理员登录控制台核对这些页面；确认后再将私有 `deployment.json` 状态更新为 `completed`。

这不影响“新代码已上线、真实聊天请求已通过”的结论。客户端 key 的 401 负向检查和本地 mock 不能替代管理员验收。

## 回滚与清理

- 版本、镜像、私有备份和验证证据均保留。此版本不写入不兼容 schema；如需回滚，先核对当前配置与数据兼容性，再原子恢复 `backups/20261107-2e8b32d-provider-options-403/retry-2/compose.yml`，执行 `docker compose --project-directory /opt/cline-pass-switcher --project-name cline-pass-switcher -f /opt/cline-pass-switcher/compose.yml up -d --no-build --no-deps cline-pass-console` 并复核旧镜像健康；恢复相应部署记录，不覆盖可能的后续管理员配置保存。
- 按用户本轮授权清理本地临时测试日志、本次部署专用临时目录与登记清单；远端 `/tmp` 中两个上传中转文件已在校验归属后删除。Trellis 日志、原有未提交任务目录、生产版本、镜像与私有备份不清理。
