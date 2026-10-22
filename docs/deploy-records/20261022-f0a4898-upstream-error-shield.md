# 本机生产发布：上游错误对下游的保护（20261022-f0a4898-upstream-error-shield）

状态：已部署。

- 源码：`main` = `f0a4898`；白名单 `git archive HEAD`，`server.js` sha256 `c70b0793c902b295dc58ad1f776c25ba35b4e6e371a58b545b839f9d37b1ac73` 与 HEAD 一致。镜像 `sha256:c297b8971cf95453d963507b03e778bbac073ab470edc625a2f0bd92e62d4774`。
- 上一版本 `20261022-400c837-reset-soonest`（`sha256:448e1064…`），镜像保留，可直接换回回滚。
- 起因（2026-10-22 17:11～17:42）：一个下游客户端发来 `reasoning_effort: "off"` 的非流式请求，上游返回 HTTP 500（实为 Vercel 400 `Invalid option`），触发 `provider-status-500` provider 冷却，整个模型对所有用户 503（5 分钟内 216 个失败，之后该客户端重试持续触发）；17:21:04 账号 minunjwep5 的一次上游 401 被原样转给 new-api，new-api 把整条渠道（#71）自动禁用，全站该渠道无可用。
- 变更：① 上游账号 401：换一个账号重试一次，最终失败时对下游返回 502（`upstream account authentication failed`），不再透传 401；日志仍记录 `upstreamStatus: 401`。② 上游把 `request failed with status 400|422` + `invalid_request_error` 包成 5xx 时还原为 400，按请求错误处理，不触发 provider 冷却；真正的服务端 500 仍冷却。③ Chat 的 `reasoning_effort`：`off/disabled/false/no` → `none`，已知值转小写，未知值不动。
- 门禁：完整 `npm test` 658/658；新增 6 个测试（纯函数 1、经真实服务 5：规范化、包着 400 的 500 不冷却且下一请求 200、真 500 仍冷却、401 换号、全部 401 → 502）；其中 4 个在未修复代码上确认失败。已有测试两处按新行为更新（401 透传 → 502；一个用 401 当失败触发的健康度测试改用 403）。隔离演练（UID 1000、只读根、无网络、数据副本）通过，配置字节不变。
- 发布：配置 SHA-256 `5cf5ab9226db31258d23…` 切换前后不变；切换后 running/healthy、0 次重启、无 OOM；`CLINE_PASS_PROXY_MAX_SOCKETS=128` 保留；经中转站用线上真实请求验证 `reasoning_effort: "off"` 非流/流式均返回 200；切换后首批 19 个真实请求全部 200（切换前最后 10 分钟为 112 个 200 / 219 个 503 / 43 个 500）。
- 回滚：`compose.yml` 的 `image`/`build.context` 换回上一版本并 `docker compose up -d`（备份见服务器 `private-backups/pre-20261022-f0a4898-upstream-error-shield/`）。
- 备注：new-api 渠道 #71 在本次切换前已被恢复启用；上游对账号的 401 仍可能偶发，现在不会再导致中转站禁用渠道，但 new-api 对其他 4xx/5xx 的自动禁用策略不在本仓库内。
