# Cline Pass 上游控制台（cline-pass-switcher）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-green)
![Docker](https://img.shields.io/badge/docker-ready-2496ED)

Node.js 本地/服务器代理 + 网页控制台，用于 [Cline Pass](https://cline.bot/cline-pass) 订阅：

- 🔍 **上游枚举与校验** —— 列出订阅模型背后每一条上游渠道，并一键实测哪些「✔可用 / ⏳限流 / ✘不可钉」
- 🎯 **精确钉住与一键配置上游** —— 严格钉住 / 优先+回退均由 switcher 外层执行；每个具名 HTTP attempt 只注入当前 provider 的单元素 `only`。可按账号执行探测→校验→预览→测试→确认，并支持 provider 内成本、首字、吞吐排序
- 🧬 **双维度错误策略** —— 一套有序 `errorRules` 可分别作用于账号或模型×Provider，支持状态码、正文 ANY、响应 Header、Provider/model 范围及 ignore/degrade/cooldown/hard-quarantine；只有显式规则会冷却或硬隔离
- 🚫 **上游排除** —— 勾「排除」的已知渠道不会进入 attempt 计划；已知渠道全部被排除时安全失败，不会用 auto 绕过排除
- 👥 **账号池** —— 支持单账号、轮询、HRW 粘性、最少连接、加权轮询和优先级容灾；六种安全预设可先预览再应用
- 🛡️ **账号高级设置** —— 备注、并发、权重、优先级、安全自定义 Header，以及 HTTP/HTTPS/SOCKS5/SOCKS5H 出站代理（故障绝不回退直连）
- 🔗 **账号级模型路由** —— 每个账号可为模型整项覆盖全局上游顺序、模式、排除、排序、重试上限与 Provider 冷却；删除专属配置即可恢复继承
- 📊 **可信统计与成功率** —— 独立统计板块展示累计/最近 24 小时请求、真实 usage Token、缓存 Token 双指标，以及账号与模型×Provider 的直接成功率、样本和覆盖；无样本保持“无数据”
- 🌡️ **可排序调度流水线** —— 可拖动排序 Cline 额度热池、账号成功率和会话粘性；成功率仅排序账号且不设置隐式淘汰阈值，全部关闭时六种账号模式保持原行为
- 📋 **观测** —— 独立滚动请求/错误 JSONL 日志，支持筛选、分页和清空；记录安全的亲和键类型、上游 key 是否提供、缓存命中三态、调度原因与供应商路径，但绝不记录实际会话键
- 🏷️ **模型别名** —— 批量把 `cline-pass/*` 生成客户端短别名，原始模型仍保留
- 🔑 **代理密钥** —— 给下游客户端发一把独立密钥，可随时在页面轮换
- 🌐 **OpenAI 兼容** —— 任何 OpenAI 客户端 / Cline 扩展把 Base URL 指向代理即可，无侵入

![控制台截图](docs/screenshot-top.png)

---

## 30 秒上手（本地）

```bash
git clone https://github.com/<你的用户名>/cline-pass-switcher.git
cd cline-pass-switcher
npm install
node server.js        # Node ≥ 18
```

打开 <http://127.0.0.1:3123/>，在「账号管理」里添加你的 Cline Pass 账号（`sk_` 开头的 key）并保存即可。
没有 key 也能启动：页面会提示配置入口。

> Cline Pass key 从哪里来？购买 Cline Pass 订阅后，在 Cline 的账户设置里创建 API Key。
> 订阅模型 ID 均为 `cline-pass/*` 前缀（如 `cline-pass/glm-5.2`）。

客户端接入（任何 OpenAI 兼容工具）：

```
Base URL: http://127.0.0.1:3123/v1
API Key:  （在控制台「访问与安全」里设置代理密钥；本地留空 = 不鉴权）
Model:    cline-pass/glm-5.2 等
```

---

## Docker 部署

### 方式 A：All-in-one（自带 Caddy 自动 HTTPS，推荐新手）

```bash
mkdir -p data && cp config.example.json data/config.json
# 编辑 data/config.json，或在启动时用环境变量注入 key

# 有域名（A 记录指向服务器，自动签发 Let's Encrypt 受信证书）：
CPASS_DOMAIN=pass.example.com docker compose -f deploy/docker-compose.all-in-one.yml up -d --build

# 只有 IP（自签证书，浏览器需手动信任一次）：
docker compose -f deploy/docker-compose.all-in-one.yml up -d --build
```

访问 `https://你的域名/`（或 `https://服务器IP/`），控制台里设置代理密钥即可对外提供服务。

### 方式 B：已有一个性化反代（nginx 门户等）

根目录的 `docker-compose.yml` 只启动应用并绑定 `127.0.0.1:3123`，由你现有的 nginx/Caddy 做 TLS：

```nginx
location / {
    proxy_pass http://127.0.0.1:3123;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;            # 流式响应必须
    proxy_read_timeout 600s;
}
```

### 环境变量

| 变量 | 说明 |
|---|---|
| `CLINE_PASS_KEY` | 上游 Cline Pass API Key（无 config 时自动创建账号） |
| `PROXY_KEY` | 下游代理密钥（客户端访问代理的凭据） |
| `PUBLIC_BASE_URL` | 门户展示的公网代理地址，如 `https://pass.example.com` |
| `PORT` / `BIND_HOST` / `DATA_DIR` | 端口 / 绑定地址（容器内为 0.0.0.0）/ 配置目录 |

环境变量在启动时覆盖 `config.json`；此后通过控制台保存设置，会以当前生效值写回文件。

---

## 配置参考（config.json）

| 字段 | 说明 |
|---|---|
| `accounts` | 账号池：`[{ id, name, note, key, enabled, maxConcurrent, weight, priority, proxyUrl, headers, perModel }]`；备注不进入上游/日志，`maxConcurrent: 0` 表示不限 |
| `accountMode` | `single` / `roundrobin` / `sticky` / `least-connections` / `weighted-roundrobin` / `priority-failover` |
| `activeAccount` | 单账号模式下使用的下标 |
| `concurrencyWaitMs` | 容量等待时间，0～30000 ms，默认 2000 |
| `errorRules` | 唯一权威的有序错误规则数组；每条含稳定 `id`、`account`/`provider-model` 维度、动作、可选 Provider/model 范围，以及 status/body/Header AND 条件。`cooldown.reset` 使用显式格式与严格 `d/h/m/s` fallback/max；最多 100 条/64 KiB |
| `accountErrorRules` / `accountContentErrorRules` | 只读兼容镜像。旧配置启动时按“内容规则在前、状态规则在后”迁移；旧客户端不提交 `errorRules` 时只能原样回传镜像，试图修改会得到 409 |
| `accountPipeline` | 可选叠加层：三个开关与 `order`，缓存池 min/max，以及显式/消息回退会话绑定 TTL 和 LRU 上限。`0 <= cachePoolSize <= cachePoolMaxSize <= 100000`；默认 TTL 为 2h/15m、上限 50,000。旧配置缺 max 时自动取 min，不会升级后自动扩容 |
| `proxyKey` | 下游代理密钥；空 = 不鉴权 |
| `publicBaseUrl` | 公网代理地址（控制台展示用） |
| `detailedLogging` | 默认 `false`；完整详细捕获，也可在“详细日志”页面即时保存 |
| `errorDetailLogging` | 默认 `false`；仅捕获真实失败聊天 attempt 的脱敏响应诊断；完整模式同时开启时优先 |
| `exposeCatalog` | `true` 时代理的 `/v1/models` 会合并 Cline 公开目录模型；默认 `false` 只返回订阅模型（避免客户端模型列表被淹没） |
| `knownModels` | 订阅模型清单（控制台主表） |
| `modelAliases` | 客户端别名到现有 `cline-pass/*` 模型的映射；路由按解析后的模型执行 |
| `perModel` | 每模型路由：`{ upstreams, exclude, pinMode, sort, maxRetries, providerCooldownMs }`；`maxRetries` 是首试后的外层重试次数，`providerCooldownMs` 为 0～300000（0 关闭）并在首包前确定性失败后短暂跳过该 Provider。账号内同名配置整项覆盖全局配置，不逐字段合并 |
| `apiKey` | 旧版单 key 字段，启动时自动迁移进 `accounts` |

---

## 核心机制：Cline Pass 的两条路由管道（实测发现）

Cline Pass 订阅模型在 Cline 网关之后分成两条管道，钉住上游的写法**完全不同**：

| 管道 | 实际后端 | 识别特征 | 钉住方式 |
|---|---|---|---|
| **直连**（direct） | OpenRouter | 响应顶层带 `provider` 与真实 `model` 字段 | 顶层 `provider.only`（单元素） |
| **规划器**（planner） | **Vercel AI Gateway** | 响应带 `provider_metadata.gateway.routing` | **`providerOptions.gateway.only / sort`**（`only` 单元素） |

**关键发现**：规划器管道的请求由 Vercel AI Gateway 执行，请求体里的顶层 `provider.only/order` 会被 Cline 丢弃。
本项目只通过 `providerOptions.gateway` 注入当前单一 provider，不再把多 provider `order` 委托给网关；因此每次外层 attempt 可观测、可归因：

```json
{
  "model": "cline-pass/glm-5.2",
  "messages": [],
  "providerOptions": { "gateway": { "only": ["alibaba"] } }
}
```

实测响应：`finalProvider: "alibaba"`，规划器理由变为 `Provider set restricted to: alibaba`。
参考：[Vercel AI Gateway — Provider Filtering, Ordering & Sorting](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)

### 上游枚举的三种手段

1. **响应元数据回读**：规划器管道带 `canonicalSlug` / `fallbacksAvailable` / `finalProvider`；直连管道顶层 `provider` 即实际上游；
2. **假上游探测**（零 token）：带不存在的 `only:["__probe__"]` 让网关在路由层报错并列出精确的可用渠道清单（两条管道的清单**不一致**，要分别取）；
3. **OpenRouter 公开接口** `GET /api/v1/models/{slug}/endpoints`：补充上下文长度/在线率（对直连管道有直接参考意义）。

### 实测记录（2026-09）

| 实验 | 结果 |
|---|---|
| glm-5.2 + 顶层 `provider.only/ignore/order` | 全部被网关丢弃，恒选同一渠道 |
| glm-5.2 + `providerOptions.gateway.only:["alibaba"]` | ✔ `finalProvider: alibaba` |
| glm-5.2 流式 + `only:["baseten"]` | ✔ 流式同样生效 |
| glm-5.2 + `providerOptions.gateway.sort:"cost"` | ✔ 按成本重排执行顺序 |
| glm-5.3-flash（直连）+ 顶层 `provider.only:["gmicloud"]` | ✔ `provider: "GMICloud"` |
| glm-5.3-flash + `providerOptions.gateway` | ✘ 无效（直连管道只认顶层 provider 形式） |

> 管道归属由 Cline 侧决定、可能随时间变化，控制台的「探测」会刷新每个模型的管道类型与渠道清单。

---

## 控制台功能一览

| 卡片 | 功能 |
|---|---|
| 账号管理 | 六种调度模式、缓存活跃/备用池、24h 缓存 Token/成功率/失败摘要、三步可排序流水线、双维度统一规则可视化表格与高级 JSON、快捷预设、名称/备注搜索、右侧设置抽屉和代理测试 |
| 统计 | 累计/最近 24 小时真实 usage Token 与缓存覆盖、账号直接成功率/样本/覆盖、Cline 5h/周/月剩余额度及池状态 |
| 访问与安全 | 修改下游代理密钥（即时生效）、公网代理地址、鉴权开关 |
| 订阅模型 | 背后模型 / 渠道发现状态 / 最近实际渠道 / 24h 缓存 Token 占比与样本；渠道下拉（带可用性标注）；严格钉住 / 优先+回退；排序 |
| 操作按钮 | 探测（刷新渠道清单）、测试（单次钉住验证）、校验（固定账号全渠道实测）、一键配置（生成三种策略预览；确认后才保存） |
| 测试台 | 任选模型+渠道发一条小请求，直接看网关是否采纳 |
| 请求/错误日志 | 独立 JSONL 视图、筛选、游标分页、详情与分类清空 |
| 模型别名 | 批量生成去前缀别名、统一前后缀、冲突校验和完整映射保存 |
| 完整目录 | Cline 公开目录模型，`:free` 变体可精确钉住 |

代理同时做了兼容性标准化：解包 Cline 的 `{"data":...}` 包装为标准 OpenAI 格式，并在可验证时保留真实上游 HTTP 状态；仅网络失败或无有效状态的错误包使用 502。响应附加不含密钥/会话值的诊断头：`X-Cline-Target-Upstream` 是最终账号的外层规划顺序，`X-Cline-Attempts` 是跨账号累计的真实 HTTP attempt 数，`X-Cline-Actual-Upstream` 只在响应 routing 中可解析终态 provider 时有值。三者都不能代替请求/错误日志中的逐次账号与 provider 路径。

## NewAPI、会话粘性与 Header 边界

NewAPI 将渠道 Base URL 指向 `http://switcher:3123/v1` 即可使用现有流式/非流式 OpenAI Chat Completions。下游 `Authorization` 只用于本代理鉴权，转发到 Cline 的始终是所选账号密钥。

`sticky` 模式分别识别 Codex 的 parent thread / `prompt_cache_key` / session/thread 字段，以及 Claude Code 的 parent-agent / session / agent 字段；parent/root 优先于 child/agent。直接 Chat 请求若已有合法 `prompt_cache_key` 或 `session_id` 会原样保留；若只收到 Codex/Claude 显式会话 Header/metadata，则派生域分离、不可反推原值的 `prompt_cache_key` 发给 Cline。无显式会话时仍只对首个 system/developer 与首个 user 消息做本机 HMAC 账号路由，但不会把该 fallback 冒充成显式上游 key。原始会话、派生 key、HMAC 指纹和消息不会进入普通日志/metadata。客户端真实提供的协议 Header 仍按允许列表透传；`Authorization`、`Proxy-Authorization`、Cookie、逐跳 Header、Installation ID 和 Attestation 始终剔除，也不会伪造 User-Agent、设备、浏览器或 TLS 指纹。NewAPI 若在到达 Switcher 前已丢失会话字段，本服务无法恢复原值，会如实显示 `message_hmac` 回退。

`errorRules` 按数组顺序首条命中（包括 `ignore`）。`statuses` 内部 OR，`body_contains` 字符串数组为 ANY；Provider/model 范围、状态、正文和 Header 条件之间为 AND，均使用大小写不敏感普通文本而非正则。无显式命中时，明确账号认证/额度/代理错误只记录账号 `degrade`，明确具名 Provider 的 429/5xx/网络/超时/不可用只记录该模型×Provider 的 `degrade`，不自动冷却。账号 cooldown/hard-quarantine 可在首包前最多换号一次；Provider 动作只影响当前 Provider；首包后只更新未来状态，不重放当前请求。账号通过现有恢复按钮清理状态，Provider 通过控制台恢复按钮或认证的 `POST /api/providers/recover` 精确恢复 `{ model, provider }`。

调度固定先执行禁用、账号冷却、硬隔离和 reserve 等资格过滤。只有 success-rate 时，每次请求按 `success / (success + degrade)` 降序，有数据优先、无数据置后；只有 sticky 时继续使用无状态 HRW。sticky 与 healthSort 同时生效时，sticky 变为“已有会话绑定命中门”：hit 直接使用绑定账号，miss 才按 `order` 中 quotaPool/healthSort 的相对顺序处理当前活跃候选，并用 HRW 做同层稳定 tie-break。成功率变化不会迁移已有绑定。

`cachePoolSize > 0` 仅在 sticky 模式或显式启用会话粘性步骤时生效；它是初始/最小大小，`cachePoolMaxSize` 是扩容上限。成员始终按硬资格、非 reserve、priority 和稳定账号 ID 从当前 target 派生，不持久化成员 ID。只有全部活跃账号都设置了有限 `maxConcurrent` 且满载，等待 `concurrencyWaitMs` 后重算仍满载，target 才同步 grow-one 并持久化到 `metadata.json`；多个并发超时不会越过 max，压力下降不自动缩容，`max=min` 可关闭自动扩容。备用账号必须先正式晋升为 active 才能承载请求或建立绑定；无合格成员/达到 max 时返回容量错误，unlimited 活跃账号不会触发增长。

组合模式的 session binding 只存在内存，复用已有 HMAC fingerprint：显式 Codex/Claude/session 身份使用 2 小时滑动 TTL，`message_hmac` 使用 15 分钟，默认最多 50,000 条并按 LRU 淘汰，重启即清空。首次 miss 在取得 lease 后建立 provisional binding，真实 native attempt 提交后确认；同会话并发可命中 provisional。绑定账号满载时先等待，再临时使用其他 active，但不会改绑。删除/禁用、Key/代理变化、账号 cooldown/hard-quarantine、退出 active 或进入 reserve 会失效并重新选择；Provider 失败、普通失败、成功率或 hot/warm/unknown 变化不改绑。管理 API/普通日志仅显示安全计数及 `bindingSource`/`bindingResult` 枚举，不输出 session、fingerprint、候选表或绑定明细。

额度通过账号 Bearer 后台读取半公开的 `GET /users/me/plan/usage-limits`，15 分钟后过期；失败、缺窗或接口变化均归为未知并回退普通调度，聊天请求不会等待额度刷新。账号成功率按请求/账号去重，模型×Provider 按每个具名真实 attempt 记录；无样本为 null，冷却、硬隔离和禁用作为独立状态展示。

统计只接收客户端聊天的最终真实 `usage`：非流式取最终响应，流式只取最后一个累计 usage 快照，供应商重试不累加，换号后的 token 只归最终响应账号。缓存 Token 占比使用明确同时返回 cache/input 的配对数据，命中请求率只以明确返回 cache 字段的请求为分母；模型统计按别名解析后的实际模型聚合，模型表只展示 24 小时缓存 Token 占比和配对样本数。统计另聚合显式/回退亲和请求、Provider fallback、Provider cooldown 与 half-open 请求数。管理测试、探测、渠道校验、模型抓取和额度刷新不进入聊天统计。动态统计保存在 `metadata.json` 的版本化、1440 分钟/50,000 账号分钟/50,000 模型分钟结构中，迁移后的模型与路由指标窗口在覆盖满 24 小时前会明确标注“统计积累中”；旧名称统计只作为可能含控制台测试的独立基线展示。首期不提供 RPM、统计重置、7 天趋势、出口 IP 或指纹伪装。

### 日志、代理和安全边界

认证管理 API `GET /api/statistics` 返回累计、最近 24 小时、按实际模型聚合的滚动缓存统计、当前账号健康与严格投影的额度信息，不返回分钟桶、密钥、代理、Header、消息、会话或原始额度响应。

请求与错误日志分别写入 `DATA_DIR/logs/requests-*.jsonl` 和 `errors-*.jsonl`。默认保留 30 天、请求 50,000 条、错误 10,000 条，两类合计不超过 100 MiB；服务先监听再后台恢复既有日志，恢复期间模型流量和新日志不受影响，查询会暂时返回安全的 `503` 而不会展示部分历史。查询 API 为 `GET /api/logs/{requests|errors}`（`limit` 1～200、`cursor` 游标和字段筛选），对应 `DELETE` 只清空指定类型。每个代理请求返回 `X-Cline-Request-Id`。逐次日志记录受控的 `errorScope / scopeEvidence / failureClass / healthAction / retryAfterMs / responseContentType / responseBytes`，不会保存原始响应正文。

账号代理支持 `http://`、`https://`、`socks5://`、`socks5h://` 和可选 URL 用户名/密码，只应用于该账号的 Cline 请求；代理失败进入网络/代理错误记录，并且不会回退直连。账号 Header 在客户端协议白名单之后合并，随后由系统强制覆盖 `Content-Type` 和账号 `Authorization`。Authorization、Cookie、逐跳 Header、会话/线程/设备身份及凭据类 Header 均禁止配置。

普通请求日志会保存亲和键类型/置信度、caller/派生上游 key 的安全来源枚举、`provider.order` 是否覆盖 sticky、以及依据最终明确 usage 得出的缓存三态（命中/明确未命中/未知）；Provider cooldown/half-open 动作只作为 bounded attempt 枚举。它不保存实际 prompt/session/thread key、派生 key、HMAC 指纹、账号 Key、代理 URL/认证值、Header 值、备注、消息正文或敏感上游正文。旧日志缺少字段时显示未知，绝不迁移或猜测。

### 错误详情与完整详细日志（默认关闭）

进入独立的 **详细日志** 板块，可分别启用 `errorDetailLogging`（仅真实失败的聊天上游 attempt）和 `detailedLogging`（完整捕获）。开关会立即独立保存，无需保存账号配置，也不改变账号、批量并发或原始调度草稿；只有配置写入成功后的新请求使用新模式。两者同时开启时完整模式优先，同一请求不会重复保存。**请先设置代理/管理密钥**；未配置时页面明确警告详细内容没有密钥保护。

错误详情模式不保存 ingress/outbound 请求正文、成功响应、完整成功 SSE 或最终客户端正文。它会保存失败 attempt 的脱敏响应 Header，以及已有模型路径已经读取的错误正文；SSE 只保留触发错误的完整事件。收到响应前失败显示 `no-response`，起流后断开显示 `stream-transport-failed` 并保留响应 Header。失败后重试成功或换号成功，先前失败 attempt 仍可通过普通错误行中的 `requestId + attemptIndex + detailCallId` 精确查看。普通 JSONL 仍不保存 Header 值或正文。

- 完整模式可按请求查看原始客户端输入、最终客户端响应及每次真实上游调用；错误模式只列出失败调用。正文按需加载，可复制脱敏文本。聊天 UUID 与普通请求日志一致；真实 native chat 调用拥有稳定的 attempt index 和独立调用 ID。`status` 是提交的 HTTP 状态，`result`（有值时）来自普通聊天终态；写出字节不证明客户端已收到。
- 完整模式包含三种聊天别名、控制台测试/探测/渠道校验、账号/代理测试、模型列表及已有的 Responses 501/认证/验证拒绝；错误模式仅适用于三种聊天别名的真实失败上游调用。配置、日志查询、静态文件、后台额度及公开目录补充请求不记录；不捕获网关内部重试或代理/TLS 线缆数据。
- Header 名称/值、结构化凭据字段、Bearer/Basic、Cookie、URL 认证/凭据查询参数及当前请求已知凭据回显会脱敏，原值不可恢复。普通模型参数与 usage 计数保留。无法识别任意自由文本中的未知秘密；不要把此功能当作通用数据脱敏或备份工具。
- 每个请求/响应正文独立捕获最多 **5 MiB**，不截断实际流量。保留安全文本/JSON 前缀及完整 SSE 事件；缺失尾部、截断、未读、中断、无效编码或无法安全解释的片段有明确状态。部分 JSON 可能补齐结构后脱敏，因此不是可重放的原始请求。
- 文件独立存于 `DATA_DIR/detailed-logs/`（目录 0700、文件 0600），按最早请求整组清理，最多 **7 天 / 1 GiB**，高流量可能提前淘汰。查询仅扫描有界元数据，正文单独读取；游标按时间/UUID 继续，即使前页已淘汰也不会把路径当作游标。
- “清空详细日志”仅清除此存储；清空前的活动请求不能重新写回，清空后新请求仍可记录。普通日志和统计不受影响。启动时把已落盘的 `open` 请求身份标记为 `interrupted`；未完成正文不会被伪装成完整记录。早期元数据尚未落盘就退出的请求仍可能丢失。
- 诊断文件写入不阻塞模型完成。内部保留负载预算为 64 MiB（不是精确 RSS 上限），并限制活动捕获/队列及脱敏工作量；超限只丢弃诊断并报告 `resource-limited`/计数，不改变流量。普通错误原因在脱敏后限制为 16 KiB，单条普通 JSONL 限制为 64 KiB，pending 队列同时限制记录数和字节数。临时存储失败通过安全健康状态报告，恢复后后续请求可继续记录；不可读/损坏组不会被当作有效完整记录或自动删除。
- SIGTERM/SIGINT 会先停止新接入和额度调度，等待活动请求 finalizer 写入，再有界 drain 普通/详细 store；达到期限后才强制关闭连接，永久阻塞的日志 writer 不会无限拖住退出。

管理 API（沿用现有密钥边界，返回 `Cache-Control: no-store`）：`GET/POST /api/logs/settings`，POST 接受由 `detailedLogging` / `errorDetailLogging` 组成的非空布尔字段子集，旧的单字段请求仍兼容；`GET/DELETE /api/logs/details`；`GET /api/logs/details/<requestId>`；`GET /api/logs/details/<requestId>/bodies/<bodyId>`（脱敏 `text/plain`，`nosniff`）。列表支持 `limit` 1–200、`cursor`、`requestId`、`from`/`to` 毫秒时间戳、`model`、`account`、`status`、`result`；错误参数返回 400，过期/已清空/缺失正文返回安全 404。

---

## 常见问题

**Q：为什么选了某个渠道会报 `invalid_request_error`？**
部分渠道被单独钉住时会因模型 ID 映射失败，还有渠道处于共享池限流（429）状态。点该模型行的「校验」，
把所有渠道实测一遍，下拉框会标注 ✔可用 / ⏳限流 / ✘不可钉。钉住失败的渠道会被自动学习标记。

**Q：限流的渠道还能用吗？**
能。provider/unknown 429 优先采用合法 `Retry-After`，否则从 60 秒开始有界退避；冷却到期后渠道回到原人工位置接受半开请求，成功立即恢复。人工顺序不会被 `ok/degraded/unknown` 标签重排。

**Q：如何确认一次 429 到底换了账号还是换了 provider？**
先用响应的 `X-Cline-Request-Id` 查询 `/api/logs/requests?requestId=...` 与 `/api/logs/errors?requestId=...`：前者给出账号路径和全部真实 attempts，后者给出每次 `targetProvider/errorScope/scopeEvidence/accountAction`。`X-Cline-Target-Upstream` 只是规划目标，`X-Cline-Actual-Upstream: unknown` 只是未解析到终态 provider，二者都不是切换证据。若仍需区分 Cline 边缘 HTML 429 与内部 provider 限流，可短期启用“错误详情”，再从对应错误行按需查看精确 attempt 的脱敏 Header/正文；排障结束后关闭。

**Q：直接用官方 API 写 `provider.only` 为什么不生效？**
对规划器管道（走 Vercel AI Gateway 的模型）会被 Cline 网关丢弃，请改用 `providerOptions.gateway`，见上文。

**Q：两条管道的渠道清单为什么不一样？**
钉住发生在不同后端（OpenRouter vs Vercel AI Gateway），各自支持的渠道池不同，要以对应清单为准。

**Q：订阅额度怎么计？**
经代理的请求与直连官方 API 计费一致；「探测/测试/校验」会产生极小额的真实请求（每次约 0.0002 美元级）。

---

## 安全提醒

- `config.json` / `data/` 含明文密钥，已在 `.gitignore` 排除，**不要提交或分享**；
- 对外部署务必设置 `proxyKey`（控制台可随时轮换）；
- `maxRetries > 0` 会放大外层供应商尝试数量，注意额度消耗；缺失或 `null` 表示走完已配置候选序列。
- 实际缓存命中必须以真实响应中的 `usage.prompt_tokens_details.cached_tokens`（或供应商等价字段）为准；本项目不会仅凭粘性配置宣称缓存成功。

## License

[MIT](LICENSE)
