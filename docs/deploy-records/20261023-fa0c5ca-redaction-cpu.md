# 本机生产发布：大请求脱敏/转发 CPU 优化（20261023-fa0c5ca-redaction-cpu）

状态：已部署（用户手工按 a90d32c 同款流程执行，本记录为事后核对）。

- 源码：`main` = `fa0c5ca`；白名单 `git archive fa0c5ca` 到 `releases/20261023-fa0c5ca-redaction-cpu`，`server.js`、`lib/detailed-log-capture.js` 的 SHA-256 与提交一致。镜像 `sha256:8faf23059d60d78c85d0b2aff9514dfa504b5b92c57e5675cc5587122f6b1244`。
- 上一版本 `20261023-a90d32c-namespace-tools`（`sha256:53c7b23d…`），镜像保留；`compose.yml` 备份为 `compose.yml.bak-before-20261023-fa0c5ca-redaction-cpu`。
- 起因：监控抓到 cline-pass 的 Node 进程处理大请求时单核跑满约 1 秒。本地 mock 上游 + CPU profile 定位：失败请求走 error 脱敏时，`DetailRedactor.learn()` 对请求体里每个字符串 `new URL()`（绝大多数靠抛异常退出），`credentialName()` 对代码里每个 `foo =`/`foo:` 做两遍正则归一化；成功路径 `injectPrefs()` 用 JSON 深拷贝把几 MB 的 messages 重新序列化一遍。
- 变更：`url()` 先按 WHATWG 绝对 URL 必要条件预判，判不过直接原样返回（与原来抛错后的结果一致）；`credentialName()` 加 4096 条有界缓存；`injectPrefs()` 改浅拷贝（只改顶层 provider/providerOptions，结果只用于 JSON.stringify）。
- 门禁：完整 `npm test` 662/662；新增单测锁住 URL 快路径（前导空白、scheme 内嵌 tab 的凭证 URL 仍被学习并脱敏，普通文本原样返回）。本地基准：5MB 请求上游 429 时 CPU 0.38–0.45s → 0.15–0.18s、并发请求最大卡顿 293ms → 76ms；6.5MB 流式成功 CPU 0.17–0.27s → 0.06–0.15s、卡顿 72ms → 22ms。
- 发布：容器 16:46:20（本地时间）切换，running/healthy、0 次重启；`/api/meta` 直连 3124 与网关 3123 均 200；启动日志无错误。`data/config.json` SHA-256 现为 `1f02caf1cd168588ba82…`，与上一条记录的 `5cf5ab92…` 不同，但其修改时间 16:16:41 早于本次容器启动 30 分钟，属于控制台日常改动，与发布无关。
- 回滚：`compose.yml` 换回 `compose.yml.bak-before-20261023-fa0c5ca-redaction-cpu` 并 `docker compose up -d --no-build --no-deps cline-pass-console`。
- 未做：生产那次 16:12:25 尖峰的实证（容器内配置/日志读取被会话权限拦截），归因基于代码与本地复现。
