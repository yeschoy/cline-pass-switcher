# NewAPI 截图 HTML 429 诊断（只读，2026-10-18）

## 范围与安全边界

- 生产：`ubuntu@167.114.158.4:49555`
- 只读：SSH、Docker inspect、PostgreSQL `BEGIN READ ONLY`、Switcher JSONL 聚合与 `config.json` 错误规则投影。
- 未改配置/容器/日志，未读请求正文或凭据。

## 截图对齐

- NewAPI 列表时间按 **UTC** 显示；`2026-10-17 17:40:46–17:43:39` = 北京时间 `2026-10-18 01:40:46–01:43:39`。
- 用户 `MICT`、令牌 `ds`、渠道 `#84`、模型 `deepseek-v4.1-flash-offpeak`、流式。
- NewAPI 详情：`status_code=429, upstream returned an invalid error response`。

## 根因

- Switcher 同窗失败请求：最终 `429` / `failed`，`errorCategory=upstream`，`failureClass=rate_limit`。
- 上游 DeepSeek 路径返回 **HTTP 429 + `text/html` + 约 142 字节**，无结构化 JSON 错误体；NewAPI 因此写成 “invalid error response”。
- 17:40 UTC 分钟内渠道 84/`ds`/`offpeak` 约 **69 错 + 78 成**，属并发突刺限流，非整段宕机。

## 错误规则命中

窗口内 45 个失败请求、90 次 attempt，**全部**：

| 字段 | 值 |
|------|-----|
| `ruleId` | `null` |
| `matchedBy` | `["default"]` |
| `ruleAction` | `ignore` |
| `errorScope` | `gateway` |
| `scopeEvidence` | `gateway_html_throttle` |
| `healthAction` | `none` |
| `retryRuleId` | `null` |

生产 `errorRules` 中最接近的是 `general-429`（`statuses:[429]`，`cooldown`，`provider-model`），但 `classification.scope === 'gateway'` 时在 `matchErrorRule` 之前短路（`server.js` ~5243–5248），按设计绕过配置规则，只做出口级 backoff。

## 已有约定

- `.trellis/spec/backend/quality-guidelines.md`：HTML 429 无结构化错误 → `gateway` / `gateway_html_throttle`，绕过 `errorRules`、Provider circuit、健康采样。
- `.trellis/spec/backend/logging-guidelines.md`：普通日志保留上述投影字段。

## 待研（非本次交付）

- 分类器与文档把 HTML 429 叙述成「Cline edge 按出口 IP 限流」，但**生产尚无结构化证据**证明当前失败批次就是 IP/共享代理限流，而非账号侧或其它边缘策略。
- 用户决定：进程内 backoff 改为**按账号**键；不把「IP 限流」当作必须保留同代理共享窗口的前提。是否 IP 限流需另开观测/对照，不在本任务内证实或否定。
