# 空消息 400 来源链路独立复核

## 结论

复核时间：2026-09-16T07:29:10Z–2026-09-16T07:35:22Z。

`empty-message-source-analysis.md` 的关键数量、代码语义、证据边界和只读声明均通过独立复核。未发现需要修正的事实性错误，也未改动原分析文件。尤其是，现有证据只能确认 **NewAPI 转发到 Switcher 的请求在 Switcher 边界触发了空内容校验**；不能据此断言原始客户端提交的内容已经为空，也不能断言失败消息的 role 是 `user`。

## 已确认结论

### 1. 原 48 条的主体、形态和跨系统关联

在 NewAPI PostgreSQL 的 `BEGIN TRANSACTION READ ONLY` 查询中，以固定错误短语和目标秒级窗口筛选，得到：

- 匹配记录共 48 条，48 个唯一 NewAPI requestId；跨全部渠道统计也只有这 48 条，渠道唯一且为 71。
- `user_id`、`token_id`、日志 IP 各只有 1 个不同值，可安全归为同一 `user-A` / `token-A` / `ip-A`。
- 48 条均为 `/v1/chat/completions`、`deepseek-v4-flash`、流式、HTTP 400、`openai_error` / `invalid_request_error`。
- `upstream_request_id` 非空数为 0。
- 对这 48 个 requestId 关联 NewAPI 全部日志事件，只有 type=5 error 48 条；type=2 consume 为 0；audit 行为 0。
- 渠道 71 启用，目标为 `http://cline-pass-console:3123`。其 `param_override` 只有 1 条 operation，配置文本不引用 `messages`、`content`、`tool_calls` 或 `function_call`。

Switcher detailed manifest 独立重算得到：

- 48 条，时间为 2026-09-16T05:10:35.498Z–05:30:00.461Z。
- 全部为 `POST /v1/chat/completions`、HTTP 400、`state=incomplete`、`result=null`、`attemptCount=0`、上游 attempt 数组长度 0、响应捕获 `complete=true`。
- NewAPI 与 Switcher 均覆盖 32 个发生秒，32 个秒级桶的计数逐桶完全相等，总数均为 48。
- NewAPI GIN access log 在相同窗口有 48 条同路径 HTTP 400。

因此同一链路具有很强的时间、路径、状态和渠道证据；但因没有共享 requestId，不能把每个 NewAPI requestId 与每个 Switcher UUID 逐条配对。原分析已经明确此限制，措辞合格。

### 2. 能确认与不能确认的边界

生产 `server.js` SHA-256 为 `9151e9185c35461a21fe13257469bf05e1fc74d98c098bb7c138662711f5bfcd`，与发布 commit `b1f2170ef4a8ea14d62e9eef3fc058630c294cc8` 及本地工作树的 `server.js` 一致。

代码执行顺序确认该固定错误发生在 `recordChat`、账号租约和上游调用之前。`emptyMessageContentPath()` 只在 `messages` 为数组且至少一个元素没有可接受 content、同时不满足 assistant tool/function 例外时返回固定字段路径；`messages` 缺失或不是数组不会由该检查产生此错误。

据此只能确认：NewAPI 转发到 Switcher 时，至少一个消息元素不满足 Switcher 的内容判定。现有安全元数据不能证明：

- 原始客户端 ingress 正文已经为空；
- 失败消息的 role 是 `user`；
- 失败消息的索引或原始 content 形态；
- 字段是在客户端序列化还是 NewAPI 通用转换阶段形成。

原分析没有越过上述边界。

### 3. 05:30 后的 11 条复发

按原报告固定快照截止 2026-09-16T07:22:43Z 重算，05:30:00.461Z 后又有 11 条同类 Switcher manifest，范围为 06:27:16.485Z–06:55:26.628Z。NewAPI 主体归组为：

- 8 条：与原 48 条的 user、token、日志 IP 均相同；`deepseek-v4-flash`、流式；06:27:16–06:30:52Z。
- 3 条：user 和 token 均不同，但日志 IP 与原主体相同；`deepseek-v4.1-flash`、非流式；06:55:25–06:55:26Z。

最后一条同类错误确为 2026-09-16T06:55:26.628Z。原分析正确地没有宣称 05:30 后不再复发，也没有把共享日志 IP 解释为同一个认证主体。

### 4. assistant tool/function 与非文本 part 接受路径

代码复核确认：

- `assistant` 消息在 `tool_calls` 中至少有一个非空对象时允许空 content。
- `assistant.function_call` 为对象且具有非空 name 时允许空 content。
- content part 数组中的非空文本被接受；非文本 part 在 `type` / `text` 之外具有递归可见的实质载荷时被接受。
- 空字符串、纯空白、null、空数组、空对象及没有实质载荷的 part 被拒绝。

聚焦集成测试通过：

```text
node --test --test-name-pattern='API compatibility, message boundary and request outcomes are explicit' test/integration.test.js
1 passed, 0 failed
```

测试覆盖有效 image part、标准 assistant `tool_calls`、标准 assistant `function_call` 到达上游，以及空/缺失内容在上游前被 400 拒绝。原分析关于标准合法形态不会被一概误拒的结论成立。

### 5. 普通 443 条与空消息 400 的口径分离

固定窗口 `(2026-09-16T05:30:00.461Z, 2026-09-16T07:22:43Z]` 的普通 requests JSONL 独立重算为：

- 443 = 成功 363 + 最终失败 19 + 客户端取消 61；
- 状态为 200×363、500×17、502×2、499×61；
- 19 个最终失败 requestId 与 19 条 errors JSONL 的 requestId 集合完全相等，无无效 JSON 行。

19 条错误分类为：

- network/transport-aborted 502：2；时间 05:34:13.796Z、05:36:40.318Z，关联 requests 记录均为非流式；
- `empty response content` 500：12；
- 其他上游 500：4；
- `stream error after response started` 500：1。

最后一条普通错误为 07:07:07.153Z。上述 19 条都已经进入账号/上游尝试阶段；48+11 条空消息 400 在 `recordChat` 前结束，不进入普通 requests/errors JSONL。原分析正确地区分了这两个统计口径。

### 6. 安全、只读与不变性

- 本地身份文件只验证存在、权限 `0600` 和 gitignore；未读取其内容。
- 远程仅执行 SSH、Docker inspect/logs、manifest/JSONL 内存聚合及 PostgreSQL `BEGIN READ ONLY` 查询。
- 未读取 detailed `.txt` 正文，未输出 request/response 正文、Key、Authorization、Cookie、代理凭据或原始 user/token/IP。
- 未调用写接口，未写远程文件，未重启、部署或清理。

复核前后保持一致：

- 容器 ID：`68cb9017589db3e546e5c2d4c50943770f6b451d22bdd10302ef81eade945f20`
- Image ID：`sha256:39e8e1461b94811bcc72ee45dace953e5e2ab5f98655cb72b2e8ad8b568442a4`
- StartedAt：`2026-09-16T05:07:50.933967089Z`
- 状态：running / healthy；RestartCount=0；OOMKilled=false
- `config.json` SHA-256：`f6ba3d7ec6702a87dc4d46849611c9a0a425fc52d2b39216ee213e6d0750368b`
- `compose.yml` SHA-256：`18c6931b96932217e9f895d787be9bc0e111e3a9fcea6de3e6c3067eaf93cacb`
- `deployment.json` SHA-256：`6a38d06563e6210dcc965e4566e47650f19c5df6a5d0c1fef16333bd7834ee24`

## 修正项

无。未修改 `empty-message-source-analysis.md`，仅新增本评审文件。

## 残余风险

1. NewAPI 与 Switcher 没有共享 requestId；48 条及后续 11 条只能做高强度聚合关联，不能逐请求直接连接。
2. 禁止读取正文是必要安全边界，但也意味着无法区分原始客户端输入、SDK 序列化和 NewAPI 通用 relay/协议转换的责任。
3. assistant/non-text 测试覆盖标准代表形态，不等于穷举所有供应商私有 part schema；在取得真实失败结构的安全摘要前，不宜据此放宽校验。
4. NewAPI 的 IP 是日志字段，不能单独等同于最终客户端设备身份；后 3 条与原主体共享 IP 也不能证明来自同一个 user/token。
5. 生产日志会继续自然追加；数量结论严格限定到原分析快照 2026-09-16T07:22:43Z，不应与之后实时总量直接比较。
