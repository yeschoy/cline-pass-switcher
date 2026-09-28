# 本地契约复核（仅源码、历史记录和本地 mock 测试）

## 范围与证据边界

本记录不含生产实时观测；未访问生产、外部站点、私有配置/数据、普通或详细生产日志。截图事实仅据本任务 `prd.md` 已记述的用户截图，不是本地重新读取原图：第一张 2026-09-28 17:12:30（界面本地时区未知）为 `200 / success`，sticky / cache-pool-active、回退绑定命中、缓存命中，显示 15 个候选；第二张标出两个**不同**对话，上框缓存 Token 明显较低，其中同时间一行约 128 Token。其余各行的精确数值、时间、模型与关联 ID 均未在本地证据中给出，不做逐行猜测。

## 提交与版本（已验证：本地 git；生产仍未知）

- `git merge-base --is-ancestor 378ff1f a17eef6` 返回 0，`git rev-list --count 378ff1f..a17eef6` 为 9；`git diff --exit-code 378ff1f a17eef6 -- server.js public/index.html lib test` 为 0，且 `a17eef6..本地 HEAD` 的这批业务路径差异也为 0。**纠正 PRD 的时间表述：`378ff1f` 并不是 `a17eef6` 之后的本地业务代码；它在后者祖先链中。**这只证明提交包含关系，不证明生产仍运行该代码。
- `git show 378ff1f -- server.js public/index.html`：加入可选 `load-health`（与 pipeline sticky 不兼容）、`poolFullWaitMs`（全池纯并发满才使用，否则沿用普通等待）、非粘性账号负载/健康选择和错误链 UI；对该提交的 server.js hunk 检查未见 `normalizeUsage`、`addUsage`、`buildProviderPlan`、`runChatChain` 或 `cacheHitOf` 改动。不能仅凭该提交名或截图认定缓存计算改变，也不能排除经配置/上游改变后的间接路由影响。
- 已归档的 `.trellis/tasks/archive/2026-09/09-17-deploy-cache-pool-validation/research/version-boundary-20260927-load-health-code.md` 称当时发布 `a17eef6`，容器于 2026-09-27 20:32:00.427603 UTC 启动，sticky、池最小 5、普通等待 1000 ms、未启用 `load-health`。这是**上次报告的时间界线**，非当前镜像、重启或配置的证据；本地没有验证生产 release/image、启动时间、池目标/最大值、账号/模型 override 与此后改动时间。上述观察后的新发布/策略边界须由主会话只读核实。

## 计划、真实尝试、亲和是三种不同事实

- `public/index.html:1784-1800` 中请求表的「供应商路径」优先用 `targetProviders.join(' → ')`，没有把 `attempts` 显示成路径。`server.js:3794-3860` 的计划来自该账号该模型的配置优先/发现次之，筛除 exclude、隔离与冷却；`maxRetries` 可进一步限制尝试，严格首试按来源顺序、后续及 preferred 按可用 Provider 的健康序；单次具名调用注入 singleton `only`（`server.js:3744-3820,3838-3865`）。
- `server.js:4234-4275,4480-4522,2892-2946` 把当前（若换号则最终）计划投影到 `targetProviders`，把请求实际 trace 投影到 `attempts`；`switched` 由账号路径长度 > 1 生成，`actualProvider` 来自终态上游报告，不是 15 个候选的逐项执行证明。原生 chat `req.end()` 后才分配 attempt token（`server.js:3220-3233`）；trace 是 Switcher 的尝试路径，**不包括网关内部不可见重试**。注意异常边界：`attemptOnce()` 对 `req.end()` 前的同步失败也会返回失败并可能进入 trace（`server.js:3165-3204,4139-4164,4374-4383`），而 token 不会分配；因此 `attempts.length`/`X-Cline-Attempts` 代表本地尝试 trace 的个数，不能无条件宣称每项都已交给 Node/到达远端。响应头 `X-Cline-Target-Upstream` 是计划（`server.js:4523-4529,4668-4675`）。`test/integration.test.js:3336-3353` 用 3 候选、2 次具名尝试的 strict 用例验证不相等；`preferred` 测例也可首试成功只尝试一次。
- **个案结论：截图 15 是候选数，不是 15 次重试。真实尝试数、逐次状态/Provider、最终 Provider/是否换号必须拿该请求 ID 的普通请求行 `attempts`/`switched`/`actualProvider` 或可靠的 `X-Cline-Attempts` 核对 Switcher 尝试；若需严格计数原生 `req.end()`，还需核对 attempt token/可用的调用元数据，不能从 plan 或 trace 强推远端成功接收；本地没有这行，不宣称为 1 次或多次。**同 ID 错误日志只补充失败路径，不是所有成功尝试的账本（`server.js:2949-2967`）。
- 「回退绑定命中」是账号级绑定结果：普通行 `bindingSource` / `bindingResult`；不是缓存 Token 数，也不证明 Provider/远端缓存命中。`upstreamPromptCacheKeySource` / `upstreamPromptCacheKeyApplied` 仅表示本地来源和已发送的有效字段，不能证明远端使用了它；`providerOrderOverridesSticky` 也是路由证据而非远端行为证明（`server.js:2898-2924,4410-4458,4491-4495`；`.trellis/spec/backend/quality-guidelines.md`「Session identity」「Dynamic cache-pool growth」）。

## 缓存口径与两段对话（代码已验证；数值待对应）

- `server.js:2554-2583,4410-4412,4654-4660`：成功终态的明确缓存用量 `cachedTokens > 0` → 请求 `cacheHit=true`；明确 0 → false；缺失/无效 → null（未知，不是 0）。普通请求行只投影 tri-state `cacheHit`，**不保存逐请求 cachedTokens 数值**（`server.js:2892-2930`）；缓存数必须从原计量来源的同一请求安全投影核对。
- `server.js:2827-2829`：`cacheHitRequestRate = cacheHitRequests/cacheKnownRequests`（已知缓存字段为分母）；`cacheTokenRatio = cacheInputCachedTokens/cacheInputTokens`（有明确且有效 input/cache 配对、缓存不超过输入时才有值）。`cacheInputKnownRequests` 是 Token 比例覆盖的配对数；与 `cacheKnownRequests` 不是同一分母。`test/integration.test.js:720-722,1397-1405` 锁定 true/false/null 与两种比例。约 128 Token 若是**对应的**显式缓存用量且 >0，完全可与“缓存命中”并存；它可能只占输入的很小一部分。两个界面的 cached/input Token 计量定义与关联关系尚未确认，不能把约 128 直接当 Switcher 的分子，不能从单行布尔标签推断缓存率或缓存量正常。
- 上框/下框为不同对话，不应把下框大缓存量当上框前次的基线；先在**各自对话内**按时间核对缓存量/输入量变化，再对照同一次 Switcher 请求的模型（含 alias）、流式、匿名账号一致性、最终 Provider、`attempts.length`、`switched`、`bindingResult`、`affinityKeyType`/`affinityConfidence`、上游键 source/applied。只有跨界面 ID（若可得）、本地时区换算、时间和模型唯一匹配时才逐行归因；当前没有逐请求关联或可比 input 分母，不能解释上框“下降”的具体起点或根因。优先核查路由/Provider 或实际输入变化，随后才考虑远端缓存策略；都仍为待证假设。

## 群体趋势与主会话待核（不可用滚动值代替）

`server.js:2709-2772,4954-4956` 的 `/api/statistics.recent24h` 使用持久化分钟桶、窗口为最近 1440 分钟并含当前不完整分钟，不是发布后精确区间。此前归档 `read-only-recheck-20260927.md` 记录的滚动指标混合不同版本/配置，只能作为历史方法线索，**不能与新截图、当前策略直接作前后比较**。本地无可信的前后 UTC 窗口、请求行覆盖/分母或同窗 Token 桶，当前群体命中率、Token 占比与实际多尝试比例均不可判断。

给主会话的只读核对顺序：① 冻结当前运行 image/release、启动及配置/目标变更时间（非私密摘要）；② 第一张的请求 ID 过滤一行普通请求日志（候选数、trace 长度、尝试状态、最终 Provider、换号、绑定/上游键安全枚举）；③ 两段对话各次只对唯一关联行汇总缓存 Token 与可比 input、真实路由；④ 确定版本/配置无间断的等长 UTC 前后窗口，按模型、owner/池、流式、账号分布标记混杂，分别报告总请求、已知缓存/命中/率、未知比例、`attempts.length>1` 的比例及其覆盖；Token 占比须有**同窗且完整**的明确 input/cache 配对聚合，否则标记不可得。普通日志仅保留最多 30 天/50,000 请求/100 MiB 总容量，分页 1–200，缺失不能作零（`.trellis/spec/backend/logging-guidelines.md`）。正式策略验收另需 2 小时预热 + 连续 24 小时 + 至少 1000 明确缓存样本与护栏；若边界或覆盖不齐，结论是“证据不足”，不能归咎某次提交（`.trellis/spec/backend/deployment-guidelines.md`）。

## 本地验证

- `git diff --exit-code 378ff1f a17eef6 -- server.js public/index.html lib test` 与 `git diff --exit-code a17eef6 HEAD -- server.js public/index.html lib test`：均为 0（本地业务路径相同）。
- `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node --test --test-name-pattern='Chat affinity preserves caller keys|all explicit usage aliases|strict first follows source order' test/integration.test.js`：3/3 通过；只用临时 DATA_DIR 和本地 mock，并非生产行为测试。`git diff --check` 为 0；新文件尚未跟踪，以只读逐行尾空格/末尾换行检查确认通过。未运行全量测试或真实浏览器，也未执行生产观测。
