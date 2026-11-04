# OVH 生产发布：deepseek 模型自动优先官方渠道（20261105-4c11582-deepseek-official-first）

状态：已部署，`awaiting-admin-acceptance`。目标 `ubuntu@167.114.158.4:49555:/opt/cline-pass-switcher`。

- 源码：`main` = `4c11582`（与 `origin/main` 一致，工作树干净）；白名单 `git archive 4c11582`，tar sha256 `d1e51aab…`，含 `Dockerfile .dockerignore package.json package-lock.json LICENSE README.md config.example.json server.js lib public`。上传后主机侧 `releases/20261105-4c11582-deepseek-official-first/server.js` sha256 `f773db58…` 与本地逐字节一致。镜像 `sha256:2cb390b301cc8ba230116398db50fd7c75a96ce7265466f42cf37eb2ae050485`。
- 上一版本 `20261024-73f3a6b-oneapi-request-id`（镜像 `sha256:7d9d4427…`）保留；`compose.yml` 备份为 `compose.yml.bak-before-20261105-4c11582-deepseek-official-first`，`deployment.json` 备份为 `deployment.json.before-20261105-4c11582-deepseek-official-first`。
- 变更（相对线上只有 `server.js` +21 行，无其他行为改动）：
  - `officialChannelFor()`：模型名去掉 `cline-pass/` 前缀后以 `deepseek` 开头即视为 deepseek 系。**注意首段就是模型名本身**，`deepseek-v4-pro` 不会切出 `deepseek` 斜杠段，因此按已知厂商前缀匹配而非切分斜杠（初版正则写过一次错误实现，被测试暴露）。
  - `withOfficialChannelFirst()`：厂商官方渠道已在候选列表里时提到最前，其余保持相对顺序；候选里没有则完全不动作，**不新增渠道**。
  - 接入 `gatewayInjectList()`，位于 `exclude`/硬隔离/冷却过滤**之前**，因此被排除或正在冷却的官方渠道不会被拉回。
- 门禁：完整 `npm test` 668/668（含新增 `test/deepseek-first-routing.test.js` 5 项：discovered 与 configured 两种来源均提升、无官方渠道模型原样、非 deepseek 模型列出 deepseek 不重排、exclude 不被绕过）。
- 预演：候选镜像在 `--network none --read-only --user 1000:1000 --cap-drop ALL`、空数据目录下启动，日志正常、`running restarts=0 oom=false`。
- 发布：`docker compose -f compose.yml up -d --no-build cline-pass-console`。切换后 `image=cline-pass-switcher:20261105-4c11582-deepseek-official-first`、`status=running`、`health=healthy`、`restarts=0`、`oom=false`；`3123`、`3124` 与公网 `https://clinepass.yeschoy.io/api/meta` 均 200；切换后 3 分钟日志无 error/exception/ECONN/failed。
- 数据：`data/config.json` sha256 `35a767d5…` 切换前后一致。`data/metadata.json` 摘要变化来自运行时统计写入，结构校验通过（45 个模型、61 个账号、21 条 perModel、`routingSecret` 64 位）。未做配置迁移。
- 回滚：`compose.yml` 换回 `compose.yml.bak-before-20261105-4c11582-deepseek-official-first`，`deployment.json` 换回对应备份，再 `docker compose up -d --no-build --no-deps cline-pass-console`。

## 本次上线的实际触发面

生产配置里含 `deepseek` 渠道的只有两个模型，且都已把它放在首位，因此这次改动在**当前配置下是 no-op**（不改变既有路由结果）：

| 模型 | 配置的 upstreams | 是否含 deepseek |
|---|---|---|
| `cline-pass/deepseek-v4-pro` | `deepseek, novita, alibaba, baseten, deepinfra, azure` | ✅ 已在首位 |
| `cline-pass/deepseek-v4.1-flash-1017` | `deepseek, novita, gmicloud, fireworks, alibaba` | ✅ 已在首位 |

它的价值是**保底**：以后新增流式渠道、或某账号配置顺序被改动时，只要候选里有 `deepseek`，注入的 `gateway.only`/`order` 就会自动把它提到最前，不需要再逐模型配。

## 发现但未处理的既有配置（需人工确认）

两个 deepseek 模型的 `perModel` 指向一个不存在的渠道名，**目前该渠道只有单一候选、没有任何回退**：

- `cline-pass/deepseek-v4-flash`：`upstreams: ["openai-compatible-private"]`，`pinMode: strict`，`maxRetries: 1`
- `cline-pass/deepseek-v4.1-flash`：同上

`openai-compatible-private` 与 `metadata.json` 里探测到的 discovered 列表相同（也是这一个），说明探测结果本身就只有这一项。本次**未改动**（属于用户既有路由策略，不在本次授权范围）。若这两个模型需要真正可用，应改成真实网关 slug 列表或删除该 `perModel` 条目以回落到 discovered。

同日也确认：`deepseek-v4.1-flash-1017` 有 24 家 provider 且含官方端点，而 `deepseek-v4.1-flash-1017-fast` 只有 `baseten` 一家、无官方端点（详见 `docs/deepseek-official-channel-availability.md`）。
