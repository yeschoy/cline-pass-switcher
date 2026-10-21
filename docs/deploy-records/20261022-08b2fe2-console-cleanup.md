# 本机生产发布：控制台旧版兼容清理（20261022-08b2fe2-console-cleanup）

状态：已部署，`awaiting-admin-acceptance`（登录后的受保护页面待管理员在浏览器确认）。

- 源码：`main` = `origin/main` = `08b2fe2`（含 `e3b938a`、`08b2fe2` 两个提交）；白名单 `git archive HEAD`，25 个成员，`server.js` 哈希与 HEAD 一致。镜像 `sha256:9e97175fec40ca744e80c3c62db3fb92bb15464781da27f04e376a911a9c6aa8`。
- 上一版本 `20261022-9e1f7be-pool-direct-entry`（`sha256:55190810…`），镜像保留，可直接换回回滚。
- 变更：控制台移除调度模式、策略预设、旧调度流水线块、单账号单选列、工作流启用开关及旧统计/日志兼容文案；保存时一律提交 `enabled:true` 并透传服务端已有的 `accountMode`/`accountPipeline`。Legacy 密钥显示名改为「默认密钥」（持久化 ID 仍为 `legacy`）；管理接口新建/重命名额外密钥时保留该名称。无数据格式变更，旧镜像可直接读写现有数据。
- 门禁：完整 `npm test` 648/648；`git diff --check`；隔离启动演练（UID 1000、只读根、无网络、数据副本）容器稳定运行，配置字节不变。
- 发布：配置 SHA-256 `9d7ff1d148891a8eff74f975620f74abda7d1cf8871c08e71817979c33ddfb1a` 切换前后不变。切换后容器 running/healthy、0 次重启、无 OOM；本机、内部别名、公网 `/api/meta` 均 200；线上页面含「默认客户端密钥」，不含「Legacy」、旧流水线块和模式下拉。
- 备份：服务器 `private-backups/pre-20261022-08b2fe2-console-cleanup/`（compose、deployment.json、config、metadata、admin-auth）。
- 待办：管理员在浏览器确认账号管理（选号工作流区域）与「访问与安全」页；服务器上的 `deployment.json` 仍记录上一版本，需 root 更新。
