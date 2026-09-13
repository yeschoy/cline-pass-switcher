# NewAPI 接入下的 Cline 账号池与供应商路由增强：技术设计

## 1. 范围与边界

请求链路固定为：

```text
NewAPI -> cline-pass-switcher -> Cline Pass -> 最终供应商
```

- `cline-pass-switcher` 是账号池、账号调度与最终供应商路由的唯一所有者。
- 本期不调用 CPA，不修改 `cpa-strategy` 或 `newapi-saas`。
- 保留现有零第三方依赖、单 Node 进程、`config.json`/`metadata.json` 持久化及静态控制台结构。
- 后端、控制台和验证彼此强耦合于同一份配置契约，不拆分独立子任务，避免多个实现阶段形成不兼容中间态。

## 2. 当前执行流与根因

当前关键路径：

```text
handleChat
  -> config.perModel[model]
  -> runChatChain
  -> buildAttempts
  -> attemptOnce / streaming fetch
  -> injectPrefs
  -> pickAccount（当前每个供应商尝试都会再次执行）
```

根因与约束：

1. `server.js:533` 和 `server.js:570` 在供应商尝试内部调用 `pickAccount()`，导致一个逻辑请求可在普通供应商故障转移中换号。
2. `server.js:438` 的 `unwrap()` 会把大部分 JSON 上游错误折叠成 502，账号规则无法可靠匹配原始 429/500。
3. `server.js:123` 只显式设置 Content-Type 与账号 Authorization；Node `fetch` 还会自动补出并非客户端真实提供的 User-Agent 等 Header。
4. 全局 `perModel` 与账号池彼此独立，缺少账号级模型路由。
5. 流式请求在 SSE 建立后不能安全重放；容量租约必须持有到流结束或断开。

因此必须把“选账号”和“跑该账号的供应商序列”拆成两个明确阶段，并让供应商链接收固定账号，而不是在链内选号。

## 3. 配置与运行状态契约

### 3.1 `config.json`

沿用现有字段并增加。以下展示启用可选规则后的配置；兼容默认值仍为 `accountErrorRules: {}`：

```json
{
  "accountMode": "sticky",
  "activeAccount": 0,
  "concurrencyWaitMs": 2000,
  "accountErrorRules": {
    "429": { "action": "cooldown", "cooldownMs": 1800000 },
    "500": { "action": "ban" }
  },
  "accounts": [
    {
      "id": "稳定 UUID",
      "name": "账号1",
      "key": "sk-...",
      "enabled": true,
      "maxConcurrent": 0,
      "perModel": {
        "cline-pass/glm-5.3": {
          "upstream": "alibaba",
          "upstreams": ["alibaba", "baseten"],
          "exclude": [],
          "pinMode": "strict",
          "sort": null,
          "maxRetries": null
        }
      }
    }
  ],
  "perModel": {}
}
```

契约：

- `accountMode` 允许 `single | roundrobin | sticky`。
- `concurrencyWaitMs` 为 0～30000 的整数，默认 2000。
- `maxConcurrent` 为非负整数，0 表示无限制。
- `accountErrorRules` 以规范化 HTTP 状态码为键；动作只允许 `ignore | cooldown | ban`。`cooldown` 必须带正数 `cooldownMs`。
- 账号使用不可变 `id` 关联运行状态和统计；名称可修改，密钥不得作为标识。
- 账号 `perModel[model]` 若存在，整项替代全局配置；不存在才读取全局 `perModel[model]`。
- 全局与账号级路由共用一个规范化函数，保持 `upstream` 兼容镜像、`upstreams`、`exclude`、`pinMode`、`sort`、`maxRetries` 一致。
- `maxRetries` 缺失/`null` 表示走完现有供应商候选序列；整数表示首个尝试之后最多再发起多少次外层代理重试。它不伪装成网关内部 `order` 的重试计数。

### 3.2 `metadata.json`

动态状态独立于静态账号配置：

```json
{
  "accountStates": {
    "账号 UUID": {
      "banned": false,
      "cooldownUntil": 0,
      "statusCode": 429,
      "reason": "已脱敏且截断的原因",
      "updatedAt": 0
    }
  },
  "routingSecret": "随机生成的内部 HMAC 密钥"
}
```

- `routingSecret` 只在本机元数据中保存，不通过 API 返回；用于会话与消息指纹，保证重启后映射稳定。
- 封禁只有管理操作能清除；冷却到期在候选读取时自动清除并持久化。
- 只保存动作、状态码、时间和脱敏短原因，不保存响应正文、会话原值或消息原文。
- 当前并发数仅保存在内存，进程重启自然归零。

### 3.3 兼容迁移

启动时一次性规范化：

- 旧 `apiKey` 迁移逻辑继续保留。
- 旧账号自动补 `id`、`maxConcurrent: 0`、空 `perModel`。
- 旧 `single`/`roundrobin` 行为继续识别；缺少新字段时使用兼容默认值。
- 旧全局 `perModel` 继续生效，账号默认全部继承。
- 账号重命名不丢失状态；删除账号时清理对应动态状态和内存计数。
- 配置与元数据保存使用同目录临时文件加 rename，避免写入中断造成 JSON 丢失。

## 4. 请求数据流

```text
1. 鉴权并读取有界 JSON body
2. 识别客户端协议与稳定会话身份
3. 过滤可用账号（enabled/key/非封禁/非冷却）
4. 按模式选择账号并原子取得容量租约
5. 解析“账号专属或全局”模型路由
6. 使用固定账号执行供应商尝试序列
7. 每个失败保留原始/规范化状态并应用账号规则
8. 普通错误继续同账号的供应商故障转移
9. cooldown/ban 且响应未开始：最多换号一次，重新解析新账号路由并从头执行
10. 返回非流式响应，或建立 SSE 并持有租约到结束/断开
11. 记录脱敏观测数据并释放租约
```

任何异常路径都必须只释放一次租约。客户端断开时中止当前上游请求；SSE 已开始后不重放。

## 5. 会话识别与 HRW

### 5.1 共同规则

- Header 名称大小写不敏感；会话值去除首尾空白，拒绝控制字符和超长值。
- 只把 HMAC 指纹送入 HRW，不持久化或记录原始会话值。
- `X-Client-Request-Id` 是逐请求 ID，只透传和观测，不单独充当会话键。
- 有可信父标识时，父标识优先成为路由键；这样父任务与子任务命中同一账号。

### 5.2 Codex 优先级

父标识：

1. `X-Codex-Parent-Thread-Id`
2. `X-Codex-Turn-Metadata` JSON 中的 `parent_thread_id`、`parent_session_id`、`parent_conversation_id`

当前会话：

1. 请求体 `prompt_cache_key`
2. `Session-Id` / `Session_id`
3. `Thread-Id` / `Thread_id`
4. `X-Codex-Turn-Metadata` JSON 中的 `thread_id`、`session_id`、`conversation_id`

### 5.3 Claude 优先级

父标识：

1. `X-Claude-Code-Parent-Agent-Id`
2. `metadata.user_id` 内嵌 JSON 中的 `parent_session_id`、`parent_agent_id` 等明确父字段

当前会话：

1. `X-Claude-Code-Session-Id`
2. `X-Claude-Code-Agent-Id`
3. 请求体 `metadata.user_id` 中合法内嵌 JSON/Claude session 形式的会话字段

普通 `user_id` 不视为会话 ID，避免所有对话被错误固定到一个账号。

### 5.4 通用与消息兜底

通用客户端按明确的 body session/conversation/thread 字段和通用会话 Header 取值。仍未命中时，只取：

- 第一个 `system` 或 `developer` 消息；
- 第一个 `user` 消息。

将稳定、带类型边界的序列化结果做 HMAC。后续追加 assistant/user 消息不改变指纹；无法提取时回退 round-robin。

### 5.5 HRW 选择

对每个可用账号计算：

```text
score = HMAC(routingSecret, sessionFingerprint + "\0" + account.id)
```

取分数最高账号。账号退出可用集合时只重映射原本命中它的会话；恢复后自然回到原首选账号。无需持久化会话绑定表。

## 6. 可用性与并发租约

账号候选条件：

```text
有 key && enabled != false && 未封禁 && 冷却已到期/未冷却
```

容量条件：

```text
maxConcurrent == 0 || activeCount < maxConcurrent
```

- 取得租约与 `activeCount + 1` 在同一同步代码段完成，防止并发超卖。
- 非流式在响应结束后释放；流式在上游 end/error、客户端 close 或管道失败时释放。
- `sticky` 先按不考虑瞬时容量的 HRW 得到首选；首选满载时等待最多 `concurrencyWaitMs`，之后只为当前请求选择 HRW 次高且有容量的账号。
- `roundrobin` 跳过满载账号；全部满载才等待并重扫。
- `single` 保留当前“活动账号静态不可用时取第一个可用账号”的兼容行为；账号一旦选定，若只是容量满载，则只等待该账号，超时返回 429，不因并发临时溢出到其他账号。
- 等待后仍无容量返回 429；`Retry-After` 为安全整数秒，最小 1，最大 30。

## 7. 供应商链与账号处置状态机

### 7.1 固定账号供应商链

`runChatChain` 改为显式接收账号和透传 Header，不再调用 `pickAccount()`。同一逻辑请求的所有普通供应商尝试都使用同一账号 Authorization。

路由配置解析：

```text
resolveModelConfig(account, model)
  = account.perModel 有 own-property ? account.perModel[model] : config.perModel[model]
```

空对象也是明确专属配置，不与全局逐字段合并。

### 7.2 错误规范化

每次上游结果保留：

- `upstreamStatus`：真实 HTTP 状态；
- `normalizedStatus`：优先使用有效真实状态；对 HTTP 200 错误包/SSE 错误首包提取受支持的状态字段，否则为 502；
- `safeMessage`：验证所需的短错误消息，经过账号 key、代理 key、Bearer 值脱敏。

向客户端返回有效的真实上游 HTTP 错误状态；只有网络失败、非 JSON、无有效状态的错误包才使用 502。规则匹配发生在折叠/对外转换之前。

### 7.3 规则动作

- 无规则：保持旧行为，继续供应商链。
- `ignore`：记录动作但保持账号可用，继续供应商链。
- `cooldown`：持久化截止时间并终止当前账号供应商链。
- `ban`：持久封禁并终止当前账号供应商链。

若 `cooldown/ban` 发生在响应输出前，且尚未换过账号：释放旧租约，排除旧账号，最多选择一个新账号；新账号重新解析自己的模型路由并从第一个供应商开始。第二账号失败不再换号。

真正 SSE 开始后出现的错误仍可更新未来候选状态，但绝不重放当前流。

## 8. Header 边界与上游传输

### 8.1 允许列表

Codex：

```text
Originator
Session_id / Session-Id
Thread_id / Thread-Id
X-Client-Request-Id
User-Agent
X-Codex-Beta-Features
X-Codex-Turn-State
X-Codex-Turn-Metadata
X-Codex-Window-Id
X-Codex-Parent-Thread-Id
X-OpenAI-Subagent
X-OpenAI-Memgen-Request
X-ResponsesAPI-Include-Timing-Metrics
X-OpenAI-Internal-Codex-Responses-Lite
```

Claude：

```text
X-Claude-Code-Session-Id
X-Claude-Code-Agent-Id
X-Claude-Code-Parent-Agent-Id
X-Stainless-Arch
X-Stainless-Lang
X-Stainless-Os
X-Stainless-Package-Version
X-Stainless-Retry-Count
X-Stainless-Runtime
X-Stainless-Runtime-Version
X-Stainless-Timeout
User-Agent
X-App
Anthropic-Beta
Anthropic-Dangerous-Direct-Browser-Access
Anthropic-Version
```

通用：标准 session/thread/conversation/parent Header，以及 `User-Agent`、`X-Client-Request-Id`、`HTTP-Referer`、`X-Title`。

始终禁止：下游 `Authorization`、`Proxy-Authorization`、Cookie、Host、Content-Length、Connection/Transfer-Encoding/Upgrade 等逐跳 Header，以及 Installation ID、Attestation、设备/浏览器伪造字段。

### 8.2 传输实现

Cline 请求统一通过一个基于 Node `http`/`https` 标准库的请求函数发送：

- 明确设置 Cline 账号 Authorization 与 JSON Content-Type；
- 只加入允许列表中真实存在的值；
- 不让 Node `fetch` 自动生成 `User-Agent: node`、`Accept-Language: *`、`Sec-Fetch-Mode: cors` 等客户端指纹；
- 支持超时/AbortSignal、JSON 响应和 Node 流式响应。

OpenRouter 公共目录和文档抓取可继续使用现有 `fetchJSON/fetch`，因为它们不代表转发客户端身份，也不携带账号聊天请求。

## 9. 管理 API

复用并扩展现有 API：

- `GET /api/accounts`：账号静态配置、动态状态、当前并发、调度模式、等待时间和全局规则。
- `POST /api/accounts`：统一验证并保存账号、模式、并发配置、等待时间和错误规则；保留已有账号 id。
- `POST /api/accounts/recover`：按账号 id 清除封禁/冷却状态。
- `GET /api/models?accountId=<id>`：返回全局或指定账号视角的有效模型配置，并标记 `global | account | inherited`。
- `POST /api/config`：增加 `scope` 与 `accountId`；账号作用域支持复制全局后保存，以及删除专属模型配置恢复继承。
- 现有探测、测试、历史和安全 API 保持兼容；测试接口可带可选账号 id 验证账号专属路由。

所有写接口在服务端执行同一套规范化和范围校验，不能依赖浏览器校验。

## 10. Web 控制台

在 `public/index.html` 现有组件上增量扩展，不引入框架：

1. 账号卡增加 sticky 模式、并发等待时间与全局错误规则编辑。
2. 账号行增加并发上限、当前并发、健康/冷却/封禁状态、短原因与恢复按钮。
3. 模型卡增加路由作用域选择器：全局默认或指定账号。
4. 账号视角明确显示“继承全局/账号专属”；继承状态提供“复制全局”，专属状态提供“删除并恢复继承”。
5. 复用现有上游优先级、排除、模式和排序控件；增加 `maxRetries` 输入，不复制一套不同的路由编辑逻辑。
6. 所有新服务端文本先 HTML 转义；状态反馈使用可读标签和 `aria-live`，按钮保留键盘可操作性。

## 11. 可观测性与安全

历史记录继续包含模型、账号名、目标/实际供应商、耗时与供应商尝试；新增：

- 账号尝试路径；
- 账号动作 `ignore/cooldown/ban`；
- 原始 HTTP 状态与规范化状态；
- 会话来源类型（如 `codex_parent`、`claude_header`、`message_hmac`），不记录会话值或指纹。

安全约束：

- 任何错误、trace、历史或响应诊断 Header 在写出前统一脱敏。
- 账号 key 仅用于上游 Authorization 和受鉴权控制台的既有账号编辑响应。
- 不在诊断 Header 中加入 key、原始 session、Cookie 或内部 HMAC secret。

## 12. 验证设计

### 12.1 自动化

使用 Node 内置 `node:test`，启动临时 mock Cline 上游与真实 switcher 子进程，至少覆盖：

- 旧 `single`、`roundrobin` 配置兼容；
- HRW 输入顺序稳定、同会话稳定及移除账号后的最小重映射；
- Codex、Claude、父会话、通用 Header 与消息 HMAC 兜底；
- 允许 Header 真实透传，Authorization/Cookie/逐跳 Header 被剔除，缺失 User-Agent 时不生成伪值；
- 账号级路由整项覆盖、删除后继承全局；
- 普通供应商重试全过程 Authorization 不变；
- 429 冷却、500 封禁、最多换号一次及重启后状态仍生效；
- 并发租约、2 秒等待/临时溢出、全满 429；
- 流式与非流式路径、断开释放容量；
- 密钥不出现在错误、历史和响应 Header。

在 `package.json` 增加 `npm test`，同时保留 `node --check server.js`。

### 12.2 真实缓存验收

自动化通过后，使用用户批准的账号和支持缓存的真实模型发送首次请求与一次相同长前缀请求。执行前再次说明模型与请求次数；记录：

- 账号与供应商路由是否稳定；
- 两次响应的 `usage.prompt_tokens_details.cached_tokens`；
- 若为 Claude 格式，同时检查其可用的 cache usage 字段。

不记录请求正文或密钥。`cached_tokens > 0` 才能宣称真实缓存命中；稳定路由但为 0 时只报告路由成功，不伪称缓存成功。

## 13. 回滚与运维

- 新字段均有兼容默认值；将 `accountMode` 改回 `single/roundrobin` 可立即停用 sticky。
- 清空 `accountErrorRules` 可恢复旧式“错误只走供应商链”的行为。
- `maxConcurrent: 0` 可停用账号并发限制。
- 删除账号 `perModel` 可恢复全局路由。
- 发布前备份 `config.json` 与 `metadata.json`；迁移只补字段，不删除旧配置。
- 若 native Cline transport 出现兼容问题，可在不改变调度/状态机契约的前提下单点回滚该传输函数。
