# 本机生产发布：隐式"本机直连"条目（20261022-9e1f7be-pool-direct-entry）

- 源码：`main` = `origin/main` = `9e1f7be`；白名单 `git archive HEAD`，25 个成员。镜像 `sha256:55190810665d42f8928101825e6da87969413c942b542455a46d301c461b5b79`。
- 上一版本 `20261021-4fffc30-pool-batch-validate`（`sha256:4eb785ce…`），保留未清理，可直接换回回滚。
- 门禁：完整 `npm test` 651/651；`git diff --check`；改动与新增测试中无真实代理地址或凭据（用占位值）。
- 变更：新增顶层配置 `proxyPoolDirect`（布尔，缺省 false 且不写回）。为 true 且代理池开启时，池里多一个不经代理的隐式条目，与各代理平等参与轮询/随机、会话粘性、每分钟上限、429 冷却与换条目重试；日志显示 `pool:<8hex>`，不记 `poolFallback`，不写 proxyHealth 键，不参与抽样测试。放在顶层以保证旧镜像不报错（旧镜像保留并忽略该字段）；旧镜像（4fffc30）保留字段已由集成测试覆盖。
- 同时记录：当天把 6 个手动代理写入线上池（`source: manual`、`maxRpmPerProxy: 60`、轮询、启用），写入前连通性测试 6/6 通过，配置备份在服务器 `private-backups/pool7-*`；此处不记录任何代理地址。
- 发布：配置 SHA-256 `05cdaf7938ff0100c4d8f1a79af7bb053d4ed3a0095eac4fd7b9a9efb2e0c850` 发布前后不变；演练 `configChangedPaths: []`，旧镜像回读字节一致。切换后容器 running/healthy、0 次重启；本机应用、网关、内部别名、控制台、公网 `/api/meta` 均 200。
- 随后在线上打开 `proxyPoolDirect: true`（备份 `private-backups/pool-direct-*`），SIGHUP 热加载完成，无重启。
