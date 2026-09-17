# 当前批量空 content 错误分析（只读）

## 1. 检查范围与安全边界

- 检查时间：2026-09-17T08:08:04Z–08:19:04Z；最终复核时同类错误仍为 25 条，最后一条停留在 `07:43:02Z`。
- NewAPI 页面时区：`Asia/Shanghai`；截图 `15:43:01–15:43:02` 对应 `07:43:01–07:43:02Z`。
- 生产目标：`ubuntu@167.114.158.4:49555`。
- Switcher：`cline-pass-switcher:20260916-174357-529d642f4b8e-quota-forecast`，容器 ID `884878fd…c7807`，启动于 `2026-09-16T17:50:51.792Z`。
- NewAPI：`calciumion/new-api:latest`，image ID `sha256:60e9c0…b2610`，容器 ID `c8be14f…2e108`，启动于 `2026-09-17T06:54:32.280Z`。
- 两个容器均 `running/healthy`、重启 0、未 OOM；主机资源正常。
- 全程只执行 SSH、Docker inspect/logs、manifest 元数据聚合、普通 JSONL 安全聚合、PostgreSQL `BEGIN READ ONLY` 查询及 GET 型安全设置读取。未修改、重启、部署、清理或发送业务请求。
- 未打开 detailed log 正文 `.txt`，未读取或输出原始请求/响应正文、Header 值、Key、Cookie、Authorization 或代理凭据。

## 2. 结论摘要

### 当前到底有多少条

以当前 Switcher 容器启动时间为边界，共确认 **31 个最终失败请求**：

1. **25 个空消息前置校验 400**：本报告的目标问题；不进入 Switcher 普通 requests/errors JSONL。
2. **6 个普通上游/网络失败**：4 个最终 500、2 个最终 502，发生于 `03:35:30–04:09:03Z`，均早于本次 `07:38–07:43Z` 空消息批次，与目标问题无直接关系。

NewAPI 当前保留库中共有 145 条同类 `content must not be empty`，范围为 `2026-09-14T21:58:04Z–2026-09-17T07:43:02Z`；其中大量是历史记录。属于当前 Switcher 容器的只有 **25 条**，不能把 145 全算成“当前又报错”。

### 本次截图所在批次

- 当前 Switcher 的 25 条分为：
  - `06:42:08–06:45:26Z`：4 条，`deepseek-v4.1-flash`，全部流式，来自同一用户下两个 token 分组；
  - `07:38:34–07:43:02Z`：21 条，`deepseek-v4-flash`，全部流式，来自同一个 NewAPI 用户/token 分组。
- NewAPI 在 `06:54:32Z` 重启，因此当前 NewAPI 实例日志可见后面 21 条；前 4 条仍保留在 PostgreSQL，但旧容器 stdout 已不在当前实例内。
- 截图 `07:43:01–07:43:02Z` 正好 **4 条**：两个秒各 2 条。
- 截图中的准确 NewAPI request ID 为 `202609170743020657752918268d9d6JKbO4xpJ`（无字母 `T`，末段为大写字母 `O`）。

### 直接原因

**已确认：Switcher 收到的完整 JSON 请求中，`messages` 数组至少有一个元素的 `content` 缺失、为 null、空字符串、纯空白、空数组或没有有效载荷，且不符合 assistant tool-call/function-call 的合法空 content 例外。Switcher 在账号选择和上游调用前立即返回 400。**

截图 4 条的 HTTP 请求体并非整体为空：每条均完整接收了 `338,947` 字节、未截断；错误指的是长对话中的某一个 `messages[*].content` 无效。4 条相同字节数、同一认证主体且在两秒内重复，强烈表现为同一工作负载重复提交/重试，但未读取正文，不能证明字节内容完全相同。

当前证据只能确认 **NewAPI 发给 Switcher 时** 已存在无效消息，不能最终证明它在原始客户端输入时就为空，也不能完全排除 NewAPI 通用 relay/协议转换造成结构变化。

## 3. 数量与时间证据

### 3.1 当前 Switcher 的 25 条

| UTC 分钟 | 数量 |
|---|---:|
| 06:42 | 2 |
| 06:43 | 1 |
| 06:45 | 1 |
| 07:38 | 7 |
| 07:39 | 4 |
| 07:40 | 3 |
| 07:41 | 2 |
| 07:42 | 1 |
| 07:43 | 4 |

`07:38–07:43Z` 的 21 条秒级分布为：

```text
07:38:34 3, 07:38:45 1, 07:38:55 3,
07:39:16 2, 07:39:17 2, 07:40:08 3,
07:41:30 1, 07:41:31 1, 07:42:03 1,
07:43:01 2, 07:43:02 2
```

NewAPI PostgreSQL、NewAPI access log 与 Switcher detailed manifest 在上述每一个发生秒的计数完全一致。NewAPI access log 的 21 条还具有同一个安全来源指纹。

### 3.2 NewAPI 日志语义

25 个 request ID：

- type=5 error：25；
- type=2 consume：0；
- audit log：0；
- `upstream_request_id` 非空：0；
- 路径：`/v1/chat/completions`；
- HTTP 状态：400；
- error type/code：`openai_error / invalid_request_error`；
- DB 中字段路径统一已被保存为 `***.***.content`，原始 `messages.<index>.content` 索引未保留。

代表请求与截图完全对应：`2026-09-17T07:43:02Z`、渠道 71、`deepseek-v4-flash`、stream=true、HTTP 400。

### 3.3 Switcher detailed manifest

25 条均为：

- `POST /v1/chat/completions`；
- `status=400`；
- `attemptCount=0`；
- `result=null`；
- response 已完成；
- 无账号、无上游 attempt。

NewAPI 与 Switcher 没有共享 request ID，因此不能把某一个 NewAPI ID直接映射到某个 Switcher UUID；但总数、全部发生秒、路径、状态和渠道目标均完全一致，构成强聚合关联。

## 4. 为什么 Switcher 普通日志里没有

当前容器普通 JSONL 复核结果：

- requests JSONL：当前容器 1,324 条，目标固定短语 0，HTTP 400 为 0；
- errors JSONL：当前容器 6 条，目标固定短语 0，HTTP 400 为 0；
- `07:38–07:44Z` 普通请求只有 5 条已通过前置校验的其他请求，错误尝试为 0。

生产 `/app/server.js` 哈希仍是 `9151e918…f5bfcd`，与上一轮已核对版本相同。执行顺序是：

```text
读取并解析 JSON
→ 校验 model
→ emptyMessageContentPath(body)
→ 命中后直接返回 400
→ 后面才创建 recordChat、提取会话身份、选择账号和调用上游
```

因此这 25 条不是“日志写失败”，而是当前普通日志设计没有覆盖前置校验拒绝。它们只进入 detailed manifest 和 NewAPI 错误日志。

## 5. 为什么 NewAPI 看不到请求头和请求体

这是 **未采集**，不是页面漏显示：

1. 生产 `logs` 表没有 request body、request headers 或 User-Agent 字段；`other` 只有 `admin_info/channel_id/channel_name/channel_type/error_code/error_type/request_path/status_code`。
2. `audit_logs` 虽有 User-Agent 等字段，但目标 25 个 request ID 的关联记录为 0。
3. NewAPI GIN access log只保留时间、状态、耗时、来源和路径，不保留正文/Header。
4. NewAPI 还把错误字段路径保存成 `***.***.content`，所以连失败消息索引也无法从数据库恢复。
5. `upstream_request_id` 为空，无法用 NewAPI request ID跳到 Switcher UUID。

所以当前 NewAPI 已有数据无法还原原始 Header/正文，也无法区分“客户端进入 NewAPI 时已空”与“NewAPI relay 前变空”。

## 6. 为什么 Switcher detailed log 也看不到

详细日志当前已启用，认证保护开启；保留上限 7 天 / 1 GiB，单正文 5 MiB。现存 1,352 个 manifest，时间范围 `2026-09-16T18:10:28.741Z–2026-09-17T08:15:37.603Z`，无损坏记录。

目标 25 条的请求正文发布结果：

| 状态 | 数量 | 含义 |
|---|---:|---|
| `complete` | 4 | 早一批记录已生成脱敏正文；本次按授权未打开正文文件 |
| `resource-limited` | 8 | 原始请求约 910–914 KiB，脱敏器达到结构/扫描安全工作上限，正文发布为 0 字节 |
| `omitted-for-safety` | 13 | 脱敏器无法证明凭据发现完整，整组 fail closed，正文发布为 0 字节 |

后面 21 条（当前 NewAPI 实例内的批次）全部没有可查看正文：13 条 `omitted-for-safety`、8 条 `resource-limited`。它们的普通 Header 投影也全部被整组省略。

截图 4 条的具体状态完全一致：

- request body：完整接收 `338,947` 字节；`complete=true`、`truncated=false`；
- 发布正文：`capturedBytes=0`、`state=omitted-for-safety`；
- Header：省略；
- model 投影：`[OMITTED: incomplete credential discovery]`；
- response body 同样因共享 redactor 的整组安全边界被省略。

用户补充的详细日志截图直接显示了上述字段：请求正文按钮为 `omitted-for-safety · 0/338947 bytes`，最终响应为 `omitted-for-safety · 0/151 bytes`，下方文本框为空。这证明 UI 并非加载失败；`requestBody`/`responseBody` UUID 只指向已发布的脱敏正文文件，而对应 descriptor 的 `capturedBytes=0`，所以文件按设计为空。

这不是磁盘或存储故障：运行时 `failures=0`、`corrupt=0`、`captureDropped=0`、`lastFailure=null`。`detailed-log-capture.js` 的生产哈希与本地当前实现一致；其策略是在 Header、请求正文、响应正文和上游调用之间统一发现凭据，任何一处不能安全完成时就不发布整组内容，避免把凭据片段泄漏到另一处。

manifest 只持久化最终的 `omitted-for-safety`/`resource-limited`，没有保存更细的内部触发分支。因此在不读取原始正文的前提下，无法确认究竟是哪段提示词触发了“凭据发现不完整”。能确认的是：请求传输完整、JSON 可解析、正文未超过 5 MiB；不可见来自脱敏器安全失败关闭，而不是网络截断、保留期或存储损坏。

## 7. 来源边界与排除项

### 已确认

1. Switcher 前置消息校验是 25 条 400 的直接生成点。
2. 07:38–07:43 的 21 条来自同一个 NewAPI 用户/token 分组、同一模型、同一流式形态，具有单一工作负载连续重试/批处理特征。
3. 渠道 71 目标仍为 `http://cline-pass-console:3123`。
4. 渠道 71 的显式参数覆盖文本不引用 `messages`、`content`、`tool_calls` 或 `function_call`；Header override 为空。因此没有证据指向该渠道的显式 override。
5. 错误发生在账号选择前，与 Cline Pass 账号、额度、cache pool、代理和上游模型服务无关。

### 高概率

同一客户端工作负载或其 SDK/NewAPI relay 链路在约 4 分 28 秒内持续提交含无效消息元素的长对话；相同秒内多发和截图 4 条相同正文长度支持自动重试或并发重复提交，但正文内容未读取，不能宣称字节完全一致。

### 尚无法确认

1. 无效消息的原始索引和 role；NewAPI 已将字段路径掩码，Switcher 详细正文又被安全省略。
2. 原始客户端发给 NewAPI 时是否已经为空。
3. NewAPI 通用协议转换是否删除、折叠或重写了某种内容结构。
4. `omitted-for-safety` 的具体内部触发分支；当前 manifest 没有持久化原因枚举。

## 8. 最小后续建议（本次未执行）

1. **先处理调用主体的重复请求**：定位 NewAPI 中产生后 21 条的用户/token 所属客户端，在发送前检查每个 message 的 role、content 类型、是否存在有效 part；不要记录文本值。修复后观察该主体 1 小时，同类 400 应为 0。
2. **Switcher 记录安全结构摘要**：前置 400 至少写入 requestId、requestedModel、stream、失败 message index、role、content 类型/是否存在、tool-call 例外状态和 `attemptCount=0`；不记录正文。这样无需原始正文也能定责。
3. **细化 detailed omission 原因**：manifest 增加无敏感值的原因枚举，例如 `ambiguous-escape`、`redaction-node-limit`、`secret-count-limit`，避免所有情况只显示 `incomplete credential discovery`。
4. **补齐端到端关联**：NewAPI 保存 Switcher 返回的 `X-Cline-Request-Id`，或透传共同 correlation ID；当前 `upstream_request_id` 全为空。
5. **若需区分客户端与 NewAPI**：在 NewAPI ingress 解析后、relay 前各记录一次结构布尔摘要，用同一个 NewAPI request ID关联；不要启用原始 Header/正文持久化。

## 9. 前后状态不变

检查前后以下值一致：

- Switcher 容器 ID、镜像、启动时间、重启次数和 OOM 状态未变；
- NewAPI 容器 ID、镜像、启动时间、重启次数和 OOM 状态未变；
- `config.json` SHA-256：`698b889a…1d6354`；
- `compose.yml` SHA-256：`b9bb5076…de0b6`；
- `deployment.json` SHA-256：`d5673978…2b26202e`。

生产日志在服务运行过程中自然追加；本次检查没有改变远程状态。
