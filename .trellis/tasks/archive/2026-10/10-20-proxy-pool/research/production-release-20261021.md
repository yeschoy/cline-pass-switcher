# 本机生产发布：代理池（20261021-68c6158-proxy-pool）

## 发布

- 源码：`main` = `origin/main` = `68c6158f42cabffc5384177939bc86f60df7f0a4`；按白名单 `git archive HEAD`（25 个成员，SHA-256 `dce0b198a6871ab060cc55fe3b00380782ea5589336c365945d4a31430c48844`）。
- 发布前门禁：完整 `npm test` 624/624 通过（含此前挂起的 `proxy-inflight-timeout`，已修复）。
- 版本 `20261021-68c6158-proxy-pool`，镜像 `sha256:2723f60e62867e017b9be78b4db5976328eaf6934ee5fd10d532e7d7a96824f1`；源文件哈希与 HEAD 一致，UID 1000 可读。
- 上一版本 `20261020-954cdf2-clinepass-cap` / `sha256:719cf62fc348384d2df94a442c6219dde9ce63ea8a35f952178ec29e1ab56583`，保留未清理。
- 部署脚本见 `research/deploy/`（沿用 drain 发布的 `ovh-deploy-*.py`，目标为本机 `/opt/cline-pass-switcher`）。本次调整：
  - preflight / stage 以运行中容器的镜像标签识别上一版本（`deployment.json` 此前未记录 drain 与 954cdf2 两次发布）；stage 把 `previousRelease` 写入构建证据，postcheck 据此写记录。
  - rehearse 改为"无配置迁移"门禁：候选启动后配置字节不变、不出现 `proxyPool`；旧镜像回读候选写出的数据。

## 迁移与回滚

- 无配置迁移：配置 SHA-256 发布前后均为 `c9d63cd73b0ed678d02c15b7cf6a41af49c038d3d355c4efc9c9ed70a05a5fb2`；私有副本演练 `configChangedPaths: []`。
- 旧镜像回读候选写出的 metadata/config：启动正常、配置字节不变，可直接换回旧镜像回滚。
- statistics v6、选号计数快照 v1（56 条）、admin-auth 未变、raw 详细日志未进入副本。

## 机器验收（切换后）

- 容器 running/healthy、0 次重启、无 OOM、1 GiB、只读根、CapDrop ALL、1000:1000。
- 本机应用、网关、内部别名、控制台、公网 `/api/meta` 均 200；仅客户端 key 访问受保护路由 401。
- `deployment.json` 已更新为本版本，状态 `awaiting-admin-acceptance`（同时补上了之前漏记的发布链）。
- 线上配置无 `proxyPool`（代理池保持关闭）；drain 设置已在线上：`drainEnabled: true`、阈值 95、并发上限 2、`warmThreshold: 90`、选号 `roundrobin`。

## FloppyData 真实冒烟（隔离容器）

- 方式：同一镜像、加固参数（只读根、CapDrop ALL、512 MiB）、host 网络但仅监听 127.0.0.1:3199、私有临时数据目录；最小配置仅含 1 个线上近期成功最多的账号，关闭后台探测与详细日志。测完删除容器与数据目录。
- 对照（代理池关闭，本机直连）：2 个请求 200，0.5～0.9 s。
- SIGHUP 热加载开启代理池：约 2 s 导入 20/20 个住宅会话（socks5、US、固定会话），`lastError: null`。
- `/api/proxy-pool/test` 抽样 5 个：全部连通（无凭据探测，上游 401 属预期）。
- 10 个真实请求（流式/非流式交替，`max_tokens` 32）：轮询到 10 个不同条目；9 个 200（1.1～1.9 s），1 个为上游渠道 500（provider 归因，非代理问题）；HTML 429 0、连接失败 0、回退 0。
- 流量：约 90 KB；余额约 12.0 GB。
- 泄漏检查：日志、metadata、选号计数、会话文件、容器输出中均未出现账号 key、FloppyData key、代理用户名前缀或密码；导入条目未写入配置文件。
- 备注：首次冒烟误选了一个线上不可用的账号（上游 403 `http_auth`），与代理无关，第二次改用近期成功账号。FloppyData 接口会拒绝 Python 默认 User-Agent（403），服务端 Node `fetch` 不受影响（已实测）。

## 待操作

- 代理池默认关闭；需要时在控制台"代理池"卡片开启 FloppyData（先查余额、测试条目）。
- 管理员登录控制台完成验收后，`deployment.json` 状态可改为 `completed`。
