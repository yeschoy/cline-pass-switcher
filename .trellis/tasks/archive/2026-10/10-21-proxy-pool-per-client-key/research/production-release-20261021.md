# 本机生产发布：代理池按客户端密钥开关（20261021-4b6ae7c-pool-client-keys）

## 发布

- 源码：`main` = `origin/main` = `4b6ae7ccb80b741b8be82b2eaddd464e133ef69f`。用白名单 `git archive HEAD` 打包，共 25 个成员，SHA-256 为 `2e53ef42fa27fee9c8815b420932fb79f83dbb1be33a7941ae570dbd2641714f`。
- 发布前门禁：
  - 完整 `npm test` 632/632 通过（实现和检查两轮各跑一次）。
  - `git diff --check` 通过。
  - 秘钥扫描只命中测试里的 `127.0.0.1` 占位地址。
- 版本 `20261021-4b6ae7c-pool-client-keys`，镜像 `sha256:ff64d2a7616dc356ef06067cebef040f47b844883590ed7fc7e027a54512c4e4`。源文件哈希与 HEAD 一致，UID 1000 可读。
- 上一版本 `20261021-68c6158-proxy-pool`，镜像 `sha256:2723f60e62867e017b9be78b4db5976328eaf6934ee5fd10d532e7d7a96824f1`，保留未清理。
- 部署脚本在 `research/deploy/`，沿用 `archive/2026-10/10-20-proxy-pool` 的脚本，只改了一处：rehearse 门禁另外要求候选版本写出的配置里不能出现 `proxyPoolClientKeys`。

## 迁移与回滚

- 无配置迁移：
  - 发布前后配置 SHA-256 都是 `2ae965e0011927dd90b5345748790e6716ebc37ab9220b3e36c1b696bdfdeb45`。
  - 在私有副本上演练，结果为 `configChangedPaths: []`，`schemaMigration: none`。
- 旧镜像（68c6158）回读候选版本写出的数据：能正常启动，配置字节不变。需要回滚时直接换回旧镜像即可。旧镜像会保留 `proxyPoolClientKeys` 字段但不使用它，此时恢复为全局开关的行为。
- statistics v6、选号计数快照 v1（56 条）、admin-auth 都没有变化，raw 详细日志没有进入副本。

## 机器验收（切换后）

- 容器状态：running、healthy，0 次重启，没有 OOM。内存 1 GiB，只读根文件系统。
- 本机应用、网关、内部别名、控制台和公网 `/api/meta` 都返回 200。只带客户端 key 访问受保护路由时返回 401。
- 切换后 5 分钟内容器日志里没有错误或警告。
- `deployment.json` 已更新为本版本，状态为 `awaiting-admin-acceptance`。
- 线上配置里没有 `proxyPool` 和 `proxyPoolClientKeys` 两个字段，代理池保持关闭，与之前一致。

## 待操作

- 需要时在控制台的"代理池"卡片中开启代理池，并在"按客户端密钥"小节中选择哪些密钥使用代理池。没有单独设置的密钥默认使用。
- 管理员登录控制台完成验收后，可以把 `deployment.json` 的状态改为 `completed`。
