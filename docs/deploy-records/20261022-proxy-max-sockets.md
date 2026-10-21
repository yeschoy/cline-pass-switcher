# 本机生产配置变更：代理池连接上限提到 128（环境变量，无代码发布）

状态：已生效，容器 running/healthy。

- 变更：服务器 `/opt/cline-pass-switcher/compose.yml` 的 `environment` 新增 `CLINE_PASS_PROXY_MAX_SOCKETS: "128"`（原未设置，默认 32；取值范围 1～128，见 README 环境变量表）。仅新增这一行，镜像仍是 `20261022-08b2fe2-console-cleanup`，仓库代码未改，没有新的 release。
- 原因：长请求（约 1 万输入 + 4500 输出，耗时约 80 秒）在每个代理 60 rpm 时需要同时约 80 个连接，默认每个池代理 32 个连接会让超出的请求在本地排队。
- 操作：备份 `compose.yml.bak-before-20261022-053223-proxy-sockets` → `docker compose config -q` 校验 → `docker compose up -d cline-pass-console` 重建容器（环境变量不能热加载；重建会断开当时在途的流式请求一次）。
- 验证：`docker exec … printenv CLINE_PASS_PROXY_MAX_SOCKETS` = 128；容器 healthy；`config.json` 中代理池仍开启（6 条手动代理、`maxRpmPerProxy=60`）、55 个账号启用；本机 `/api/meta` 200。**未发真实长请求验证排队是否消除。**
- 回滚：把备份复制回 `compose.yml`，再 `docker compose up -d cline-pass-console`。
- 背景：出口 IP 限流复核见 `docs/upstream-ip-rate-limit-findings.md` 的 3.10、3.11。
