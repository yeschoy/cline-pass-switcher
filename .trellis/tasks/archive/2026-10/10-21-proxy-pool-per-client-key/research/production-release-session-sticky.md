# 本机生产发布：代理池会话粘性（20261021-5f2275f-pool-session-sticky）

- 源码：`main` = `origin/main` = `5f2275f307aaf64ab265158881532dbf82cd7894`；白名单 `git archive HEAD`，25 个成员，SHA-256 `0735878572b62324d4f6cf6728c2f3fe47357b5174fc0eac1d0dd9cd6092eae7`。
- 镜像 `sha256:f6401dde1518dd2672427cb199583aee1486a0acb7b97e8631dcef919fe893b5`；上一版本 `20261021-4b6ae7c-pool-client-keys`（`sha256:ff64d2a7…`），保留未清理。
- 门禁：完整 `npm test` 634/634；`git diff --check`。
- 变更：带明确会话 ID 的聊天请求按 HRW 固定在同一个池条目，条目不可用时落到次高权重条目；无新增配置字段。
- 发布时线上代理池已由管理员启用（FloppyData、轮询、100 个、API key 已保存，`proxyPoolClientKeys` 缺省），配置 SHA-256 `2d1d6aa2b6d62a6c662b6414406e77f8c96631c7fbdbb98e915204c100013d10`，发布前后不变。
- 演练脚本调整：原先断言 `proxyPool` 不出现在候选版本写出的配置里，已改为断言 `proxyPool` / `proxyPoolClientKeys` 与演练前完全一致。演练容器使用 `--network none`，不会连接 FloppyData。
- 无配置迁移；旧镜像回读候选写出的数据字节一致，可直接换回上一版镜像回滚。
- 切换后：容器 running/healthy、0 次重启、无 OOM；本机应用、网关、内部别名、控制台、公网 `/api/meta` 均 200。
- 发布会重启容器：进行中的请求被中断，FloppyData 条目只在内存中，重启后重新导入。
