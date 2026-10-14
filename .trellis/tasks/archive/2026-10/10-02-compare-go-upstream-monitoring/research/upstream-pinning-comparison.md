# 上游渠道/账号「盯住」对照（只读研究）

## 范围与证据

- Go：[`Hxjcc/cline-pass-switcher-go@feb3fa342260a89d58268a2e3de257587b284f1b`](https://github.com/Hxjcc/cline-pass-switcher-go/tree/feb3fa342260a89d58268a2e3de257587b284f1b)，以该提交的源码为准；下文 `Go:internal/...:L` 均可改写为 `https://github.com/Hxjcc/cline-pass-switcher-go/blob/feb3fa342260a89d58268a2e3de257587b284f1b/internal/...#L`。可复用链接写在结尾。
- 当前 Node：本地 `7a26d7465c7092394a88e9855bf4dfd642f9ed7b`，关键点 `server.js`、`lib/account-workflow.js`、`test/integration.test.js` 和 `.trellis/spec/backend/{quality-guidelines,error-handling}.md`。未读取运行中的 `config.json`、`metadata.json`、`data/`，未访问真实上游，不能断言生产的具体失败比例/配置。
- 来源仓库的网页浏览器不可用（agent-browser 二进制缺失），使用 `fetch_content` 抓取固定源码副本，只读检查。主机 Go 1.24.4，Go `go.mod` 要求 1.25，因此未运行 Go 测试；本次不改业务代码，不以测试通过作为结果。

## 术语先拆开

1. **账号粘性**：同会话下一轮落回同一 API Key 的账号；不是渠道钉住。
2. **渠道请求钉住**：发出 `providerOptions.gateway.only:[slug]`（planner）或 `provider.only:[slug]`（direct）；上游可能忽略，发送了字段不等于生效。
3. **实际渠道命中**：回包可信路由元数据 `finalProvider` / `provider` 与该次计划 `slug` 经规范化后相等；元数据缺失是 **unknown**，而非命中或未命中。
4. **请求成功**：完整的 HTTP/非流或 SSE 完成；首 token/首 data 成功不一定代表整个流成功。渠道命中率、成功率、提示缓存命中率分别统计，不可互相代替。

## 一次请求的两套流程

Go：`httpapi/server.go:709-765` 使用 model+`prompt_cache_key` 查内存上次成功账号和**预设尝试渠道**，前置重排配置渠道；外循环每个渠道，内循环至多四个账号（`server.go:807-841`），401/403/429 给账号冷却后可能选另一个；5xx/网络/超时尝试下一渠道；全局最多 16 次。自动路由 429 在换号后不再重复渠道（`server.go:784-842`）。`upstream/service.go:666-705,753-803` 用模型探测结果决定是否发 `only`，失败轮换。流式同样按渠道×账号，首事件前可重试，输出后不得重放（`httpapi/stream.go:26-111`）。

Node：`server.js:4678-4787` **先选账号并取得 lease**，按该账号自己的 `perModel[model]`（存在即完整覆盖全局）生成稳定候选快照 `server.js:4324-4330,4059-4106`，逐个尝试具名渠道（上限 `maxRetries+1`，缺省走完）且不在渠道失败时换账号 `server.js:4499-4671`。只有明确账号冷却/硬隔离或已知/待核验配额保护等动作，且尚未输出 SSE，才最多替换一次账号，重新按新账号自身路由计划执行（`server.js:4768-4794`）。取消/输出后不重放；`retryRules` 独立决定是否提前 stop（`server.js:4381-4458`）。

## 逐项比较

| 维度 | Go 版 | 当前 Node | 取舍/对命中率的意义 |
|---|---|---|---|
| 账号候选与归属 | single/roundrobin，带 key、enabled；绑定分发 key 时只用指定账号；cooldown/配额满候选暂避，但所有账户排除时仍取一个发送（`upstream/accounts.go:113-164,179-260`; `store/store.go:179-225`） | legacy 六种模式＋可选 pipeline/cache pool/workflow；账号属主隔离、`maxConcurrent`/`maxRpm` lease、配额保护和规则硬状态；单账号模式不会因满额而无条件跨账号（`server.js:67-89,1555-1650,2292-2301`；backend quality guide） | Go 的「所有暂不可用仍试一个」提高尝试覆盖但可能白白消耗已满额度；Node 的硬约束更强。不能直接移植。 |
| 同会话账号 | 仅 `model + prompt_cache_key`，**成功后**记 `(accountID, attempted upstream, keyHash, expiry)`；默认可配置 60m，5m sweep，key 变更或 401/403 清除，进程重启消失（`upstream/sticky.go:14-35,78-188`; `docs/configuration.md:68`） | 身份可来自 Codex/Claude 父线程/会话或通用字段，再回退首条 system/user 消息 HMAC；按 client-key owner 隔离。legacy sticky 为 HRW 确定性映射，不记成功账号；开启 sticky+healthSort/workflow 等条件后可用有上限的内存 binding，先 provisional，在真实发送时确认；显式 2h、fallback 15m，可失效/溢出（`server.js:3317-3378,1330-1447,1616-1635,1657-1661,4678-4714`; `lib/account-workflow.js:8-14`） | Go 适合轮询但要同会话复用成功账号；Node 已具备条件化绑定，不应新建第二张表。HRW 与「成功后粘住」语义不同，要看正在运行的配置，不能只看默认值。 |
| 同会话渠道 | 只有配置候选列表包含上次**attempt.Upstream**且不少于两个，才移动到第一位（`upstream/sticky.go:185-207`; `httpapi/server.go:715-719`）；自动路由无效；成功记的是计划渠道，**不是从回包校验过的实际渠道**（`upstream/service.go:840-847,1023-1035`） | 未存会话→渠道绑定；`strict` 第一次依来源顺序，其后按 Provider-model 24h 直接成功率；`preferred` 首次即按健康率排序。配置列表优先于探测列表，unknown 不伪造成零（`server.js:4059-4131`）。请求体原生/派生 `prompt_cache_key` 可以让上游自己实现缓存亲和，但固定 singleton `only` 或配置排序可能与远端 sticky 冲突，日志仅标记 override（`server.js:3363-3382,4714-4771`） | **这是可考虑移植的主要缺口**：基于实际成功渠道做候选首位倾向；不能将 Go 的计划渠道当实际成功渠道，也不能在未知/忽略 pin 的模型上记。 |
| 渠道参数 | `BuildAttempts` 用 `perModel.upstreams/exclude`，无配置或不支持 pin 走 auto；具体管道发对应 `only`，未知管道两种都试；排除变成 allow-list，无法确定渠道清单或全部排除时 400（`upstream/service.go:658-803`） | 每次具名渠道精确 singleton `only`，消掉传入 `order`，未知管道双写；静态 exclude、持久 cooldown/hard quarantine 先过滤，全排除/全冷却安全 503，无候选仅一次 auto（`server.js:4033-4110,4499-4523`） | 都是外部一次一个、不是 `order` 列表交给上游；不能把 preferred 误解为「上游自己选较好渠道」。 |
| 真正可钉性 | Go `ProbeModel` 正常请求＋不可能渠道 slug 的负对照；如果路由拒绝证明支持，返回成功意味着忽略，`pinnable=false` 则 `AutoRoute()` 压成一次无 pin 尝试，并清除旧绿板；受限探测不能把单 provider 误作唯一渠道（`upstream/service.go:111-264,658-670`; `upstream/probe_pin_test.go:76-114`; `upstream/catalog_test.go:110-169`） | Node 探测先无 pin 请求，另用 `__probe__` 收集 available providers；`pinnable=!!pipeline`，并**未负对照验证字段是否被接受或被忽略**（`server.js:2574-2645,2687-2712`）；validation 单渠道 16-token 请求分类但未证明 `actualProvider==requested`（`server.js:2726-2785`） | **最大可借鉴点**：能力判定应是 supported/ignored/unknown 三态，并用明确路由拒绝/实际观测佐证；否则界面可能显示可钉，实际请求被忽略。Go 的 probe 失败也常标成 `pinnable=false`→auto，不能照搬；Go 测试结果不是 Node 生产事实。 |
| 归一化及实际证据 | `RoutingFor` 解析 planner `provider_metadata.gateway.routing.finalProvider` 或 direct 顶层 `provider`，direct display name 用字母数字折叠匹配已探测 slug/endpoint name（`upstream/helpers.go:497-608`）；JSON 响应头目标/实际分开（`httpapi/server.go:893-908`） | `parseRouting` 同样解析两路，但 direct 只将空白换 `-`，没有 Go 的标点与已知 slug 同义映射（`server.js:2551-2572`）；响应头目标/实际分开，stream 的实际 provider 写终态日志而非首包 header（`server.js:4869-4976`） | 对 direct 的 `Z.AI`/`z-ai`、`AtlasCloud`/`atlas-cloud` 可能造成**统计的假失配**。规范化只能改善识别，不能修复真正路由失败；同名映射须避免碰撞。 |
| 401/403/429 | Go 401/403 账号冷却 10m、429 冷却 2m；429 无条件按账号看，失效 quota snapshot；同渠道先换号，最多 4 号/16 总次（`upstream/accounts.go:18-42,261-320`; `httpapi/server.go:724-842`） | Node 401/403 明确账号，429 仅新鲜 100% 配额或结构化账号额度证据才归账号；有具名 provider 则归 provider，HTML/不明 429 unknown；默认 degrade/ignore 不自动冷却，规则可 cooldown/quarantine；仅明确移除动作允许一次跨账号（`server.js:4285-4310,4381-4458,4758-4794`） | Go 换号可挽救真实账号限流；遇全局/Provider 429 却会误惩罚健康账号。Node 对含糊 429 不换号是保守取舍；先看失败归因分布，再考虑显式、上限一跳的例外。 |
| 5xx/网络/超时 | Go 换下个渠道，下一轮重新选账号，可能恰巧也换号；状态分类 `LearnFailure` 更新元数据（`server.go:724-778`; `service.go:1037-1062`） | Node 同租约换渠道，路由健康/规则与短时 per-account circuit 分离；`providerCooldownMs>0` 才有 half-open，一次一 owner（`server.js:4107-4188,4285-4310,4499-4671`） | 当前没有按失败自动跨账号并不等于缺陷，是账号粘性与避免错花预算的设计。对账号级代理故障已有分类，但是否触发换号由规则决定。 |
| 配额与容量 | Go 请求路径计划/用量两 GET，60s 结果，4s 单探测、总 6s/8 账号；失败 fail-open，满窗口跳到 reset（无 reset 5m），全满仍发（`upstream/quota.go:20-51,160-207,363-451`; `accounts.go:208-260`） | Node 异步全局两槽、每号去重、15s 绝对期限；严格完整快照 15m 才用于路由，未知不是 0；角色池可按热/温/保留、健康过滤；本地 60s RPM 与并发上限阻塞并给 Retry-After（`server.js:1659-1684,2092-2245,4499-4532`; quality guide） | Go 的同步查询可能让首字延迟更坏；Node 高并发保守入场，成功率需分清「本地准入率」和「已发给上游后的成功率」。 |
| 流/超时 | Go 首 data 180s、静默 300s、非流 600s，32KiB 头、10s ping，首 data 错误可重试（`upstream/service.go:914-1035`; `docs/routing.md:128-153`） | Node 首完整 data 120s 绝对、静默 360s、非流 120s，64KiB 前缀、25s ping，首事件错误可重试，post-start 不重放（`server.js:3390-3400,4509-4627,4828-4937`） | 若「成功率低」主要是超时/长推理，不能把它误判为钉住失败；Go 放宽时限可能降低超时，但会拉长失败等待、资源占用，先用分位数测量。 |
| 可观测/协议 | Go 支持 `/v1/responses`→Chat 适配和同会话 key 透传（`internal/responses/bridge.go:550-551`）；历史含原样 `prompt_cache_key`（`httpapi/record.go:27-51`, `server.go:874`） | Node `/v1/responses` 明确 501；会话只作 HMAC+安全来源投影，模型/账号/渠道/错误/缓存覆盖在独立日志和统计中；不记录明文 session（`server.js:4678-4714`, quality guide） | 若实际客户端发 Responses，Node 失败与钉住无关。不能照搬 Go 的明文会话历史，违反本项目安全契约。 |

## 重要文档/实现落差及 Go 版自己的盲点

- Go `docs/routing.md` 称会话 30 分钟；实际 `sticky.go:14-35`、`model/types.go:341-342` 和 `docs/configuration.md:68` 是 **默认 60 分钟，可配置**。
- Go 文档说「上次成功的渠道」，实际 `observeStick(... attempt.Upstream, 200)` 记计划尝试渠道，即使实际 provider 不同也会粘错；auto 记空，无法跨轮次准确钉实际渠道。
- Go `probeRoutingPreference` 对不符合路由拒绝的其他错误也归入 `ignored`，`ProbeModel` 对 `probeErr`/单候选等设 `pinnable=false`；`AutoRoute` 无条件把此模型化作单一无 pin 尝试。负对照需要三态与复查/时效，不能把一次网络/账号错误当成永久证明。
- Go validation 在 `hasChoices(root)` 时标 `ok`，不比较实际 Provider。只有能力探测仍然可信且没有漂移时这个绿板才有意义。
- Go `PickAccountExcluding` 所有可用账号暂时被排除时再选一个，故上游连续 429/配额全满仍可产生一次调用；并不保证提高最终成功率。冷却也只在进程内。
- Go 对 `prompt_cache_key` 有模型前缀但没有 Node 的客户端所有者命名空间和敏感值保护；跨客户端键碰撞与日志隐私不能照搬。
- Node `pinnable=!!pipeline` 是「识别出管道」，**不是**「上游认可这个模型的 only」；没有实时对照实际命中进行降级/复探。`probeModel` 的正常探测与生产带 pin 请求也不一致，可能让「最近命中」不是受限请求的代表。
- Node `strict` 第一候选始终配置/探测顺序，缺少成功会话渠道首位；`preferred` 按全局 24h 健康率而非同一会话实际 Provider，收益目标不同。`pinMode` 的两种模式都注入 `only:[one]`，只是选择顺序不同。

## 对当前「成功率低」的解释：代码事实 ≠ 生产归因

**代码上可以肯定**：当前没有显式验证 pin 支持；对 unsupported/ignored 模型可发送只含单渠道的请求；未将本会话实际成功渠道作为下次首选；direct 名称可能未归一；对模糊 429 不换号；首事件/非流 120s，Responses 501。这些都**可能**导致某类请求失败/命中率低，不能据此断言当前生产就是其中之一。

**需先分母分层**（不读取敏感原始数据）：
- `eligible=request`：已认证有效且账号可选；单独计 local 401/429/503、`blockedBy=rpm|concurrency|mixed`、规则过滤；这些不是上游 pin 失败。
- `attempted=named`：有实际 HTTP attempt 且指定 `only`，在已知 `pinnable` 能力/未知能力中分组；`target` 不可替代 `actual`。
- `observed`：回包提供实际 Provider 才进入渠道命中率分母。计算 `observed_match / observed_named`，再列 `observed_unknown / named_success`，失败请求不一定有 Provider；把 response 200 但实际不同单列，不用它当 HTTP 失败。
- `final_success`：终态 success / (success + failed)，取消独立，分模型/管道/账号归属/渠道/客户端协议、是否有亲和 key、binding hit/miss/overflow、`pinMode`、retry count、error classification、首事件和非流超时；缓存命中率只在有明确 cache usage 的请求中计算。样本量、小样本置信区间及覆盖缺口必须显示。
- 先看本地已有 request/error logs 的安全投影与 `/api/statistics` 的覆盖，不把会话 key/指纹/Header/原始请求体导出。若现有字段不足以关联每次 named attempt 的 actual，未来只加**匿名、有限、明确证据来源**的对照事实，不记原始会话。

## 借鉴顺序（这里只建议，不实施）

**P0：定位与低风险验证。** 在本地 mock 复现 planner 支持/忽略 `only`、direct 支持/忽略、负探测 400/404/200/超时/账号 401、顶层 200 错误、标点别名、SSE 第一事件/后续错误；确认路由 `target`、`actual`、final result 各自独立。对现有历史安全聚合，回答是哪类失败占比最大；不跑上游昂贵探测。

**P1：Go 最值得吸收的能力识别，不抄结论。** 在现有 `probeModel`/metadata owner 内，用**正常请求 + 不可能但合法 slug 的负对照**确认模型/管道当前是否尊重 `only`。结果至少 `supported/ignored/unknown`，带证据时间、探测账号/管道和有效期；路由错误才算 supported，返回成功且有实际 Provider 可判 ignored；超时、认证、配额、未知报错保持 unknown；探测已携带配置 pin 时不能据受限单候选误判模型只有一条。对明确 ignored 的模型不要徒增重复假 pin 尝试；**若用户要求 strict pin 或 exclude，绝不静默 auto 绕过禁用/排除语义**，应明确告警/拒绝或由用户另选显式「容许自动路由」策略后只试一次；unknown 保留 operator 配置并提示复探。更新 metadata/测试/UI/spec 是跨层改动，后续另开实施任务。

**P2：实际命中归一和偏好记忆。** 复用现有 account/session binding owner，只有完整成功且回包可确定 actual、该 actual 在当前允许候选中、pin 能力已确认时，考虑记录 `(owner, session-fingerprint, resolved-model, account, actual-provider, generation, TTL)`；对 401/403、禁用/轮换、候选修改、失败/冷却清理或不再优先。不能新建平行 store；会话的 provider 可作为候选**优先级**而非硬钉，失败便转健康率回退。严格区分 first-event 与流最终成功；跨账号替换后是否继承 Provider 需先明确产品语义。若采用 Go 的方式只记录 attempt.Upstream，虚高的命中会恶化成功率。

**P3：有证据的失败分流。** 保持账号预选与租约/所有权，先精细验证 429 的来源；只有可靠账号级证据才允许现有一次预流替换，不能把所有 429 都账号冷却。对响应格式不稳定的上游，探索有成本上限的局部 fallback；默认不扩大 16 次那种乘法重试，绑定分发 key 永不跨号。若失败主体是超时，独立基准测 Go 180s/300s/600s 对延迟、取消与资源的影响，不全局直接延长。

**可否拿来用？** 可以**选择性**借鉴「负对照检测钉住能力」「成功后渠道优先」「实际渠道规范化」；账号跨号重试、所有冷却都尝试、明文 Session 日志、探测失败直接关闭 pin 等不能原样复制。本研究没做生产 A/B，更不能承诺提升 x%。

## 验证/回退建议

1. 本地临时 `DATA_DIR`＋mock Cline：用同账号、同模型、同 `prompt_cache_key` 顺序发送 A 失败 B 成功、下一轮 B 首选；换 key / 禁用 / 过期 / 账号替换 / 配置更新 / bound key / 匿名流 / SSE 中途失败各自维持正确边界。
2. 负对照支持/忽略/暂未知、planner/direct/未知 pipeline、网络超时、模型单渠道、目标和 actual 不一致、多个等价 slug。真上游探测是收费的，未经单独同意不执行。
3. 只读基线若可能：与旧版并列报告终态成功率、可观察渠道命中率（带 `unknown` 覆盖）、首 token P50/P95、总延迟、平均真实 attempt、429 来源、账号/Provider 被错隔离计数、缓存命中 coverage；按模型和 client owner 分层，避免混合/选择偏差。灰度可关闭新判定/优先级，保留现有旧行为并观察回退。
4. 代码/配置更改必须单独授权；本任务不实施、不部署、不读生产凭据。

## 源码链接（固定提交）

- Go 粘性：[`sticky.go#L78-L207`](https://github.com/Hxjcc/cline-pass-switcher-go/blob/feb3fa342260a89d58268a2e3de257587b284f1b/internal/upstream/sticky.go#L78-L207)
- Go 探测与路线构建：[`service.go#L111-L264`](https://github.com/Hxjcc/cline-pass-switcher-go/blob/feb3fa342260a89d58268a2e3de257587b284f1b/internal/upstream/service.go#L111-L264)、[`service.go#L658-L803`](https://github.com/Hxjcc/cline-pass-switcher-go/blob/feb3fa342260a89d58268a2e3de257587b284f1b/internal/upstream/service.go#L658-L803)
- Go 重试：[`server.go#L709-L842`](https://github.com/Hxjcc/cline-pass-switcher-go/blob/feb3fa342260a89d58268a2e3de257587b284f1b/internal/httpapi/server.go#L709-L842)、[`accounts.go#L128-L320`](https://github.com/Hxjcc/cline-pass-switcher-go/blob/feb3fa342260a89d58268a2e3de257587b284f1b/internal/upstream/accounts.go#L128-L320)
- Go 格式规范化：[`helpers.go#L497-L608`](https://github.com/Hxjcc/cline-pass-switcher-go/blob/feb3fa342260a89d58268a2e3de257587b284f1b/internal/upstream/helpers.go#L497-L608)
- Go 探测测试：[`probe_pin_test.go#L76-L114`](https://github.com/Hxjcc/cline-pass-switcher-go/blob/feb3fa342260a89d58268a2e3de257587b284f1b/internal/upstream/probe_pin_test.go#L76-L114)、[`catalog_test.go#L110-L169`](https://github.com/Hxjcc/cline-pass-switcher-go/blob/feb3fa342260a89d58268a2e3de257587b284f1b/internal/upstream/catalog_test.go#L110-L169)
- Node 关键点：`server.js:2551-2785,3317-3382,4033-4188,4285-4310,4499-4976`、`test/integration.test.js:3325-3472`、`.trellis/spec/backend/quality-guidelines.md:1-290`。
