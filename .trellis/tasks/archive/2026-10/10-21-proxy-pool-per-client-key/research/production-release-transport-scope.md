# 本机生产发布：经池条目的传输中断不再降级账号（20261021-b1a9ae0-pool-transport-scope）

- 源码：`main` = `origin/main` = `b1a9ae0`；白名单 `git archive HEAD`，25 个成员。镜像 `sha256:1b0a967e19c3e2c85c022b1d8b1e9d19a7b276d8b02626c8b653b2d96a72ee98`。
- 上一版本 `20261021-c0547e4-pool-nonstream-bypass`（`sha256:19d3db2e…`），保留未清理，可直接换回回滚。
- 门禁：完整 `npm test` 641/641；`git diff --check`；新增集成测试在去掉修复时失败（归因为 `account`）。
- 背景：重启 08:45Z 之后 12 个经池的流式请求在收到部分内容后约 50 秒无数据而断开，全部被归为 `account` / `transport_proxy` 并降级账号（`action degrade`）。我们自己的超时（首事件 120 s、非流式 300 s、流式空闲 360 s）远大于 50 s，断开来自代理一侧。
- 变更：`egress.kind === 'pool'` 且 `terminalOrigin === 'proxy'` 的失败归因为 `scope=proxy`、`evidence=proxy_pool_transport`，走"不评估规则、不降级账号、不开 provider circuit"分支；不冷却条目、不换条目重试。账号固定代理、显式代理与直连的失败保持原归因。无新增配置字段。
- 配置 SHA-256 `2a184ef81ec2c152efc07d6ad8d4e23c9602e5347ac330fd095ddedc9574be81`，发布前后不变；演练 `configChangedPaths: []`，旧镜像回读字节一致。
- 切换后：容器 running/healthy、0 次重启、无 OOM；本机应用、网关、内部别名、控制台、公网 `/api/meta` 均 200。
- 未处理：代理 50 秒空闲切断本身（需 FloppyData 侧确认或换协议）。
