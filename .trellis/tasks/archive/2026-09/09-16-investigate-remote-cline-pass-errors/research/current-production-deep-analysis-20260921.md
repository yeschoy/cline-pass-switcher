# 当前生产 cline-pass 渠道深度分析（2026-09-21）

## 范围与安全边界

- 只读检查时间：2026-09-21T12:09:39Z–12:19:22Z。
- Switcher 当前容器窗口：2026-09-21T06:32:27.450Z 起。
- 目标：生产 `cline-pass-console` 及 NewAPI 对应渠道 71。
- 仅读取 Docker 状态、普通 JSONL、安全配置/状态投影、详细日志中与真实失败 attempt 对齐的已脱敏响应诊断，以及 PostgreSQL `BEGIN READ ONLY` 聚合。
- 未发送模型请求，未调用写接口，未修改配置、容器、日志、镜像或 NewAPI 数据；未输出账号名称、Key、代理、Header 值、请求正文或响应正文。

## 结论摘要

当前不是基础设施持续故障。Switcher 与 NewAPI 均 `running/healthy`、restart 0、OOM false；主机约 54.4 GiB 可用内存、根分区使用 11%，Switcher 容器日志仅 2 行启动信息且未命中 fatal/uncaught/OOM/磁盘/权限/持久化失败标记。

当前 Switcher 容器启动后至主快照 12:10:39Z：

- 3,353 个最终请求：3,320 success、27 failed、6 client_cancelled；最终失败占全部请求约 0.81%。
- 29 条失败 attempt，覆盖 28 个 requestId；其中 2 个 requestId 经 Provider fallback 最终成功，26 个最终失败；另有 1 个本地 routing 503 没有真实 attempt，所以最终失败合计 27。
- 最后一个最终失败发生于 11:03:48.289Z。其后至 11:48:48.327Z 的 751 个请求为 750 success + 1 client_cancelled + 0 failed。
- 最近一小时窗口为 539 success + 1 client_cancelled + 0 failed。

27 个最终失败不是同一个根因：

1. `deepseek-v4-pro` 的旧单 Provider 路由不兼容：18 个最终失败；
2. `deepseek-v4.1-flash` 的 DeepSeek 网关流中止：7 个最终失败；
3. 一次 HTML 429，经两个账号各尝试一次后仍失败：1 个最终失败；
4. `glm-5.3` 的 TogetherAI 流中错误：1 个最终失败。

## 生产基线

### 主机与容器

- Switcher image：`sha256:9e852b57984076f583715414138993dadf5be747c46ae4a4b27292d31509bcc3`
- Switcher container：`1eacac2…8358d`，started `2026-09-21T06:32:27.450Z`
- NewAPI container：`ac2a3911…bdd9b`，started `2026-09-20T20:24:02.733Z`
- 两者均 running/healthy、restart 0、OOM false。
- Switcher config 最近写入时间：2026-09-21T11:43:43.665Z。

### 普通日志保留区间

- requests：5,059 条，2026-09-20T16:48:03.544Z–2026-09-21T11:48:48.327Z；无效行 0。
- errors：67 条，2026-09-20T17:50:03.629Z–2026-09-21T11:03:48.289Z；无效行 0。

### 当前容器错误 attempt 分类

29 条失败 attempt：

- `structured_unsupported`：17；
- `http_server`：9；
- `ambiguous_rate_limit`：2；
- `transport_timeout`：1。

原始上游状态：HTTP 200×24、HTTP 500×2、HTTP 429×2、无响应/0×1。24 个 HTTP 200 错误说明多数不是 TCP/主机错误，而是 SSE/HTTP-200 envelope 内的语义错误。

## 根因一：DeepSeek v4 Pro 的旧路由只钉 `openai-compatible-private`

### 事实

当前容器窗口内该模型共有 19 个最终请求：

- 1 success；
- 18 failed；
- 失败率 94.7%。

18 个失败全部使用同一个账号伪名、无代理，运行时 `targetProviders` 都只有：

```text
openai-compatible-private
```

失败组成：16×502、1×500、1×本地 routing 503。17 个真实失败 attempt 的详细响应均指向同一性质：

- HTTP-200 SSE 错误的安全枚举为 `stream_initialization_failed / stream_error`；
- 脱敏错误结构明确包含 “no available provider” 和 available-provider/model 信息；
- HTTP 500 实例也属于 Provider/model unavailable/unsupported；
- Switcher 分类为 `structured_unsupported`，不是认证、额度或代理错误。

`maxRetries=1` 没有产生 Provider fallback，因为运行时计划里只有一个 Provider。HTTP 500 命中 `provider-status-500` 后对唯一 Provider 冷却 20 秒；同一 NewAPI 请求的立即重试随后得到本地 503 `no provider eligible`，这是“单候选 + 冷却”的预期组合，不是容器故障。

### NewAPI 放大效应

NewAPI 对该模型有 9 个唯一 requestId；每个 requestId 都产生 2 条渠道错误，共 18 条：

- 8 组为 `502 → 502`；
- 1 组为 `500 → 503`。

这证明 NewAPI 的一次重试把 9 个外部失败放大成 18 个 Switcher 最终请求。NewAPI 仍未保存 Switcher `upstream_request_id`，但时间、模型、状态序列与 Switcher 成对失败精确一致。

### 当前状态

当前全局路由已经变为：

```text
baseten → azure → deepseek → alibaba → deepinfra → novita
maxRetries = 1
```

且受影响账号当前继承全局配置，没有账号专属覆盖。配置文件于 11:43:43Z 更新，晚于最后一个 v4-pro 失败（10:55:04Z）。但是配置更新后尚无新的 v4-pro 业务请求，因此只能说旧错误的配置根因已移除，不能声称新路由已经由真实请求验证成功。

## 根因二：DeepSeek v4.1 Flash 的网关流中止

该模型当前窗口：

- 3,208 请求；3,195 success、8 failed、5 cancelled；
- 最终失败率 0.249%；
- 运行计划绝大多数为 `deepseek → fireworks`。

8 个失败中：

- 7 个流式 502：上游 HTTP 已是 200，DeepSeek 已开始流式输出，随后收到错误事件；
- 1 个非流式 429。

7 个流式 502 分布于 3 个不同账号，但目标 Provider 都是 `deepseek`。普通错误原因指纹完全相同；唯一成功保留正文诊断的样本给出：

```text
code = gateway_stream_terminated
origin = gateway
```

其余 6 个对应 detail body 因 full-capture 资源边界标记为 `resource-limited`，但 ordinary 原因指纹、状态、Provider 和分类一致，因此高概率属于同一网关流中止簇。

这些请求不能回退 Fireworks：首次 DeepSeek attempt 已经向下游提交 HTTP 200/部分 SSE，重放会造成重复输出与计费风险。当前实现只更新未来健康状态，不 replay，行为符合安全契约。

同一窗口另有一个 DeepSeek HTTP 500 `empty response content`，Switcher 正确冷却 DeepSeek 并回退 Fireworks，最终请求成功。它证明首包前失败时 Provider fallback 正常工作。

## 根因三：一次跨账号重复的 HTML 429

10:49:11Z 的一个非流式请求：

- 两次真实 attempt，均为 DeepSeek；
- 两个不同账号；
- 两次均 HTTP 429、`text/html`、142 bytes；
- 安全分类仅确认 `Too Many Requests`；没有结构化账号额度或 Provider 归因证据。

`tpm-429` 的正文规则未命中，随后宽泛的 `general-429 account cooldown` 命中，因此两个账号都被短暂冷却。当前两个账号额度均为 fresh/hot、无额度错误，故证据更倾向共享网关/Provider/IP 限流，而不是两个账号同时额度耗尽；但由于 HTML 429 缺少结构化证据，最终归因仍是 `ambiguous_rate_limit`。

## 根因四：GLM/TogetherAI 的瞬时错误

`glm-5.3` 当前窗口：96 请求，94 success、1 failed、1 cancelled。

- 一个 TogetherAI transport timeout（120 秒）在首包前发生，Switcher 随后回退 Friendli，1.849 秒成功；最终请求为 success。
- 一个 TogetherAI SSE 已开始后的错误最终为 502；与 DeepSeek 流中止相同，已输出后不能安全 replay。
- 当前 Provider 状态将 TogetherAI 标记为 degraded，consecutiveFailures=3；不是账号故障。

## NewAPI 与 Switcher 口径为什么不同

当前容器窗口 NewAPI 渠道 71 恰有 3,353 条日志，与 Switcher 3,353 个最终请求数量一致：

- type=2 consume：3,334；
- type=5 error：19。

19 条 NewAPI error 正好是 18 条 v4-pro 首包前失败 + 1 条 429。8 条“HTTP 200 后 SSE 最终失败”（DeepSeek×7、GLM×1）已进入 stream consume 路径，不会形成普通 HTTP error 行。因此只看 NewAPI 错误页会漏掉流开始后的语义失败；只看 Switcher error attempt 页又会把重试 attempt 与最终请求混在一起。

NewAPI 当前窗口 3,353 行中 `upstream_request_id` 非空数仍为 0，无法按 ID 逐条关联，只能依靠时间、模型、状态和成对重试序列做强聚合关联。

## 详细日志状态

- `detailedLogging=true`，`errorDetailLogging=false`；
- store failures=0、corrupt=0、lastFailure=null；
- dropped=2730、captureDropped=604；
- 4,925 个 manifest。

这些 dropped 是 full detailed capture 的资源/容量/并发边界计数，不是 2,730 个模型请求失败。模型流量 fail-open，ordinary 日志完整。它们解释了为什么 6 个大流式错误只有普通原因而没有可读的详细 body。生产长期诊断更适合关闭 full、开启新的 error-only profile，但这是配置变更，本次未执行。

## 根因等级

### 已确认

1. 主机、Switcher、NewAPI 和普通日志存储健康，基础设施不是当前主要根因。
2. v4-pro 的 18 个失败来自旧的单 Provider `openai-compatible-private` 路由；上游明确返回 no-available-provider / stream initialization failed。
3. NewAPI retry=1 将 9 个 v4-pro 外部 requestId 放大成 18 个 Switcher 请求。
4. v4.1-flash 的 7 个流式 502 是 DeepSeek gateway 在 HTTP 200 后终止流；不是 Switcher TCP/代理故障。
5. 一次 DeepSeek 500 和一次 GLM timeout 均被 Provider fallback 成功恢复，重试机制本身有效。
6. 429 在两个账号上返回相同 HTML，当前没有账号额度耗尽证据。

### 高概率

1. v4-pro 当前路由更新已经移除了旧的不兼容 Provider，但缺少更新后的真实请求验证。
2. 7 个 DeepSeek 流式 502 属于同一 gateway-stream-terminated 簇；其中 1 个有完整详细枚举，另 6 个以相同 ordinary 原因指纹和结构证据支持。
3. HTML 429 更可能是共享网关/Provider/IP 限流，而不是账号额度问题。

### 尚需验证

1. 当前 v4-pro 新路由的真实可用性；11:43 更新后尚无该模型请求。
2. NewAPI 对 8 个 SSE 后置失败的最终客户端展示；缺少共享 upstream requestId。
3. TogetherAI SSE 错误正文因 detail resource limit 不完整，不能进一步细分供应商内部原因。

## 建议与后续动作

1. 不重启、不清日志。最后失败后已有 750 success + 1 cancel，无持续故障证据。
2. 优先等待下一次自然 v4-pro 请求验证新路由；若需要即时验证，单独授权一次受控付费测试。
3. NewAPI 对 `stream_initialization_failed/no available provider` 这类确定性不兼容错误不应原渠道立即重试，否则只会将错误和请求量翻倍。
4. 对 DeepSeek `gateway stream terminated` 如持续复发，应使用带 Provider/model/正文证据的定向短冷却，而不是通用 502 账号规则；后置错误只能影响未来请求，不能 replay 当前流。
5. 重新评估 `general-429 account cooldown`：无结构 HTML 429 不足以证明账号额度耗尽。优先依赖结构化 TPM/Provider 规则或保持 unknown，而不是一律冷却账号。
6. 生产诊断建议切换为 `detailedLogging=false + errorDetailLogging=true`，减少成功流捕获竞争并提高失败正文保留率；需要单独批准配置变更。
7. 让 NewAPI 保存 Switcher 返回的 `X-Cline-Request-Id` 到 `upstream_request_id`，才能真正逐请求关联。

调查报告完成后，用户明确授权执行第 4 项的定向生产规则配置。2026-09-21T12:49:48Z 通过现有管理 API 新增：

```text
id: deepseek-stream-terminated-502
scope: provider-model
providers: [deepseek]
models: [cline-pass/deepseek-v4.1-flash]
when.statuses: [502]
when.body_contains: [gateway_stream_terminated]
action: cooldown
reset: 20s / 20s
```

配置前先验证 7/7 条目标 ordinary reason 都包含 `gateway_stream_terminated`。保存后结构 diff 仅为 `errorRules.length` 与 `errorRules[4]`；10 个账号及其并发 6、原有 4 条规则和调度状态均保持。容器继续 running/healthy、restart 0、OOM false。回滚备份：

`/opt/cline-pass-switcher/verification/manual-deepseek-stream-cooldown-20260921T124915Z/config.json.before`

变更后 config SHA-256：`437567e88608475205ce7173dc112ac7004a22b59fd041ece18650e94518f059`。

## 只读调查阶段不变性

只读检查前后完全一致：

- Switcher/NewAPI container ID、image、StartedAt、running/healthy、restart 0、OOM false；
- config SHA-256：`1b215732b183649d5cffb42c3dfb15cf017bc5e729939e3ba640d1c4ad07fa10`；
- compose SHA-256：`b91baa09197369595be2501fa738e6e458ef06c911789e0c275acc367530dfb9`；
- deployment SHA-256：`e12ba80df1b9a761e6e9f8b66e900a456953e6c2bb36604c95d44f224241ba66`。

上述只读调查未改变生产状态；其后的定向规则新增是用户另行明确授权的生产配置变更，证据见前节。
