# 本机生产发布：会话绑定代理跨换批保持（20261021-bccc906-pool-sticky-retain）

- 源码：`main` = `origin/main` = `bccc906`；白名单 `git archive HEAD`，25 个成员。镜像 `sha256:81a68596a71f178723c009f2240bd957ca696f5db12f3aa00a079262850ea657`。
- 上一版本 `20261021-5f2275f-pool-session-sticky`（`sha256:f6401dde…`），保留未清理，可直接换回回滚。
- 门禁：完整 `npm test` 638/638（前两次整套各有一个测试因端口冲突失败，换了不同测试、单独重跑均通过，与本次改动无关）；`git diff --check`。
- 变更：带明确会话 ID 的会话绑定到第一次选中的池条目，FloppyData 换批后仍用该条目，直到寿命结束（寿命 = 导入时起算的"轮换"时长；固定会话 0 按 60 分钟封顶；-1 与手动来源不保留）。只保留仍有绑定且在寿命内的旧条目，其余照旧立即退役。无新增配置字段。
- 发布时线上代理池已启用（FloppyData），配置 SHA-256 `2a184ef81ec2c152efc07d6ad8d4e23c9602e5347ac330fd095ddedc9574be81`，发布前后不变；演练 `configChangedPaths: []`，`schemaMigration: none`，旧镜像回读字节一致。演练容器 `--network none`。
- 切换后：容器 running/healthy、0 次重启、无 OOM；本机应用、网关、内部别名、控制台、公网 `/api/meta` 均 200。
- 发布会重启容器：进行中的请求被中断，FloppyData 条目与会话绑定只在内存中，重启后重新导入、重新绑定。
