# Cline Pass 上游控制台（cline-pass-switcher）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-green)
![Docker](https://img.shields.io/badge/docker-ready-2496ED)

Node.js 本地/服务器代理 + 网页控制台，用于 [Cline Pass](https://cline.bot/cline-pass) 订阅：

- 🔍 **上游枚举与校验** —— 列出订阅模型背后每一条上游渠道，并一键实测哪些「✔可用 / ⏳限流 / ✘不可钉」
- 🎯 **精确钉住上游** —— 严格钉住 / 优先+回退两种模式，支持按最低成本、最快首字、最高吞吐排序
- 🧬 **多上游优先级故障转移（2026-09-06 新增）** —— 勾选多个上游即按勾选顺序逐个尝试：第一个异常（报错 / 网络失败 / 超时）自动顺切下一个，全部失败才透传错误；每次尝试有独立 120s 超时与逐次尝试明细（请求头 X-Cline-Target-Upstream: a>b 与 X-Cline-Attempts，历史与测试台展示逐次尝试路径 upstream(502) 到 upstream(200)）
- 🚫 **上游排除** —— 勾「排除」的渠道永不被使用：勾选模式下从候选中剔除；自动模式与优先+回退模式下把排除换算成 only 白名单（已知上游 - 排除项）注入，两类管道均实测生效；网关侧渠道清单更新导致白名单过期时，报错中附带的最新渠道清单会被自动学习合并
- 👥 **账号池** —— 支持单账号、轮询、HRW 粘性、最少连接、加权轮询和优先级容灾；六种安全预设可先预览再应用
- 🛡️ **账号高级设置** —— 备注、并发、权重、优先级、安全自定义 Header，以及 HTTP/HTTPS/SOCKS5/SOCKS5H 出站代理（故障绝不回退直连）
- 🔗 **账号级模型路由** —— 每个账号可为模型整项覆盖全局上游顺序、模式、排除、排序与重试上限，删除专属配置即可恢复继承
- 📊 **可信统计与健康度** —— 独立统计板块展示累计/最近 24 小时请求、真实 usage Token、缓存 Token 双指标和账号健康；缺失字段显示无数据
- 🌡️ **可排序调度流水线** —— 可拖动排序健康过滤、Cline 额度热池、健康分层和会话粘性；越靠前优先级越高，全部关闭时六种账号模式保持原行为
- 📋 **观测** —— 独立滚动请求/错误 JSONL 日志，支持筛选、分页和清空；记录安全的调度原因、别名解析与供应商路径
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
| `accountErrorRules` | 全局账号处置规则，例如 `{"429":{"action":"cooldown","cooldownMs":1800000},"500":{"action":"ban"}}`；控制台另提供五组可预览、合并或替换的快捷预设，高级 JSON 始终可编辑 |
| `accountPipeline` | 可选叠加层：`{ quotaPool, excludeUnhealthy, healthSort, sticky, order }`；`order` 是四步骤的精确排列，默认 `excludeUnhealthy → quotaPool → healthSort → sticky` |
| `proxyKey` | 下游代理密钥；空 = 不鉴权 |
| `publicBaseUrl` | 公网代理地址（控制台展示用） |
| `detailedLogging` | 默认 `false`；详细日志独立开关，也可在“详细日志”页面即时保存 |
| `exposeCatalog` | `true` 时代理的 `/v1/models` 会合并 Cline 公开目录模型；默认 `false` 只返回订阅模型（避免客户端模型列表被淹没） |
| `knownModels` | 订阅模型清单（控制台主表） |
| `modelAliases` | 客户端别名到现有 `cline-pass/*` 模型的映射；路由按解析后的模型执行 |
| `perModel` | 每模型路由：`{ upstreams, exclude, pinMode, sort, maxRetries }`；`maxRetries` 是首试后的外层重试次数。账号内同名配置整项覆盖全局配置，不逐字段合并 |
| `apiKey` | 旧版单 key 字段，启动时自动迁移进 `accounts` |

---

## 核心机制：Cline Pass 的两条路由管道（实测发现）

Cline Pass 订阅模型在 Cline 网关之后分成两条管道，钉住上游的写法**完全不同**：

| 管道 | 实际后端 | 识别特征 | 钉住方式 |
|---|---|---|---|
| **直连**（direct） | OpenRouter | 响应顶层带 `provider` 与真实 `model` 字段 | 顶层 `provider.only / order` |
| **规划器**（planner） | **Vercel AI Gateway** | 响应带 `provider_metadata.gateway.routing` | **`providerOptions.gateway.only / order / sort`** |

**关键发现**：规划器管道的请求由 Vercel AI Gateway 执行，请求体里的顶层 `provider.only/order` 会被 Cline 丢弃
（这也是官方 API 上"换上游不生效"的原因），但 `providerOptions.gateway` 嵌套形式会**原样透传**：

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
| 账号管理 | 六种调度模式、鼠标拖动/键盘按钮可排序流水线、错误规则快捷预设、名称/备注搜索、右侧设置抽屉和代理测试 |
| 统计 | 累计/最近 24 小时真实 usage Token 与缓存覆盖、账号健康评分、Cline 5h/周/月额度及池状态 |
| 访问与安全 | 修改下游代理密钥（即时生效）、公网代理地址、鉴权开关 |
| 订阅模型 | 背后模型 / 渠道数 / 最近实际渠道；渠道下拉（带可用性标注）；严格钉住 / 优先+回退；排序 |
| 操作按钮 | 探测（刷新渠道清单）、测试（单次钉住验证）、校验（全渠道实测地图） |
| 测试台 | 任选模型+渠道发一条小请求，直接看网关是否采纳 |
| 请求/错误日志 | 独立 JSONL 视图、筛选、游标分页、详情与分类清空 |
| 模型别名 | 批量生成去前缀别名、统一前后缀、冲突校验和完整映射保存 |
| 完整目录 | Cline 公开目录模型，`:free` 变体可精确钉住 |

代理同时做了兼容性标准化：解包 Cline 的 `{"data":...}` 包装为标准 OpenAI 格式，并在可验证时保留真实上游 HTTP 状态；仅网络失败、非 JSON 或无有效状态的错误包使用 502。响应附加不含密钥/会话值的 `X-Cline-Target-Upstream / X-Cline-Actual-Upstream / X-Cline-Account` 等诊断头。

## NewAPI、会话粘性与 Header 边界

NewAPI 将渠道 Base URL 指向 `http://switcher:3123/v1` 即可使用现有流式/非流式 OpenAI Chat Completions。下游 `Authorization` 只用于本代理鉴权，转发到 Cline 的始终是所选账号密钥。

`sticky` 模式分别识别 Codex 的 parent thread / `prompt_cache_key` / session/thread 字段，以及 Claude Code 的 parent-agent / session / agent 字段；无显式会话时只对首个 system/developer 与首个 user 消息做本机 HMAC 路由指纹。原始会话值和消息不会持久化。客户端真实提供的 Codex、Claude 或通用会话/SDK Header 按允许列表透传；`Authorization`、`Proxy-Authorization`、Cookie、逐跳 Header、Installation ID 和 Attestation 始终剔除，也不会伪造 User-Agent、设备、浏览器或 TLS 指纹。

账号错误规则默认空以兼容旧行为。快捷预设的 4xx 只处理 429；`ignore` 保持账号可用；`cooldown` 到期自动恢复；`ban` 只能在控制台手动恢复。普通供应商故障转移固定使用同一账号，只有 cooldown/ban 且 SSE 尚未开始时最多换号一次。

调度流水线固定先执行硬过滤，再按 `accountPipeline.order` 执行已启用步骤，最后应用现有账号模式。越靠前的步骤优先级越高，后续步骤只细分当前候选组；关闭的步骤仍保留位置。旧配置缺少顺序时迁移为健康过滤 → 额度池 → 健康分层 → 会话粘性；`accountMode=sticky` 且未显式启用粘性步骤时，会在其他已启用步骤之后隐式应用一次。额度通过账号 Bearer 后台读取半公开的 `GET /users/me/plan/usage-limits`，15 分钟后过期；失败、缺窗或接口变化均归为未知并回退普通调度，聊天请求不会等待额度刷新。健康度使用最近 24 小时每请求每账号最多一个终态结果；少于 5 个结果为数据不足，禁用/封禁/冷却优先覆盖评分。

统计只接收客户端聊天的最终真实 `usage`：非流式取最终响应，流式只取最后一个累计 usage 快照，供应商重试不累加，换号后的 token 只归最终响应账号。缓存 Token 占比使用明确同时返回 cache/input 的配对数据，命中请求率只以明确返回 cache 字段的请求为分母。管理测试、探测、渠道校验、模型抓取和额度刷新不进入统计。动态统计保存在 `metadata.json` 的版本化、1440 分钟/50,000 账号分钟单元有界结构中；旧名称统计只作为可能含控制台测试的独立基线展示。首期不提供 RPM、统计重置、7 天趋势、出口 IP 或指纹伪装。

### 日志、代理和安全边界

认证管理 API `GET /api/statistics` 返回累计、最近 24 小时、当前账号健康与严格投影的额度信息，不返回分钟桶、密钥、代理、Header、消息、会话或原始额度响应。

请求与错误日志分别写入 `DATA_DIR/logs/requests-*.jsonl` 和 `errors-*.jsonl`。默认保留 30 天、请求 50,000 条、错误 10,000 条，两类合计不超过 100 MiB；查询 API 为 `GET /api/logs/{requests|errors}`（`limit` 1～200、`cursor` 游标和字段筛选），对应 `DELETE` 只清空指定类型。每个代理请求返回 `X-Cline-Request-Id`。

账号代理支持 `http://`、`https://`、`socks5://`、`socks5h://` 和可选 URL 用户名/密码，只应用于该账号的 Cline 请求；代理失败进入网络/代理错误记录，并且不会回退直连。账号 Header 在客户端协议白名单之后合并，随后由系统强制覆盖 `Content-Type` 和账号 `Authorization`。Authorization、Cookie、逐跳 Header、会话/线程/设备身份及凭据类 Header 均禁止配置。

普通请求/错误日志仅保存允许字段和已应用 Header 名称，不保存账号 Key、代理 URL/认证值、Header 值、备注、原始会话、消息正文或敏感上游正文。旧配置缺少新字段时会自动补安全默认值。

### 详细日志（默认关闭）

进入独立的 **详细日志** 板块，启用开关后立即独立保存 `detailedLogging`，无需保存账号配置，也不改变账号、批量并发或原始调度草稿。只有配置写入成功后新请求才使用新模式；已开始的请求保持原模式。启用后会持续记录提示词、普通 Header、会话与响应内容，直到手动关闭。**请先设置代理/管理密钥**；未配置时页面明确警告详细内容没有密钥保护。

- 按请求查看原始客户端输入、最终客户端响应及每次真实上游调用；正文按需加载，可复制脱敏文本。聊天 UUID 与普通请求日志一致；重试、换号和并行探测有独立调用 ID。`status` 是提交的 HTTP 状态，`result`（有值时）来自普通聊天终态；写出字节不证明客户端已收到。
- 包含三种聊天别名、控制台测试/探测/渠道校验、账号/代理测试、模型列表及已有的 Responses 501/认证/验证拒绝。配置、日志查询、静态文件、后台额度及公开目录补充请求不记录；不捕获网关内部重试或代理/TLS 线缆数据。
- Header 名称/值、结构化凭据字段、Bearer/Basic、Cookie、URL 认证/凭据查询参数及当前请求已知凭据回显会脱敏，原值不可恢复。普通模型参数与 usage 计数保留。无法识别任意自由文本中的未知秘密；不要把此功能当作通用数据脱敏或备份工具。
- 每个请求/响应正文独立捕获最多 **5 MiB**，不截断实际流量。保留安全文本/JSON 前缀及完整 SSE 事件；缺失尾部、截断、未读、中断、无效编码或无法安全解释的片段有明确状态。部分 JSON 可能补齐结构后脱敏，因此不是可重放的原始请求。
- 文件独立存于 `DATA_DIR/detailed-logs/`（目录 0700、文件 0600），按最早请求整组清理，最多 **7 天 / 1 GiB**，高流量可能提前淘汰。查询仅扫描有界元数据，正文单独读取；游标按时间/UUID 继续，即使前页已淘汰也不会把路径当作游标。
- “清空详细日志”仅清除此存储；清空前的活动请求不能重新写回，清空后新请求仍可记录。普通日志和统计不受影响。启动时把已落盘的 `open` 请求身份标记为 `interrupted`；未完成正文不会被伪装成完整记录。早期元数据尚未落盘就退出的请求仍可能丢失。
- 诊断文件写入不阻塞模型完成。内部保留负载预算为 64 MiB（不是精确 RSS 上限），并限制活动捕获/队列及脱敏工作量；超限只丢弃诊断并报告 `resource-limited`/计数，不改变流量。临时存储失败通过安全健康状态报告，恢复后后续请求可继续记录；不可读/损坏组不会被当作有效完整记录或自动删除。

管理 API（沿用现有密钥边界，返回 `Cache-Control: no-store`）：`GET/POST /api/logs/settings`，POST 仅接受 `{ "detailedLogging": true|false }`；`GET/DELETE /api/logs/details`；`GET /api/logs/details/<requestId>`；`GET /api/logs/details/<requestId>/bodies/<bodyId>`（脱敏 `text/plain`，`nosniff`）。列表支持 `limit` 1–200、`cursor`、`requestId`、`from`/`to` 毫秒时间戳、`model`、`account`、`status`；错误参数返回 400，过期/已清空/缺失正文返回安全 404。

---

## 常见问题

**Q：为什么选了某个渠道会报 `invalid_request_error`？**
部分渠道被单独钉住时会因模型 ID 映射失败，还有渠道处于共享池限流（429）状态。点该模型行的「校验」，
把所有渠道实测一遍，下拉框会标注 ✔可用 / ⏳限流 / ✘不可钉。钉住失败的渠道会被自动学习标记。

**Q：限流的渠道还能用吗？**
能。限流是共享池的临时状态，过段时间重新「校验」即可；或改用「优先+回退」模式，限流时自动跳到其他渠道。

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
