# Cline Pass 上游控制台（cline-pass-switcher）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-green)
![Docker](https://img.shields.io/badge/docker-ready-2496ED)

Node.js 本地/服务器代理 + 网页控制台，用于 [Cline Pass](https://cline.bot/cline-pass) 订阅：

- 🔍 **上游枚举与校验** —— 列出订阅模型背后每一条上游渠道，并一键实测哪些「✔可用 / ⏳限流 / ✘不可钉」
- 🎯 **精确钉住与一键配置上游** —— 首选固定+健康回退 / Switcher 健康自动选择都由 switcher 外层执行；每个具名 HTTP attempt 只注入当前 provider 的单元素 `only`。可按账号执行探测→校验→预览→测试→确认，并支持 provider 内成本、首字、吞吐排序
- 🧬 **双维度错误策略** —— 一套有序 `errorRules` 可分别作用于账号或模型×Provider，支持状态码、正文 ANY、响应 Header、Provider/model 范围及 ignore/degrade/cooldown/hard-quarantine；只有显式规则会冷却或硬隔离
- 🚫 **上游排除** —— 勾「排除」的已知渠道不会进入 attempt 计划；已知渠道全部被排除时安全失败，不会用 auto 绕过排除
- 👥 **账号池** —— 支持单账号、轮询、HRW 粘性、最少连接、加权轮询和优先级容灾；六种安全预设可先预览再应用
- 🛡️ **账号高级设置** —— 备注、并发、权重、优先级、安全自定义 Header，以及 HTTP/HTTPS/SOCKS5/SOCKS5H 出站代理（故障绝不回退直连）
- 🔗 **账号级模型路由** —— 每个账号可为模型整项覆盖全局上游顺序、模式、排除、排序、重试上限与 Provider 冷却；删除专属配置即可恢复继承
- 📊 **可信统计与成功率** —— 独立统计板块展示累计/最近 24 小时请求、真实 usage Token、缓存 Token 双指标，以及账号与模型×Provider 的直接成功率、样本和覆盖；无样本保持“无数据”
- 🌡️ **可排序调度流水线** —— 可拖动排序 Cline 额度热池、账号成功率和会话粘性；成功率仅排序账号且不设置隐式淘汰阈值，全部关闭时六种账号模式保持原行为
- 📋 **观测** —— 独立滚动请求/错误 JSONL 日志，支持筛选、分页和清空；记录安全的亲和键类型、上游 key 是否提供、缓存命中三态、调度原因与供应商路径，但绝不记录实际会话键
- 🏷️ **模型别名** —— 批量把 `cline-pass/*` 生成客户端短别名，原始模型仍保留
- 🔑 **代理密钥与管理员登录分离** —— 客户端密钥仅供模型接口；独立管理员密码与可吊销会话保护管理 API
- 🌐 **OpenAI 兼容** —— 任何 OpenAI 客户端 / Cline 扩展把 Base URL 指向代理即可，无侵入

![控制台截图](docs/screenshot-top.png)

---

## 30 秒上手（本地）

```bash
git clone https://github.com/<你的用户名>/cline-pass-switcher.git
cd cline-pass-switcher
npm install
# 首次运行先在仓库外创建 mode 0600 的私有 env 文件（变量见下方初始化说明）
set -a; . /path/to/private-admin.env; set +a
node server.js        # Node ≥ 18；完成首次改密后移除初始化变量再重启
```

首次运行先按下方“管理员首次初始化”设置一次性码并启动。打开 <http://127.0.0.1:3123/> 完成首次改密，然后在「账号管理」里添加 Cline Pass 账号。没有上游 key 也能启动，但管理 API 在完成初始化前一律拒绝访问。

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

# 首次初始化：在仓库外创建 mode 0600 的私有 env 文件，填写
# CLINE_PASS_ADMIN_BOOTSTRAP=1、CLINE_PASS_ADMIN_INIT_CODE=<独立随机码>；
# 空客户端 key 时还需 CLINE_PASS_ADMIN_INITIAL_PASSWORD=<非空初始密码>。
# 有域名（确保 TLS 证书受信且反代 Host 与浏览器域名一致）：
# 私有 env 文件还需 CPASS_DOMAIN=pass.example.com、CPASS_PUBLIC_ORIGIN=https://pass.example.com
# 以及 CPASS_ADMIN_PROXY_TOKEN=<openssl rand -hex 32 生成的独立 64 字符十六进制反代凭据>
docker compose --env-file /path/to/private-admin.env -f deploy/docker-compose.all-in-one.yml up -d --build

# 仅有 IP 时也需把 Caddy 监听地址和公网 Origin 设为同一 IP，
# 并确认实际 TLS 证书可被浏览器信任；不要依赖未配置域名的 localhost 默认值。
```

访问配置的 HTTPS 域名/IP，先完成独立管理员初始化，再设置客户端代理密钥。远程登录必须通过受信反代 HTTPS：设置 `PUBLIC_BASE_URL=https://实际浏览器访问域名`（all-in-one 用 `CPASS_PUBLIC_ORIGIN`，与浏览器 Origin/Host 相同），反代覆盖 `X-Forwarded-Proto: https` 和 `X-Cline-Pass-Proxy-Token`（应用环境 `CLINE_PASS_ADMIN_PROXY_TOKEN` 必须与反代私有值一致），应用端口只对该反代所在的私有网络开放；私网来源本身不能证明 TLS，公网直连 HTTP 即使设置了公网地址也会拒绝管理登录。

### 方式 B：已有一个性化反代（nginx 门户等）

根目录的 `docker-compose.yml` 只启动应用并绑定 `127.0.0.1:3123`，由你现有的 nginx/Caddy 做 TLS；通过私有 env 文件设置 `PUBLIC_BASE_URL=https://实际域名`、`CLINE_PASS_ADMIN_PROXY_TOKEN=<openssl rand -hex 32 的随机值>` 及首次初始化变量。反代配置中的同一 token 须从权限受限的私有配置注入，不要提交到仓库或转发客户端送来的同名 Header：

```nginx
location / {
    proxy_pass http://127.0.0.1:3123;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Cline-Pass-Proxy-Token <与应用环境一致的私有值>;
    proxy_buffering off;            # 流式响应必须
    proxy_read_timeout 600s;
}
```

### 管理员首次初始化、升级及回滚

在受信环境中生成**独立**随机初始化码（至少 16 字符），通过仓库外权限 0600 的私有环境文件/secret 注入 `CLINE_PASS_ADMIN_INIT_CODE`，并设置 `CLINE_PASS_ADMIN_BOOTSTRAP=1`。首次启动将当前**生效**的 `PROXY_KEY`（含环境覆盖值）作为初始管理员密码的哈希写入 `DATA_DIR/admin-auth.json`（新文件 0600）。客户端 key 为空时必须另配非空 `CLINE_PASS_ADMIN_INITIAL_PASSWORD`；空字符串永不能登录。浏览器首次远程访问须同时提交初始密码与独立初始化码，立即设定至少 12 字符的新管理员密码；此之前其他管理 API 均 401。完成后从运行环境移除初始化码、初始密码与启动标志并重启，已有管理员状态不受重启或客户端密钥轮换影响。管理员状态缺失或尚未完成首次改密期间，即使旧配置保留详细日志开关也不会捕获详细内容；完成改密后才恢复既有设置，迁移前请检查并按需关闭。不要把一次性码交给只持有客户端 key 的使用者。初始化和后续密码都不存浏览器 localStorage；旧 `cps_key` 被删除，不能迁移为管理身份。

管理脚本必须改用 `POST /api/auth/login` 获取 `HttpOnly; SameSite=Strict` Cookie 和响应中的 CSRF token；非 GET 管理请求带 `X-CSRF-Token`。`GET /api/auth/session` 可在同一会话取 token；`POST /api/auth/logout`（JSON `{}`、CSRF）吊销单个会话；`POST /api/auth/password`（`currentPassword`/`newPassword`、CSRF）保存并吊销所有会话。会话最多 8 小时，重启也吊销；密码和会话只在受信反代（公网 HTTPS Origin、覆盖的 TLS Header 和独立反代 token 均匹配）或本机 loopback HTTP 受理。重启时如生效 `PROXY_KEY`（包括环境覆盖）等于已设的管理员密码，服务会拒绝启动；应在隔离状态下改正客户端 key，再启动。`GET /api/meta` 公开；`/v1/models`、`/api/v1/models`、`/models` 与聊天别名仅认客户端 key（为空时延续开放模型代理）；`/api/*` 其余端点仅认管理员会话。旧 `Authorization`/`X-Admin-Key` 不再授权管理 API。请先验证首次改密、管理读写与脚本改造，再开放详细日志。

备份 `admin-auth.json` 时必须作为敏感状态与 `config.json` 一起保留，不要放入 release archive。丢失/损坏时管理端**不**自动从当前代理密钥重建：损坏文件启动报错并保持原字节；丢失状态要由有权访问 DATA_DIR 的运维先隔离服务，恢复安全备份，或在保留其他数据的情况下通过受信恢复流程重新设置上述一次性标志和独立码，重新完成首次改密并吊销旧浏览器会话。升级前在隔离副本演练该流程并保留原 release/配置/管理员文件备份。旧版本回滚后其旧共享代理 key 管理边界会恢复，**不得**在回滚期间启用详细正文日志或公网管理入口；优先隔离管理流量、保留原始管理员文件、恢复旧版本镜像和文件哈希，排查后再按新版本迁回，不能把回滚当作独立鉴权仍在生效。

### 环境变量

| 变量 | 说明 |
|---|---|
| `CLINE_PASS_KEY` | 上游 Cline Pass API Key（无 config 时自动创建账号） |
| `PROXY_KEY` | 下游代理密钥（仅客户端访问模型代理的凭据） |
| `CLINE_PASS_ADMIN_BOOTSTRAP` | 仅首次/受信恢复时设置 `1`，允许创建独立管理员状态（已有状态不重置） |
| `CLINE_PASS_ADMIN_INIT_CODE` | 独立于代理密钥的随机一次性码，至少 16 字符；从运维环境/私有配置注入，不要写入 config、命令历史或日志 |
| `CLINE_PASS_ADMIN_INITIAL_PASSWORD` | 仅当生效客户端密钥为空时所需的非空初始密码；仍必须搭配一次性码，首次改密后失效 |
| `PUBLIC_BASE_URL` | 门户展示地址兼管理员 HTTPS Origin 校验值，如 `https://pass.example.com`；须与反代 Host/浏览器 Origin 一致 |
| `CLINE_PASS_ADMIN_PROXY_TOKEN` | 远程 TLS 反代与应用共享的私有随机 64 字符十六进制 token；反代必须覆盖请求 Header `X-Cline-Pass-Proxy-Token`，禁止给客户端；本机 loopback HTTP 不需要 |
| `PORT` / `BIND_HOST` / `DATA_DIR` | 端口 / 绑定地址（容器内为 0.0.0.0）/ 配置目录 |

`PROXY_KEY` 等现有代理/账号变量在启动时覆盖 `config.json`；管理员首次初始化环境变量只用于独立鉴权，不写入 config/metadata。以下连接/流运行参数只从环境变量读取，不写入配置文件；非法值回退各自默认值，单位均为 **毫秒或连接数**，不猜测秒数。

| 运行变量 | 默认值 | 合法范围 |
|---|---:|---:|
| `CLINE_PASS_INBOUND_KEEP_ALIVE_MS`（请求间 idle；headers 超时为此值 + 5000） | 95000 | 100～120000 |
| `CLINE_PASS_SSE_FIRST_EVENT_MS`（首响应/首个 data 硬期限） | 120000 | 100～120000 |
| `CLINE_PASS_SSE_STREAM_IDLE_MS`（起流后 Cline socket idle） | 360000 | 200～600000 |
| `CLINE_PASS_SSE_HEARTBEAT_MS`（下游静默注释；0 关闭） | 25000 | 0～60000 |
| `CLINE_PASS_DIRECT_MAX_SOCKETS` / `CLINE_PASS_DIRECT_MAX_FREE_SOCKETS` | 256 / 32 | 1～1024 / 1～64 |
| `CLINE_PASS_PROXY_MAX_SOCKETS` / `CLINE_PASS_PROXY_MAX_FREE_SOCKETS` | 32 / 2 | 1～128 / 1～16 |

空闲上限不会超过同池活跃上限；最多缓存 128 个已保存代理 URL，超过后使用请求级一次性 agent，draft 代理测试同样一次性销毁。`NODE_ENV=test` 下可用对应 `CLINE_PASS_TEST_*` 毫秒变量覆盖上表四项时间设置，遵守相同范围；非测试环境忽略测试变量。

---

## 配置参考（config.json）

| 字段 | 说明 |
|---|---|
| `accounts` | 账号池：`[{ id, name, note, key, enabled, maxConcurrent, maxRpm, weight, priority, proxyUrl, headers, perModel }]`；备注不进入上游/日志，`maxConcurrent: 0` 表示不限 |
| `maxRpm` | 账号级每分钟真实上游请求上限（整数 0～100000，`0` 表示不限）。按每个实际发往 Cline `/chat/completions` 的 native attempt 计数（含 Provider retry；`/api/test`、`/api/probe`、`/api/validate-upstreams`、绑定已保存 accountId 的 `/api/accounts/test` 与 `/api/accounts/proxy-test` 均计数；models/catalog/quota 与无持久 accountId 的临时 credential 测试不计）。使用单进程精确滚动 60 秒窗口：重启清空、多副本各自独立，不是跨进程硬上限 |
| `accountMode` | `single` / `roundrobin` / `sticky` / `least-connections` / `weighted-roundrobin` / `priority-failover` |
| `activeAccount` | 单账号模式下使用的下标 |
| `concurrencyWaitMs` | 容量等待时间，0～30000 ms，默认 2000 |
| `errorRules` | 唯一权威的有序错误规则数组；每条含稳定 `id`、`account`/`provider-model` 维度、动作、可选 Provider/model 范围，以及 status/body/Header AND 条件。`cooldown.reset` 使用显式格式与严格 `d/h/m/s` fallback/max；最多 100 条/64 KiB。动作与直接健康样本固定为 `ignore`/0、`degrade`/1、`cooldown`/1、`hard-quarantine`/1 个失败样本，后两者同时保持临时/持续处置 |
| `retryRules` | 唯一权威的有序“停止重试”数组；每条含稳定 `id`、固定 `decision: "stop"`，以及同时存在的 `when.statuses` 与 `when.body_contains`。两类条件 AND、body 数组 ANY、大小写不敏感普通文本（不支持正则/Header）；首条命中即停止本请求剩余 Provider 与账号替换。缺失默认 `[]`；最多 100 条/64 KiB。普通日志只投影 `retryRuleId`/`retryDecision`/`retryMatchedBy` 枚举，不记录 needle 或匹配片段 |
| `accountErrorRules` / `accountContentErrorRules` | 只读兼容镜像。旧配置启动时按“内容规则在前、状态规则在后”迁移；旧客户端不提交 `errorRules` 时只能原样回传镜像，试图修改会得到 409 |
| `accountPipeline` | 可选叠加层：三个开关与 `order`，缓存池 min/max，以及显式/消息回退会话绑定 TTL 和 LRU 上限。`0 <= cachePoolLowQuotaSize <= cachePoolSize <= cachePoolMaxSize <= 100000`；默认 TTL 为 2h/15m、上限 50,000。旧配置缺 max 时自动取 min，不会升级后自动扩容 |
| `proxyKey` | 下游模型代理密钥；空仅表示客户端模型接口不鉴权，管理接口始终要求独立管理员会话 |
| `publicBaseUrl` | 公网代理地址，也是管理员远程 HTTPS Origin 校验值（应与浏览器域名一致） |
| `detailedLogging` | 默认 `false`；完整详细捕获，也可在“详细日志”页面即时保存 |
| `errorDetailLogging` | 默认 `false`；仅捕获真实失败聊天 attempt 的脱敏响应诊断；完整模式同时开启时优先 |
| `exposeCatalog` | `true` 时代理的 `/v1/models` 会合并 Cline 公开目录模型；默认 `false` 只返回订阅模型（避免客户端模型列表被淹没） |
| `knownModels` | 订阅模型清单（控制台主表） |
| `modelAliases` | 客户端别名到现有 `cline-pass/*` 模型的映射；路由按解析后的模型执行 |
| `perModel` | 每模型路由：`{ upstreams, exclude, pinMode, sort, maxRetries, providerCooldownMs }`。`upstreams` 非空时是权威来源顺序，否则使用探测到的渠道顺序；`pinMode: "strict"` 首次固定来源顺序首个可用渠道，失败后从剩余渠道按 Provider-model 24h 成功率回退；`pinMode: "preferred"` 从首次起就用同一健康顺序。每次 named HTTP attempt 只注入一个 provider。`maxRetries` 是首试后的外层重试次数，`providerCooldownMs` 为 0～300000（0 关闭）并在首包前确定性失败后短暂跳过该 Provider。账号内同名配置整项覆盖全局配置，不逐字段合并 |
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
| 账号管理 | 六种调度模式、缓存活跃/备用池、24h 缓存 Token/成功率/失败摘要、三步可排序流水线、双维度统一规则可视化表格与高级 JSON、请求级停止重试规则与手动配对预设、快捷预设、名称/备注搜索、右侧设置抽屉和代理测试 |
| 统计 | 累计/最近 24 小时真实 usage Token 与缓存覆盖、账号直接成功率/样本/覆盖、Cline 5h/周/月剩余百分比及池状态；分别展示当月剩余与三窗瓶颈的社区参考美元等值估算 |
| 访问与安全 | 修改下游代理密钥（即时生效）、公网代理地址、鉴权开关 |
| 订阅模型 | 背后模型 / 渠道发现状态 / 最近实际渠道 / 24h 缓存 Token 占比与样本；渠道下拉（带可用性标注）；首选固定+健康回退 / Switcher 健康自动选择；排序 |
| 操作按钮 | 探测（刷新渠道清单）、测试（单次钉住验证）、校验（固定账号全渠道实测）、一键配置（生成三种策略预览；确认后才保存） |
| 测试台 | 任选模型+渠道发一条小请求，直接看网关是否采纳 |
| 请求/错误日志 | 独立 JSONL 视图、筛选、游标分页、详情与分类清空 |
| 模型别名 | 批量生成去前缀别名、统一前后缀、冲突校验和完整映射保存 |
| 完整目录 | Cline 公开目录模型，`:free` 变体可精确钉住 |

代理同时做了兼容性标准化：解包 Cline 的 `{"data":...}` 包装为标准 OpenAI 格式，并在可验证时保留真实上游 HTTP 状态；仅网络失败或无有效状态的错误包使用 502。响应附加不含密钥/会话值的诊断头：`X-Cline-Target-Upstream` 是最终账号按 strict/preferred 策略给出的候选偏好顺序，`X-Cline-Attempts` 是跨账号累计的真实 HTTP attempt 数，`X-Cline-Actual-Upstream` 只在响应 routing 中可解析终态 provider 时有值。静态渠道列表与规划顺序都不能冒充实际执行路径；三者都不能代替请求/错误日志中的逐次账号与 provider 路径。

## NewAPI、会话粘性与 Header 边界

NewAPI 将渠道 Base URL 指向 `http://switcher:3123/v1` 即可使用现有流式/非流式 OpenAI Chat Completions。建议保持到 Switcher 的 HTTP/1.1 长连接（其入站 idle 95 秒，略长于 New API 默认的 90 秒连接池 idle），并关闭中间反代的 SSE 响应缓冲。Switcher 在首个上游 data 事件通过后才会向 New API 发送静默注释心跳 `: PING`（仅在完整 SSE 事件边界注入，不拆开未完成的 data 行）；这只维护 Switcher → New API 链路。若最终客户端也需要静默段心跳，请在 **New API 自己的现有运维设置**中启用其下游 ping；不需要修改 New API 源码。New API 普通 Chat 在收到上游响应头前的最终客户端取消可能不会立即传播到 Switcher，此处由首事件超时有界收敛。仅支持 HTTP/1.1 Chat Completions；不提供 HTTP/2/h2c 入站、Realtime WebSocket 或 Responses API。下游 `Authorization` 只用于本代理鉴权，转发到 Cline 的始终是所选账号密钥。

`sticky` 模式分别识别 Codex 的 parent thread / `prompt_cache_key` / session/thread 字段，以及 Claude Code 的 parent-agent / session / agent 字段；parent/root 优先于 child/agent。直接 Chat 请求若已有合法 `prompt_cache_key` 或 `session_id` 会原样保留；若只收到 Codex/Claude 显式会话 Header/metadata，则派生域分离、不可反推原值的 `prompt_cache_key` 发给 Cline。无显式会话时仍只对首个 system/developer 与首个 user 消息做本机 HMAC 账号路由，但不会把该 fallback 冒充成显式上游 key。原始会话、派生 key、HMAC 指纹和消息不会进入普通日志/metadata。客户端真实提供的协议 Header 仍按允许列表透传；`Authorization`、`Proxy-Authorization`、Cookie、逐跳 Header、Installation ID 和 Attestation 始终剔除，也不会伪造 User-Agent、设备、浏览器或 TLS 指纹。NewAPI 若在到达 Switcher 前已丢失会话字段，本服务无法恢复原值，会如实显示 `message_hmac` 回退。

`errorRules` 按数组顺序首条命中（包括 `ignore`）。`statuses` 内部 OR，`body_contains` 字符串数组为 ANY；Provider/model 范围、状态、正文和 Header 条件之间为 AND，均使用大小写不敏感普通文本而非正则。命中 `degrade`/`cooldown`/`hard-quarantine` 会为对应维度记录一个失败样本并（后两者）保持临时/持续处置，`ignore` 不写样本也不处置。无显式命中时，明确账号认证/额度/代理错误只记录账号 `degrade`，明确具名 Provider 的 429/5xx/网络/超时/不可用只记录该模型×Provider 的 `degrade`，不自动冷却。账号 cooldown/hard-quarantine 可在首包前最多换号一次；Provider 动作只影响当前 Provider；首包后只更新未来状态，不重放当前请求。账号通过现有恢复按钮清理状态，Provider 通过控制台恢复按钮或认证的 `POST /api/providers/recover` 精确恢复 `{ model, provider }`。

`retryRules` 是独立的请求级停止条件：`statuses` 与 `body_contains` 同时命中即立即停止本请求全部剩余 Provider 与账号替换，并保留原始最终状态/正文；无命中则保持现有继续重试行为。它不隐式修改健康状态，只有同时存在的 `errorRules` 才决定样本与处置。控制台的“无效 system 消息停止重试”是手动预设：预览确认后同时加入 `retryRules: stop` 与同条件的 provider-model `ignore`，从而对确定性请求错误只发送一个真实 attempt、不换号、不降低渠道成功率；预设默认不启用，也不会在启动迁移中自动写入。

调度固定先执行禁用、账号冷却、硬隔离和 reserve 等资格过滤。只有 success-rate 时，每次请求按 `success / (success + degrade)` 降序，有数据优先、无数据置后；只有 sticky 时继续使用无状态 HRW。sticky 与 healthSort 同时生效时，sticky 变为“已有会话绑定命中门”：hit 直接使用绑定账号，miss 才按 `order` 中 quotaPool/healthSort 的相对顺序处理当前活跃候选，并用 HRW 做同层稳定 tie-break。成功率变化不会迁移已有绑定。

`cachePoolSize > 0` 仅在 sticky 模式或显式启用会话粘性步骤时生效；它是初始/最小大小，`cachePoolMaxSize` 是扩容上限。`cachePoolLowQuotaSize` 默认 0（沿用原有非 reserve、priority/稳定 ID 成员和选择）；正数时固定低额度槽（fresh 完整快照已用 80%–<95%）先于高额度槽（<80%）承载请求，reserve（≥95%）排除，未知最后补位。低额度按剩余升序、高额度按剩余降序，再按 priority/稳定 ID 派生；实际 high/low/unknown 数量单独显示，不持久化成员 ID。动态扩容只增加高额度目标；低额度并发/RPM 不可用时立即尝试高额度。只有全部活跃账号都设置了有限 `maxConcurrent` 且满载、RPM 仍可用，等待 `concurrencyWaitMs` 后重算仍满载，target 才同步 grow-one 并持久化到 `metadata.json`；多个并发超时不会越过 max，压力下降不自动缩容，`max=min` 可关闭自动扩容。低额度账号最终 account/degrade 会进入独立 waiting-refresh，首包前最多换号一次；真实额度刷新成功才可恢复，任一已知窗口 100%（含部分快照）进入 quota-exhausted，到有效 reset 后重新刷新，失败/未知不会清除；人工恢复仅清错误规则状态。刷新沿用两槽队列与失败退避。备用账号必须先正式晋升为 active 才能承载请求或建立绑定；无合格成员/达到 max 时返回容量错误，unlimited 活跃账号不会触发增长。

账号级 **RPM 限流**（`maxRpm`）与 `maxConcurrent` 共存，准入顺序固定为硬资格 → `maxConcurrent` → RPM：并发已满时不会预留或消耗 RPM（失败诊断可能读取窗口以区分混合阻塞）。账号 `lease` 在准入时原子预留第一个 RPM permit，只有真正把请求交给 Node transport（`req.end()`）才提交为窗口内事实；发送前的同步失败或未发出会立即退还预留并唤醒等待者，发送后的 DNS/连接/代理/TLS/成功/错误/超时/取消都不退款。同一账号内的 Provider retry 每次独立预留；无 permit 时不等待、不发请求、不换号，直接返回本地 429 + 精确 `Retry-After`，此前真实失败 attempt 的原始 upstream 状态与错误行仍保留，请求行以 `errorCategory: "rpm"` 记录本地限流而不是伪造 upstream 429。初始选择会跳过“有并发但 RPM 耗尽”的候选，全部不可用时 `Retry-After` 来自最早滚动窗口恢复时间；等待复用现有容量 waiter 与 `concurrencyWaitMs` 上限，不新增 refill 定时器或队列。RPM 阻塞（含混合阻塞）不会触发缓存池动态扩容，只有全部活跃候选都有限并发满载且 RPM 仍有容量时才允许既有的 grow-one。删除账号或替换 Key/代理会清理该账号窗口，普通 disable/re-enable 不会绕过窗口内已提交事实，`maxRpm: 0` 立即关闭限制并清理无用状态。`GET /api/accounts` 只投影 `rpm: { limit, used, reserved, retryAt }` 这样的安全数值，普通日志只投影 `blockedBy` 枚举与有界 `retryAfter`。

组合模式的 session binding 只存在内存，复用已有 HMAC fingerprint：显式 Codex/Claude/session 身份使用 2 小时滑动 TTL，`message_hmac` 使用 15 分钟，默认最多 50,000 条并按 LRU 淘汰，重启即清空。首次 miss 在取得 lease 后建立 provisional binding，真实 native attempt 提交后确认；同会话并发可命中 provisional。绑定账号满载时先等待，再临时使用其他 active，但不会改绑。删除/禁用、Key/代理变化、账号 cooldown/hard-quarantine、退出 active 或进入 reserve 会失效并重新选择；Provider 失败、普通失败、成功率或 hot/warm/unknown 变化不改绑。管理 API/普通日志仅显示安全计数及 `bindingSource`/`bindingResult` 枚举，不输出 session、fingerprint、候选表或绑定明细。

额度通过账号 Bearer 后台读取半公开的 `GET /users/me/plan/usage-limits`，15 分钟后过期；失败、缺窗或接口变化均归为未知并回退普通调度，聊天请求不会等待额度刷新。统计页另行做**社区参考估算，非真实账单/官方承诺**：参考上限来自社区实测截图（每账号 5 小时约 $10、每周约 $25、每月约 $50），当前整池同档 Cline Pass 订阅的适用性由操作员确认，而非额度 API。各窗参考剩余 = 对应上限 × (1 − percentUsed/100)；当月剩余合计只加月窗，当前可用合计先逐账号取三窗各自美元参考剩余的最小值再求和，绝不能取百分比最小值乘 $50。两种合计独立计数：启用账号若最近成功快照在 15 分钟内且月窗有效即可计入月汇总，三窗均有效才计入当前可用；失败、过期、缺失、未配置不视为 0，已知 0 保留。四个预测时点（当前、+2h、+8h、+24h）只在有效重置时间晚于统计生成时间且不晚于目标时恢复相应窗口上限，其他情况保守沿用；未来假设没有新增消耗，缺失重置时注明预测下限和覆盖。统计显示生成/获取时间、两套纳入/排除/未知账号数；单账号百分比、重置时间、路由状态仍分别展示。若将来混入不同订阅档位，必须先重新评审整池适用性与参考上限，不能将估值冒充官方余额。账号成功率按请求/账号去重，模型×Provider 按每个具名真实 attempt 记录；无样本为 null，冷却、硬隔离和禁用作为独立状态展示。

统计只接收客户端聊天的最终真实 `usage`：非流式取最终响应，流式只取最后一个累计 usage 快照，供应商重试不累加，换号后的 token 只归最终响应账号。缓存 Token 占比使用明确同时返回 cache/input 的配对数据，命中请求率只以明确返回 cache 字段的请求为分母；模型统计按别名解析后的实际模型聚合，模型表只展示 24 小时缓存 Token 占比和配对样本数。统计另聚合显式/回退亲和请求、Provider fallback、Provider cooldown 与 half-open 请求数。管理测试、探测、渠道校验、模型抓取和额度刷新不进入聊天统计。动态统计保存在 `metadata.json` 的版本化、1440 分钟/50,000 账号分钟/50,000 模型分钟结构中，迁移后的模型与路由指标窗口在覆盖满 24 小时前会明确标注“统计积累中”；旧名称统计只作为可能含控制台测试的独立基线展示。首期不提供 RPM、统计重置、7 天趋势、出口 IP 或指纹伪装。

### 日志、代理和安全边界

认证管理 API `GET /api/statistics` 返回累计、最近 24 小时、按实际模型聚合的滚动缓存统计、当前账号健康与严格投影的额度信息，不返回分钟桶、密钥、代理、Header、消息、会话或原始额度响应。

请求与错误日志分别写入 `DATA_DIR/logs/requests-*.jsonl` 和 `errors-*.jsonl`。默认保留 30 天、请求 50,000 条、错误 10,000 条，两类合计不超过 100 MiB；服务先监听再后台恢复既有日志，恢复期间模型流量和新日志不受影响，查询会暂时返回安全的 `503` 而不会展示部分历史。查询 API 为 `GET /api/logs/{requests|errors}`（`limit` 1～200、`cursor` 游标和字段筛选），对应 `DELETE` 只清空指定类型。每个代理请求返回 `X-Cline-Request-Id`。逐次日志记录受控的 `errorScope / scopeEvidence / failureClass / healthAction / retryAfterMs / responseContentType / responseBytes`，不会保存原始响应正文。

账号代理支持 `http://`、`https://`、`socks5://`、`socks5h://` 和可选 URL 用户名/密码，只应用于该账号的 Cline 请求；代理失败进入网络/代理错误记录，并且不会回退直连。账号 Header 在客户端协议白名单之后合并，随后由系统强制覆盖 `Content-Type` 和账号 `Authorization`。Authorization、Cookie、逐跳 Header、会话/线程/设备身份及凭据类 Header 均禁止配置。

普通请求日志会保存亲和键类型/置信度、caller/派生上游 key 的安全来源枚举、`provider.order` 是否覆盖 sticky、以及依据最终明确 usage 得出的缓存三态（命中/明确未命中/未知）；Provider cooldown/half-open 动作只作为 bounded attempt 枚举。Provider 选择策略同样只投影有界枚举：`providerPlanSource` 为 `configured`/`discovered`/`auto`（候选来源），`providerMode` 为 `strict`/`preferred`，每次真实 attempt 的 `providerSelection` 为 `strict-first`/`health`/`compat-auto`（`compat-auto` 只属于完全无具名候选的那一次不归因请求）；候选成功率数值、候选表与真实网关顺序不会被记录。请求级重试证据只投影 `retryRuleId`/`retryDecision`（`stop`/`continue`）/`retryMatchedBy`（`status`/`body`），不记录 needle 或匹配片段。它不保存实际 prompt/session/thread key、派生 key、HMAC 指纹、账号 Key、代理 URL/认证值、Header 值、备注、消息正文或敏感上游正文。旧日志缺少字段时显示未知，绝不迁移或猜测。

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
- 认证的 `GET /api/logs/settings` 与 `GET /api/logs/details` 在 `health` 中提供 `dropped` 和固定 `dropReasons` 分项（捕获预算、脱敏秘密/扫描/输出、活动/调用数、发布队列、过期/代际、开放详情关联、大小/存储准入等）。每次诊断省略或发布拒绝只计一个主因；同一详情多份正文受限只计一次；分项之和等于 `dropped`。它们是**本进程启动以来**的聚合事件数，重启归零，不追溯旧记录，也不等于失败模型请求数或缺失详情根数。普通 5 MiB 截断不计丢弃；`failures`/`corrupt` 独立。页面仅显示非零原因，旧服务缺字段时标为原因暂不可用。
- SIGTERM/SIGINT 会先停止新接入和额度调度，等待活动请求 finalizer 写入，再有界 drain 普通/详细 store；达到期限后才强制关闭连接，永久阻塞的日志 writer 不会无限拖住退出。

管理 API（独立管理员 Cookie 会话，返回 `Cache-Control: no-store`）：`GET/POST /api/logs/settings`，POST 接受由 `detailedLogging` / `errorDetailLogging` 组成的非空布尔字段子集，旧的单字段请求仍兼容；`GET/DELETE /api/logs/details`；`GET /api/logs/details/<requestId>`；`GET /api/logs/details/<requestId>/bodies/<bodyId>`（脱敏 `text/plain`，`nosniff`）。列表支持 `limit` 1–200、`cursor`、`requestId`、`from`/`to` 毫秒时间戳、`model`、`account`、`status`、`result`；错误参数返回 400，过期/已清空/缺失正文返回安全 404。

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
