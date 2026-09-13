# 账号代理与日志存储技术调研

## 当前代码事实

- `server.js` 的 Cline chat 传输统一经过原生 `http.request` / `https.request`，适合通过 `agent` 参数接入账号代理。
- 公共模型目录和文档抓取走其他 `fetch` 路径；账号代理不得接入这些路径。
- 项目当前声明 Node `>=18` 且无运行依赖；生产 Docker 使用 Node 22。
- `metadata.json` 当前包含最近 100 条历史；继续在每次请求时原子重写整个 JSON 不适合 50,000 条请求日志。

## 代理实现选择

官方 `TooTallNate/proxy-agents` 项目按目标请求协议提供代理 Agent：

- HTTP/HTTPS 代理 + HTTPS 目标：`https-proxy-agent`，通过 CONNECT 隧道；代理 URL 可为 `http:` 或 `https:`。
- SOCKS5/SOCKS5H + HTTP/HTTPS 目标：`socks-proxy-agent`；用户名和密码可选。
- 两者均可直接作为 Node `http(s).request({ agent })` 的 Agent。

版本约束（2026-09-13 通过 `npm view` 核对）：

- 最新 `https-proxy-agent@9.1.0`、`socks-proxy-agent@10.1.0` 要求 Node >=20。
- `https-proxy-agent@7.0.6` 与 `socks-proxy-agent@8.0.5` 支持 Node >=14，可保持项目 Node >=18 契约。
- 高层 `proxy-agent` 默认根据进程环境变量选代理，不适合每账号显式 URL；使用两个协议专用 Agent 更直接，也避免意外读取全局代理环境。

设计结论：新增并锁定 `https-proxy-agent@7.0.6`、`socks-proxy-agent@8.0.5`。按账号代理 URL 创建并缓存 Agent；缓存键不得进入日志。未配置代理时 `agent` 缺省，保持原生直连。代理错误不回退直连。

参考：

- https://github.com/TooTallNate/proxy-agents
- https://www.npmjs.com/package/https-proxy-agent
- https://www.npmjs.com/package/socks-proxy-agent

## 日志存储选择

比较：

- 扩大 `metadata.json`：每请求重写全文件，放大 I/O 和损坏半径，不采用。
- SQLite：查询方便但为当前单文件服务引入数据库生命周期与迁移，超出需求。
- 分段滚动 JSONL：仅追加、尾行损坏可忽略、可以按段从新到旧分页，符合现有文件型架构。

设计结论：

- 在 `DATA_DIR/logs/` 下分别保存 `requests-*.jsonl` 与 `errors-*.jsonl`。
- 活跃分段达到固定大小后滚动；启动时和周期性执行保留策略。
- 查询从新到旧扫描有界分段并应用过滤；返回不透明游标，不使用数组偏移，避免清理时分页漂移。
- 单进程内串行追加，避免并发写入交错；忽略崩溃留下的最后一条不完整 JSON 行。
- `metadata.json` 的旧 `history` 保留兼容读取但停止增长，不自动迁移到新日志，避免复制历史敏感字段。
