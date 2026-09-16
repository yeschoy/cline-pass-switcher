# 空消息 400 来源链路分析（只读）

## 1. 范围与安全边界

- 检查时间：2026-09-16T07:10:28Z–2026-09-16T07:22:43Z。
- 目标事件：当前容器内 2026-09-16T05:10:35.498Z–05:30:00.461Z 的 48 个 `must not be empty` HTTP 400。
- 生产目标：`ubuntu@167.114.158.4:49555`，`/opt/cline-pass-switcher`，容器 `cline-pass-console`。
- 当前发布：`cline-pass-switcher:20260916-050450-b1f2170ef4a8`，commit `b1f2170ef4a8ea14d62e9eef3fc058630c294cc8`。
- 全程仅执行 SSH、文件/manifest 元数据读取、Docker inspect/logs、安全聚合和 PostgreSQL `BEGIN READ ONLY` 查询。未调用写接口，未修改配置、数据、容器、镜像或日志，未重启、部署或清理。
- 未打开 detailed log 的正文 `.txt`，未读取或输出请求正文、响应正文、Key、Authorization、Cookie、代理凭据。所有 user/token/IP/requestId 均仅使用本报告内伪名或不可逆短指纹。

## 2. 结论摘要

### 已确认

1. 48 条均来自同一条链路：一个 NewAPI 认证主体（`user-A` / `token-A`）、一个 NewAPI 日志 IP（`ip-A`）、渠道 71，向 `POST /v1/chat/completions` 发起 `deepseek-v4-flash` 流式请求；NewAPI 将请求转发到 `http://cline-pass-console:3123`，Switcher 在账号选择和任何上游调用之前返回 400。
2. 48 条在 NewAPI 中有 48 个唯一 requestId、48 条 type=5 error 事件、0 条 type=2 consume 事件；`upstream_request_id` 全为空，无法与 Switcher UUID 直接连接。
3. Switcher detailed manifest 也正好有 48 条，精确范围为 05:10:35.498Z–05:30:00.461Z。它与 NewAPI 错误行在全部 32 个发生秒上的计数完全一致，且 NewAPI access log 有 48 条同路径 400。这构成强时间关联，但不是共享 requestId 的直接连接。
4. 生产校验代码确认：该固定错误只会在 `messages` 为数组、且至少一个消息元素的 `content` 缺失/为空/空白/无有效载荷，同时又不满足 assistant tool-call/function-call 例外时触发。整个 `messages` 字段缺失不会触发这个固定检查。
5. 标准合法形态没有被该代码一概误拒：非空文本、带有效载荷的非文本 part、assistant `tool_calls`、assistant `function_call` 均有接受路径；对应聚焦测试通过。

### 不能确认

1. 无法确认失败元素的 role 一定是 `user`，也无法确认具体消息索引。NewAPI 安全日志没有保留错误参数路径，Switcher manifest 的模型和请求头因安全省略不可见，本次又禁止读取响应正文。
2. 无法证明原始客户端发来的正文已经为空；当前证据只能证明 **NewAPI 转发到 Switcher 时** 至少一个消息元素不满足 Switcher 校验。
3. 无法确认具体客户端程序或 User-Agent：NewAPI audit 没有对应行，GIN access log 不记录 UA，Switcher manifest 的请求头整体被安全省略。
4. 无法完全排除 NewAPI 标准协议转换、客户端 SDK 序列化或某种尚未覆盖的合法消息结构造成字段丢失。渠道 71 虽有一条参数覆盖操作，但其配置不引用 `messages`、`content`、`tool_calls` 或 `function_call`，因此没有证据指向该显式覆盖规则。

### 复发情况

- 05:30:00.461Z 后同类错误又出现 **11 条**：06:27:16.485Z–06:55:26.628Z。
- 其中 8 条仍为 `user-A` / `token-A` / `ip-A`、`deepseek-v4-flash`、流式；另 3 条来自 `user-B` / `token-B`，NewAPI 数据库 IP 仍为 `ip-A`，模型为 `deepseek-v4.1-flash`，非流式。
- 截至 07:22:43Z，最后一次同类错误为 06:55:26.628Z；之后未再观察到同类 400。因此不能说错误在 05:30 已停止，只能说 06:55:26 后至新快照未复发。

## 3. 48 条目标事件的来源链路

### 3.1 Switcher detailed manifest

只读取 `manifest.json` 元数据，不读取任何正文文件：

| 字段 | 聚合结果 |
|---|---:|
| 数量 | 48 |
| 时间 | 2026-09-16T05:10:35.498Z–05:30:00.461Z |
| method/path | `POST /v1/chat/completions` ×48 |
| status | 400 ×48 |
| state | `incomplete` ×48 |
| response complete | true ×48 |
| result | null ×48 |
| attemptCount | 0 ×48 |
| 上游账号/尝试 | 0 |

`attemptCount=0` 与代码执行顺序一致：错误发生在 `recordChat`、账号租约和上游调用之前，所以普通 requests/errors JSONL 不会记录这 48 条。

48 个 manifest 的 `model` 和请求头键均为 `[OMITTED: incomplete credential discovery]`。这不是存储损坏，而是详细捕获安全边界主动省略；因此不能从 manifest 提取 UA、转发 IP、token 或客户端 requestId。

### 3.2 NewAPI PostgreSQL 安全字段

渠道 71 的 48 条匹配记录：

| 维度 | 聚合结果 |
|---|---:|
| user | `user-A` ×48 |
| token | `token-A` ×48 |
| DB IP | `ip-A` ×48 |
| path | `/v1/chat/completions` ×48 |
| model | `deepseek-v4-flash` ×48 |
| stream | true ×48 |
| channel | 71 ×48 |
| status | 400 ×48 |
| error type/code | `openai_error` / `invalid_request_error` ×48 |
| NewAPI requestId | 48 个唯一值 |
| upstream requestId | 非空 0 |

脱敏 requestId 指纹样本：`req#cbd358a1af`、`req#4a52a68798`（首秒），`req#13437ee836`、`req#01f304a39c`（末秒）。

对这 48 个 NewAPI requestId 关联全部日志事件：

- type=5 error：48 条，48 个唯一 requestId；
- type=2 consume：0；
- audit log：0；
- 其他事件类型：0。

因此这些请求在输入/转发错误阶段终止，没有形成 consume 记录。

### 3.3 容器访问元数据

NewAPI GIN access log 在目标窗口有：

- `POST /v1/chat/completions` 400：48 条；
- 这 48 条的访问 IPv4 均为同一指纹 `access-ip#e7a88629f1`；
- 没有 User-Agent 字段可供关联。

Cloudflared 在目标窗口没有输出逐请求访问日志（0 行），不能补充 UA 或客户端身份。

### 3.4 关联强度

Switcher 与 NewAPI 在以下 32 个发生秒上的条数完全一致，总数均为 48：

- 单请求秒：19 个；
- 双请求秒：10 个；
- 三请求秒：3 个。

NewAPI 中每秒分布和 Switcher manifest 逐秒一致，包括 05:10:35 的 2 条、05:13:03 的 3 条、05:19:29 的 3 条、05:22:20 的 3 条及 05:30:00 的 2 条。结合渠道 71 的固定目标、同路径和同状态，可以高强度确认链路；但因 NewAPI `upstream_request_id` 为空，仍不能将每个 NewAPI requestId 与每个 Switcher UUID 逐一配对。

## 4. 是否固定周期或批次

48 条覆盖约 19 分 25 秒：

- 相邻间隔最小 253 ms，中位数 10.387 s，最大 135.798 s；
- 相邻间隔中精确 15 s 和精确 60 s 均为 0；
- 有 10 个秒级双发批次和 3 个秒级三发批次；
- 中间存在 05:11、05:20、05:27–05:28 等空档。

分钟分布：

```text
05:10 5, 05:12 1, 05:13 3, 05:14 4, 05:15 1, 05:16 1,
05:17 2, 05:18 5, 05:19 6, 05:21 2, 05:22 4, 05:23 1,
05:24 4, 05:25 2, 05:26 1, 05:29 4, 05:30 2
```

结论：**有并发小批次特征，但没有固定周期证据。** 这不能排除由事件驱动的重试、队列或人工批处理，只能排除当前时间序列中明显的固定 15 秒/60 秒节拍。

## 5. 固定错误路径与代码证据

生产 `/app/server.js` SHA-256：

`9151e9185c35461a21fe13257469bf05e1fc74d98c098bb7c138662711f5bfcd`

它与发布 commit `b1f2170e...` 的 `server.js` 哈希一致。生产代码的执行顺序为：

```text
解析 JSON
→ 校验 body/model
→ emptyMessageContentPath(body)
→ 如失败立即返回 400
→ recordChat / 账号选择 / 上游请求
```

校验语义：

1. `messages` 不是数组时，此检查返回 null，因此“整个 messages 字段缺失”不是本次固定错误的触发方式。
2. 对数组内每个消息检查 `message.content`：
   - 非空字符串通过；
   - content part 数组中有非空文本通过；
   - 非文本 part 在 `type/text` 之外存在实质载荷时通过；
   - 缺失、null、空字符串、纯空白、空数组或没有实质载荷的 part 不通过。
3. `role=assistant` 且有非空 `tool_calls` 对象，或有命名的 `function_call` 时，允许 content 为空。
4. 第一个不通过的元素生成固定安全字段路径 `messages.<index>.content must not be empty`。

本地针对同一发布代码运行聚焦测试：

```text
node --test --test-name-pattern='API compatibility, message boundary and request outcomes are explicit' test/integration.test.js
1 passed, 0 failed
```

测试确认空/缺失 content 被 400 拒绝，而有效 image part、assistant tool call 和 assistant function call 均通过并到达上游。

因此证据等级为：

- **已确认**：Switcher 收到的 `messages` 数组中至少有一个消息元素不满足上述内容判定，且没有被识别为合法 assistant tool/function call。
- **高概率排除**：标准 assistant `tool_calls`、标准 `function_call`、带有效载荷的标准非文本 part 被 Switcher 直接误拒。
- **未知**：失败元素的 role、索引和原始结构；是否是 `user.content` 为空/缺失，还是客户端/NewAPI 转换后形成不受识别的其他结构。

## 6. NewAPI 能证明到哪一层

### 能证明

1. NewAPI 收到了同一路径请求，并用同一 user/token/IP 将目标 48 条鉴权和记账归组。
2. NewAPI 为这些请求选择渠道 71；该渠道目标确认为 `http://cline-pass-console:3123`。
3. NewAPI 记录的模型、流式标记、400、固定错误类别与 Switcher manifest 的时间和数量一致。
4. 渠道 71 的显式参数覆盖只有 1 条 operation，配置文本不引用 `messages`、`content`、`tool_calls` 或 `function_call`；没有证据表明显式 channel override 在改写消息字段。

### 不能证明

1. `logs` 表不存请求正文或 UA；`other` 只有 `admin_info/channel_id/channel_name/channel_type/error_code/error_type/request_path/status_code`，没有消息结构。
2. `audit_logs` 虽有 UA/route 字段，但目标 48 个 requestId 没有对应 audit 行。
3. GIN access log只有路径、状态和访问 IP，没有 UA 或消息结构。
4. `upstream_request_id` 为空，无法端到端逐 ID 关联。
5. 本次禁止读取正文，因此不能比较“NewAPI ingress 结构”和“发往 Switcher 的结构”。

结论：**当前证据只能确认 NewAPI 转发到 Switcher 时消息结构触发了空内容校验，不能确认原始客户端输入本身就是空，也不能在客户端序列化与 NewAPI 标准转换之间定责。**

## 7. 05:30 后复发与普通错误分离

### 7.1 同类前置校验 400

新快照截至 07:22:43Z：

| 时间 | user/token/IP | 模型/流式 | 数量 |
|---|---|---|---:|
| 06:27:16.485Z–06:30:52Z | `user-A` / `token-A` / `ip-A` | `deepseek-v4-flash` / true | 8 |
| 06:55:25Z–06:55:26.628Z | `user-B` / `token-B` / `ip-A` | `deepseek-v4.1-flash` / false | 3 |

这 11 条在 NewAPI 仍然只有 type=5 error、没有 consume；Switcher manifest 与 NewAPI 数量和时间一致。原目标主体确实复发了 8 次，之后同一 DB IP 上又出现第二组主体的 3 次。

### 7.2 普通 requests/errors JSONL（不同口径）

05:30:00.461Z 后至 07:22:43Z，Switcher 另有 443 个已经进入普通记录流程的请求：

- 成功 363；
- 最终失败 19；
- 客户端取消 61。

19 个最终失败对应 19 条错误尝试：

- network/transport-aborted 502：2；时间为 05:34:13.796Z 和 05:36:40.318Z，分别为 DeepSeek v4 与 v4.1；本次直接重读 requests JSONL 的 `stream` 字段均为 false；
- empty upstream response 500：12；
- 其他上游 500：4；
- stream envelope error 500：1。

最后一条普通错误发生于 07:07:07.153Z。

这些普通 network/upstream 错误与空消息 400 不能混为一类：

- 空消息 400 在账号选择和 `recordChat` 前结束，不进入普通 JSONL；
- 普通 19 个失败均已进入账号/上游尝试阶段；
- 两类记录没有共享 Switcher requestId，也没有证据表明 05:34/05:36 的 network 中止由前面的空消息 400 导致。

## 8. 根因与最小建议

### 已确认

1. Switcher 的前置消息内容校验是 48+11 条 400 的直接生成点。
2. 原 48 条集中于一个 NewAPI user/token/IP、一个路径、一个模型和流式形态，具有同一调用工作负载来源特征。
3. 缺少端到端 requestId 和安全结构摘要，是无法继续定位原始生成方的直接证据缺口。

### 高概率

1. `user-A/token-A` 对应的单一客户端工作负载或其 SDK/NewAPI 转换链路持续产生了不符合 Switcher校验的消息结构；依据是 48 条完全同维度聚集且随后同主体复发 8 条。
2. 渠道 71 的显式参数覆盖不涉及消息字段，因此该条覆盖规则不是当前首要嫌疑；但 NewAPI 的通用 relay/适配逻辑仍未被排除。

### 未知

1. 原始客户端是否发送了空 `user.content`。
2. NewAPI 是否在协议适配过程中删除、折叠或重写了合法 tool/non-text 内容。
3. 具体客户端应用、SDK 版本和 User-Agent。
4. 失败消息的 role、索引及 content 形态。

### 最小修复位置建议（本次未执行）

1. **客户端/调用工作负载：优先核查**
   - 对 `user-A/token-A` 所属调用方，在发送前只记录安全结构摘要：消息索引、role、`content` 的类型/是否存在/是否含有效 part、是否有 tool calls；不得记录文本值。
   - 发送前阻止空 user/system/tool 消息；assistant tool-call 保留现有合法空 content 例外。
   - 验证：同一 token/IP 的 `input_empty_message` 在 1 小时窗口降为 0，正常 2xx 不下降。

2. **NewAPI 转换边界：获得最终定责所需证据**
   - 在 ingress 解析后和 channel 71 relay 前各生成一次仅含结构布尔值的摘要，并用同一 NewAPI requestId 关联；比较两处摘要，不保存正文。
   - 让 NewAPI 记录 Switcher 返回的 `X-Cline-Request-Id` 或透传安全 correlation ID。
   - 验证：下一次 400 能证明字段在 ingress 已空，还是在 relay 前才变空。

3. **Switcher 观测性：补齐前置 400 缺口**
   - 将前置校验拒绝写入安全的普通请求摘要，至少包含 requestId、时间、路径、requestedModel、stream、固定字段路径、role 类别和 content 形态枚举；绝不记录正文或请求头值。
   - 保留现有 tool-call/non-text 接受路径；在取得真实结构证据前，不建议放宽校验。
   - 验证：同一拒绝可在 Switcher 普通视图、detailed manifest 和 NewAPI 中按 correlation ID 一一对应。

## 9. 前后不变性

检查前（07:10:28Z）与检查后（07:22:43Z）完全一致：

| 项目 | 值 |
|---|---|
| container ID | `68cb9017589db3e546e5c2d4c50943770f6b451d22bdd10302ef81eade945f20` |
| image ID | `sha256:39e8e1461b94811bcc72ee45dace953e5e2ab5f98655cb72b2e8ad8b568442a4` |
| StartedAt | `2026-09-16T05:07:50.933967089Z` |
| status/health | running / healthy |
| RestartCount / OOMKilled | 0 / false |
| `config.json` SHA-256 | `f6ba3d7ec6702a87dc4d46849611c9a0a425fc52d2b39216ee213e6d0750368b` |
| `compose.yml` SHA-256 | `18c6931b96932217e9f895d787be9bc0e111e3a9fcea6de3e6c3067eaf93cacb` |
| `deployment.json` SHA-256 | `6a38d06563e6210dcc965e4566e47650f19c5df6a5d0c1fef16333bd7834ee24` |

远程日志在服务正常运行中自然追加，但容器身份、启动状态和配置/部署文件哈希未因本次检查改变。
