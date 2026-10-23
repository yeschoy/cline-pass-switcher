# 本机生产发布：gateway.has 按模型显式开启（20261024-320e557-gateway-has-per-model）

状态：已部署，`awaiting-admin-acceptance`（登录后的受保护页面待管理员在浏览器确认）；已对 `cline-pass/deepseek-v4.1-flash-1017` 启用 `has`。

- 源码：`main` = `320e557`。上一个提交 `710eeb7` 是「全局默认开启 has」的首版，上线前实测被否决，从未部署。白名单 `git archive 320e557`（25 个成员，sha256 `aa4b67df…`），`server.js` `d25fbcac…`、`public/index.html` `3aa80296…`、`lib/account-workflow.js` `541fa0ba…` 与提交一致。镜像 `sha256:e2bc61fc23a6b964e84fb21d0f2ec23c3e5446c5b35eea59b5dd7641aab37b77`。
- 上一版本 `20261023-fa0c5ca-redaction-cpu`（`sha256:8faf2305…`），镜像保留；回滚用的 compose 备份在服务器 `.deploy/20261024-320e557-gateway-has-per-model/pre-switch-backup-2/`。
- 起因：Cline 网关的钉选新方法——请求体里 `providerOptions.gateway.only` 同时带能力过滤 `has: ["vision","implicit-caching"]`，让在部分 key 上单独无效的 `only` 真正生效。生产 `deepseek-v4.1-flash-1017` 配置钉 `deepseek`（strict），但近 3 小时 2837 个请求里 1813 个落在 `openai-compatible-private`（近 38 小时 27289 个里 14001 个）。
- 上线前实测（直连网关，两把 key：一把该模型的 `only` 被忽略、一把本来生效，约 80 个 `max_tokens: 128` 的请求）：

  | 模型 | `only+order` | 再加 `has` |
  |---|---|---|
  | deepseek-v4.1-flash-1017（`deepseek`） | 一把落私有渠道、一把落 `deepseek` | 两把都落 `deepseek`；假渠道被拒绝 |
  | minimax-m3、qwen3.7-plus | 200 | 200，落点不变 |
  | deepseek-v4.1-flash、glm-5.3（列表含私有渠道） | 私有渠道 | 私有渠道 |
  | qwen3.8-max、kimi-k3（钉私有渠道） | 200 | 500 `No available providers match the 'only' filter` |
  | deepseek-v4-pro、qwen3.7-max | 200 | 500 `No providers … satisfy the required has conditions` |

  `glm-5.2`、`deepseek-v4-flash`、`kimi-k2.6`、`kimi-k2.7-code` 对测试账号返回 404 `model not found`，未能验证。
- 结论：`has` 会同时排除不满足能力的渠道（含私有落点），不支持的模型被网关 500 拒绝。首版全局默认开启会打挂 `qwen3.8-max`（近 38 小时流量约 2.6%）和 `deepseek-v4-pro`（约 1.4%），所以改为 `config.json` 顶层 `gatewayHas`（模型 id → 能力数组），缺省不对任何模型发送。
- 变更：① `injectPrefs` 只对 `gatewayHas` 列出的模型、且只在注入 `gateway.only` 时附带 `has`；auto 请求、直连管道、未列出的模型不变，客户端自带的 `has` 仍被丢弃。② 管理端探测的假渠道负对照与逐渠道校验按模型取同一份 `has`。③ 网关把 `No available providers match the 'only' filter` 的 400 包成 HTTP 500，负对照据此还原为 400 并认该措辞，才能报告 `supported`（此前对这个网关只会得到 `unknown`）。④ `gatewayHas` 支持 SIGHUP 热加载，非法值拒绝启动，热加载失败保留原配置。
- 门禁：完整 `npm test` 663/663；新增测试覆盖按模型注入、未列出模型不带 `has`、客户端 `has` 被丢弃、热加载与非法值、探测体按模型取 `has`、包着 400 的 500 判 `supported`（包着 502 的仍判 `unknown`）。
- 流程：服务器上的 `deployment.json` 停在 f0a4898（10/23 的三次发布没更新它），先对账到真实的 fa0c5ca（旧文件留 `deployment.json.before-reconcile-20261024`），再走 `.deploy/ovh-deploy-{stage,rehearse,backup,switch,postcheck}.py`。隔离演练（UID 1000、只读根、无网络、数据副本）下候选镜像与旧镜像都能启动，`configChangedPaths: []`，`switch --preflight` ready。
- 发布：容器 00:05:22（本地时间）切换，running/healthy、0 次重启、无 OOM；本机网关/直连/控制台/内部别名 `/api/meta` 均 200，从公网独立探测 200；仅客户端密钥访问 4 个管理接口均 401；配置 SHA-256 `1f02caf1…` 切换前后不变。切换后首批 23 个真实请求全部 200，落点与此前一致（该版本默认不改变任何请求）。
- 启用：备份 `data/config.json.bak-gatewayhas-20261024-000726` 后在 `config.json` 顶层加 `"gatewayHas": {"cline-pass/deepseek-v4.1-flash-1017": ["vision", "implicit-caching"]}`（写前与原文件往返序列化逐字一致，只多这一个键），00:07:45 SIGHUP 热加载。经代理的 8 个验证请求全部 200、`target=deepseek actual=deepseek`；未开启的 `minimax-m3` 不变。热加载后约 3.5 分钟内 78 个请求（含上述 9 个验证请求）全部 200，该模型 60 个里 58 个落 `deepseek`，另 2 个在热加载那一刻已派发。配置 SHA-256 现为 `275ab2a1…`。
- 回滚：① 只关 `has`：从 `config.json` 删掉 `gatewayHas`（或改成 `{}`）后 SIGHUP。② 回退代码：启用后配置已变，`ovh-deploy-rollback.py` 要求配置仍是备份或预测哈希，会拒绝执行；改为手工把 `pre-switch-backup-2/compose.yml` 换回 `/opt/cline-pass-switcher/compose.yml`，再 `docker compose up -d --no-build --no-deps cline-pass-console`，旧镜像会原样保留未知的 `gatewayHas` 键。
- 未做：管理员浏览器验收；`deepseek-v4.1-flash` 的列表含 `openai-compatible-private`，`has` 对它没有效果，想钉到真实渠道需先把私有渠道从列表去掉并实测，这是运营决策，未改；观察窗口只有几分钟，错误率与上游用量变化需要继续看。
