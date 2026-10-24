# 本机生产发布：网关包着的请求参数错误不再扣 provider 健康、不再打开熔断（20261024-c164694-wrapped-request-error）

状态：已部署，`awaiting-admin-acceptance`（沿用上一版的管理员验收状态，本次未动控制台页面）。

- 源码：`main` = `c164694`；白名单 `git archive c164694`（23 个文件，tar sha256 `f0ab6416…`），`server.js` `406e0247…` 与提交一致；与线上 `320e557` 的 release 目录相比只有 `server.js` 不同，diff 只是 `classifyAttemptFailure` 的 5 行。镜像 `sha256:68613d23ab301c774df08b3854ba09f59bd3beff7defd5a3e4e3251074e205f9`。
- 上一版本 `20261024-320e557-gateway-has-per-model`（`sha256:e2bc61fc…`），镜像保留；`compose.yml` 备份为 `compose.yml.bak-before-20261024-c164694-wrapped-request-error`，`deployment.json` 备份为 `deployment.json.before-20261024-c164694-wrapped-request-error`。
- 起因（生产 21:00–21:50 错误排查，2130 个请求失败 40 个，其中 20 个是 499）：
  - `qwen3.8-max` 非流式请求推理耗尽 `max_tokens`，上游回 500 `empty response content`；虽然命中 `500-empty-resp`（ignore），仍按 500 打开了该模型 6 s 的 provider 熔断，客户端 50 ms 后的重试被本地 3 ms 拒成 503 `no provider is currently eligible`（窗口内 3 次，每次都紧跟一个 500）。
  - 网关把 provider 的参数 400（`Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`、`Invalid schema for function …`）包成 `stream_initialization_failed`（502）。unsupported 正则 `invalid[^\n]*provider` 在单行错误 JSON 上从 "Invalid" 匹配到后面的 `providerMetadata`，判成 provider `unsupported`，默认规则 degrade 并把 `deepseek@deepseek-v4.1-flash-1017` 标成 `bad`。一周内 30 条 `structured_unsupported` 全是这种误判。
- 变更：unsupported 正则的词间跨度改为有界（`invalid[^\n]{0,30}provider` 等）；文本含 `request failed with status 400` 或 `empty response content` 的失败归为 `{ scope: 'request', evidence: 'wrapped_request_error' }`，默认不扣 provider 健康、不开 provider 熔断。客户端仍会收到原错误。
- 门禁：完整 `npm test` 663/663；扩展 `provider cooldown skips repeated failures…` 用例覆盖两种包装形状（旧代码在新断言上失败）。用一周生产错误日志回放新分类：只有 76 条改变（46 条 empty-resp、30 条包着的 400），其他分类不变。
- 发布：候选镜像先在断网、只读根、UID 1000、空数据目录下启动，`/api/meta` 200。容器 22:42:40（本地时间）切换，running/healthy、0 次重启、无 OOM；直连 3124 与网关 3123 的 `/api/meta` 均 200，启动日志无错误；`data/config.json` SHA-256 `5019f88b…` 切换前后不变（与上一条记录的 `275ab2a1…` 不同，修改时间 20:08，早于本次切换，属于控制台日常改动）。切换后约 1 分钟内 60 个真实请求：58 个 200、2 个 499，无上游错误。
- 回滚：`compose.yml` 换回 `compose.yml.bak-before-20261024-c164694-wrapped-request-error`，`deployment.json` 换回对应备份，再 `docker compose up -d --no-build --no-deps cline-pass-console`。
- 未做（客户端侧问题，按用户要求不处理）：裸名 `kimi-k3.1-pro`（上游 400 `invalid model format`，应写 `pc/kimi-k3.1-pro`）；`deepseek-v4.1-flash-1017` 的 `max_tokens` 超过 393216；非流式请求 `max_tokens` 太小导致的 empty-resp；`deepseek-v4.1-flash` 的跑飞输出（见 `docs/deepseek-runaway-output-findings.md`）。本次修复上线后，同类失败应显示 `errorScope=request`、`scopeEvidence=wrapped_request_error`，`qwen3.8-max` 的 500 之后不再紧跟本地 503；切换后的观察窗口很短，还没有遇到同类失败。
