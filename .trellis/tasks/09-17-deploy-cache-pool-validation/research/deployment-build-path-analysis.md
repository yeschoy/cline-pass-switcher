# 首次部署硬门禁复盘：Compose 镜像身份

## 已确认事实

- 首次尝试 release `20260917-084457-cbdee55-cache-pool` 已在账号配置前自动回滚；策略从未激活，配置 POST 为 0。
- 直接 `docker build` 产生的 candidate manifest ID 为 `sha256:f20f…fc4ca`。
- `docker compose up -d --build` 重新导出 manifest ID `sha256:e53c…d39d`。
- BuildKit 日志显示应用 COPY/RUN 层均命中相同缓存，但 Compose 构建给 image config 注入 `com.docker.compose.project/service/version` 标签并重新生成 provenance/attestation manifest。因此“源码相同”不意味着直接 build 与 Compose build 的 image ID 相同。
- 旧版本回滚使用 `up --build`，虽然旧 release 源码、配置和全部运行门禁恢复，但旧 tag 被重新构建为新 image ID，无法证明恢复到切换前 exact image ID。

## 根因类别

部署计划缺陷，不是应用代码、数据迁移或生产运行故障：迁移预演使用的不是最终 Compose 构建产生的精确镜像，而回滚也不应重新构建旧 tag。

## 修正后的唯一安全路径

1. 在远程根目录生成唯一 candidate Compose，确保相对 build context 与最终 compose 一致。
2. 先执行 `docker compose -f <candidate> build`，捕获该 tag 的 exact image ID。
3. 使用这个 exact Compose-built image 执行复制数据迁移预演和全部候选检查。
4. 原子安装 candidate Compose。
5. 使用 `docker compose -f compose.yml up -d --no-build` 切换，禁止再次导出 manifest。
6. 切换后要求容器 image ID 精确等于预演 image ID。
7. 回滚时恢复旧 Compose/config/deployment，并使用 `up -d --no-build`；切换前必须证明旧 tag/image ID 仍存在。

该路径需要用户明确批准后使用新的 immutable release 重试；首次失败 release、镜像、日志和备份继续保留，不覆盖、不清理。
