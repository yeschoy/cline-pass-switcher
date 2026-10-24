# 本机生产发布：响应头返回 X-Oneapi-Request-Id，关联 new-api 用户日志（20261024-73f3a6b-oneapi-request-id）

状态：已部署，`awaiting-admin-acceptance`（沿用上一版的管理员验收状态，本次未动控制台页面）。

- 源码：`main` = `73f3a6b`；白名单 `git archive 73f3a6b`（23 个文件，tar sha256 `0191b0e1…`），`server.js` `9b015866…` 与提交一致；与线上 `c164694` 的 release 目录相比只有 `server.js` 与 `README.md` 不同。镜像 `sha256:7d9d4427579d45109bb95ef244b471de24767d6be46173ac00f437e9c5fd5014`。
- 上一版本 `20261024-c164694-wrapped-request-error`（`sha256:68613d23…`），镜像保留；`compose.yml` 备份为 `compose.yml.bak-before-20261024-73f3a6b-oneapi-request-id`，`deployment.json` 备份为 `deployment.json.before-20261024-73f3a6b-oneapi-request-id`。
- 起因：要按 new-api 用户追查请求。new-api（`7e4d238`）的请求头覆盖只支持 `{api_key}` 与 `{client_header:…}`，参数覆盖上下文的 `user_id` 只能做条件、不能当值，无法不改代码把用户标识传下来。但 new-api 会把上游响应头 `X-Oneapi-Request-Id` 存进 `logs.upstream_request_id`（有索引，且不转给最终客户端）。
- 变更：每个代理请求在 `X-Cline-Request-Id` 之外，以同一 UUID 返回 `X-Oneapi-Request-Id`。不改任何请求、调度或日志字段。
- 门禁：完整 `npm test` 663/663；集成测试断言两个头相等。候选镜像在断网、只读根、UID 1000、空数据目录下启动，`/api/meta` 200，代理响应两个头值相同。
- 发布：容器 23:32:09（本地时间）切换，running/healthy、0 次重启、无 OOM；直连 3124、网关 3123、new-api 容器经内部别名访问 `/api/meta` 均 200，启动日志无错误；`data/config.json` SHA-256 `5019f88b…` 切换前后不变。
- 验证：23:32:35 之后发出的、经通道 71 的 45 条 new-api 消费日志全部带 `upstream_request_id`；抽查 `b94eb043…` 在 switcher 请求日志中存在（200），在 new-api 对应用户 `746`。切换窗口 23:32:11–23:32:34 有 70 条 new-api `do request failed`（容器重建期间无监听，无 ID）；上一次发布 22:42:16–22:42:41 同类 102 条，属既有的重建停机窗口，本次未改变。
- 用法：new-api 日志按用户筛选得 `upstream_request_id` → switcher `/api/logs/requests?requestId=…`、`/api/logs/errors?requestId=…`；反向按 `upstream_request_id` 查 new-api 用户。new-api 跨渠道重试时只保留最后一次上游的 ID；切换前的旧日志没有该字段。
- 回滚：`compose.yml` 换回 `compose.yml.bak-before-20261024-73f3a6b-oneapi-request-id`，`deployment.json` 换回对应备份，再 `docker compose up -d --no-build --no-deps cline-pass-console`。
- 未做：重建期间约 23 秒的连接拒绝窗口（每次发布都有）未处理，如需零中断发布需另行设计。
