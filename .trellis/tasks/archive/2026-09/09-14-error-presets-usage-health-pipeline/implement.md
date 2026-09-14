# 实施计划

## 0. 开发前基线

- [x] 加载 `trellis-before-dev` 注入 backend/frontend 规范及跨层思考指南。
- [x] 确认工作区除本任务制品外干净，基线包含独立提交 `88a802f`，不得回退其长错误诊断行为。
- [x] 运行 `node --check server.js`、`npm test`、`git diff --check` 记录基线。
- [x] 完整追踪 `normalizeConfigAndMeta → /api/accounts → enabledAccounts/acquireAccountLease → handleChat/runChatChain → streaming finalize/record`，修改共享函数前核对全部调用方。

## 1. 配置、统计和额度状态模型

- [x] 在 `server.js` 增加 `accountPipeline` 默认值、唯一规范化/严格校验函数及四个布尔开关。
- [x] 保证启动缺失字段归一为全 false；`POST /api/accounts` 缺字段保留当前值，显式非法字段 `400` 且不写文件。
- [x] 增加 `META.statistics.version=1` 的严格规范化：最多 1440 个分钟桶、最多 50,000 个账号分钟单元、账号 coverage 缺口、固定 overflowFields/null 规则、整数 penaltyUnits 及账号删除清理；有效 JSON 中损坏的 versioned statistics 在任何保存前明确失败，不静默重置。
- [x] 一次性迁移旧 `META.stats` 到独立标注的 global/account legacyRequests；不合入精确 chat requests，不生成 token/cache/24h/健康数据，重名/未匹配记录摘要，重启不重复迁移。
- [x] 增加 `META.accountQuotas` 严格投影规范化与账号删除、Key/代理变更失效逻辑。
- [x] 更新 `config.example.json` 的全 false 流水线示例。

**验证点**：旧配置启动后行为不变；非法 config 仍失败且原字节不覆盖；迁移重启幂等；metadata 无任何敏感值。

## 2. Usage 提取与 exactly-once 统计

- [x] 实现 `normalizeUsage()`，只接受已确认字段及显式非负整数，区分缺失与 0，不递归扫描或推算 total/cache。
- [x] 实现 Aggregate/HealthDelta 安全加法、`cacheInputCachedTokens` 配对分子、minute bucket/账号单元硬上限与 lifetime/recent24h/coverage 投影。
- [x] 将当前 `record()` 中按账号名累加的旧 `META.stats` 行为移除；诊断写入与业务统计分离。
- [x] 在 `handleChat()` 建立请求级幂等提交闭包，覆盖容量失败、非流式终点及所有流式 flush/error/close 竞争。
- [x] 非流式仅提交最终 `chain.routing.usage`；A→B 只把 usage 归属 B。
- [x] 将流式全量观察缓冲替换为最多 64 KiB 未完成事件的增量 SSE 观察器；先输入 `streamHead` 恰好一次，再观察后续 Transform；最后一个有效 usage 快照生效，原字节不改写并保留背压。
- [x] 明确 `/api/test`、探测、校验、模型抓取和额度刷新不进入业务统计。

**回滚点**：若增量 SSE 观察器影响透传，先恢复字节透传路径，但不得退回无界缓冲或在 chunk/attempt 中累计统计。

## 3. 健康分段与评分

- [x] 从 transport 到 trace/finalize 贯穿 `success/upstream_http/upstream_envelope/proxy/network/timeout/client_disconnect/capacity` 安全 terminalOrigin，再按稳定账号 ID 生成每请求最多一个账号段结果。
- [x] 实现已确认权重和排除条件：同账号重试后成功不罚、参数类 4xx 不进分母且不能改善分数、下游断开/容量/管理流量不罚、真实晚期 SSE 错误只记一次；定义通过 model 校验后的全局请求/错误与账号段 error 口径。
- [x] 从最近 1440 分钟健康桶派生 score、样本数和 available/degraded/unhealthy/insufficient。
- [x] 用 disabled/banned/cooling 覆盖评分展示；本地恢复仍只清理现有动态处置状态。

**验证点**：边界 5 个样本、50/80 分；24 小时过期；A→B 两段；500→200 同账号成功。

## 4. Cline 额度后台刷新

- [x] 扩展现有原生 Cline transport 支持默认保持 POST 的 GET 请求，检查所有调用方及 Content-Length 行为。
- [x] 实现 usage-limits 严格解析：`success/data.limits`、三种类型、0–100 数字、可选 ISO reset；未知类型忽略，已知行异常/重复拒绝整次替换。
- [x] 使用账号 Bearer 和账号代理请求，不发送客户端/自定义聊天 Header，代理失败不直连。
- [x] 实现并发 2、15 秒超时、5 分钟成功间隔、1–15 分钟退避、稳定抖动、15 分钟 stale、同账号不重叠及 `unref()` timer；提供仅 `NODE_ENV=test` 生效的时间缩放/零抖动 seam。
- [x] 仅在 `quotaPool` 开启时运行调度；开启/账号变更安排刷新，关闭/删除停止影响；聊天选号只读快照且绝不 await/触发刷新。
- [x] 用每账号内存 generation + 捕获 Key/代理值阻止删除、轮换或关闭后的旧请求提交；聊天在途完成后只保留 global，不能复活已删除账号状态。
- [x] 失败只保存安全枚举类别并保留 last-good 供诊断，路由立即变 unknown；不得修改健康、冷却或封禁。

**回滚点**：关闭 `quotaPool` 必须完全停止额度状态对选号的影响；接口失败必须退回 unknown 普通路由。

## 5. 调度流水线与兼容快路径

- [x] 将当前 `acquireAccountLease()` 原行为保留为明确 legacy fast path；四开关全 false 时直接调用。
- [x] 实现纯候选计划：硬过滤 → 健康过滤/显式 fallback → quota pool → 健康层 → 可选/隐式 HRW → mode 内排序。
- [x] 全 quota unknown 时 quota 步骤 no-op；数据不足与 available 同层；只在健康过滤清空硬候选时恢复最高分 unhealthy。
- [x] 按 design 的 `pipeline sticky × 六 mode` 矩阵实现有/无 identity、主账号空闲/满载、single active 覆盖、sticky 等待和其余四模式立即跨层容量回退；HRW 只执行一次，容量唤醒后重建计划。
- [x] 确保 RR/weight 计数只在真正参与选择的层推进；相同层/分使用既有模式及稳定 ID 确定。
- [x] 扩展 `selectionResult` 与日志严格投影，记录枚举步骤、候选数量、quota/health 层和 capacity/filter fallback，不记录会话/fingerprint 或原始额度。
- [x] 保持 `runChatChain()` 永不选号；cooldown/ban 仅在输出前最多执行一次排除后重选，禁止第三账号和输出后重放。

**关键门**：为六种 mode 分别比较缺失 pipeline 与全 false pipeline 的账号序列、等待、429、reason、比例和 activeCount。

## 6. 管理 API

- [x] `GET /api/accounts` 返回完整流水线和精简 health/quota 状态，同时保留现有兼容字段。
- [x] `POST /api/accounts` 在任何 mutation 前完成 mode/wait/rules/pipeline/accounts 全量校验，并持久化完整配置。
- [x] 新增认证 `GET /api/statistics`，只返回 lifetime/recent24h、coverage/ratio、当前账号 health/quota 投影，不返回 bucket、raw META 或敏感值。
- [x] 对所有新 API 数字/null/状态枚举做边界测试，确保统计持久化失败不改变聊天响应。

## 7. 控制台错误规则与流水线 UI

- [x] 在账号错误 JSON 编辑器旁新增独立规则预设选择和“预览应用”。定义标准、快速、保守、观察、清空五项；其他 4xx 不进入预设。
- [x] 预览读取当前 textarea 草稿，提供默认 merge 与 replace；clear 强制 replace；分类展示 preserved/added/modified/deleted。
- [x] 取消不变更；确认写回 JSON 并走完整 `saveAccounts()`；服务端拒绝后不宣称成功。
- [x] 修正现有综合策略预设，使规则合并读取实时 JSON 草稿并不覆盖未保存自定义规则；从旧 `safe` 预设移除 401/403 自动 ban，确保所有自动预设的 4xx 仅含 429；高级 JSON 仍可自定义任意合法规则。
- [x] 增加固定顺序四开关及语义说明；`collectAccounts()` 保留全部隐藏账号字段并提交完整 pipeline。

## 8. 顶层统计 UI

- [x] 将顶部导航扩展为“控制台 / 统计 / 请求日志 / 错误日志”四个互斥板块，并保留现有日志竞态防护。
- [x] 进入统计板块请求 `/api/statistics`；独立 query generation 防止旧响应跨板块渲染；提供刷新按钮和 `aria-live` 状态。
- [x] 展示累计与最近24h全局卡片，token 值必须伴随覆盖数；无分母显示“无数据”；旧版请求基线单独标注可能含控制台测试，不混入精确聊天总量。
- [x] 展示账号级处理数/token/错误、健康覆盖状态、分数/样本、运行状态、5h/周/月额度、池/新鲜度/安全错误类别。
- [x] 对服务端文本统一使用 `escapeHtml()`/`textContent`，表格窄屏横向滚动，不渲染任何密钥、代理、Header 值、备注、消息、会话、raw trace/response。

## 9. 自动化验证

- [x] 扩展 `test/integration.test.js`：usage 字段变体、0/缺失/非法、cache 配对分子与双指标、非流式/流式最后快照、`streamHead` 同 chunk 多事件、幂等 finalize、重试/换号归属、管理流量排除、重启/迁移/删除。
- [x] 覆盖健康分类、5/50/80 边界、1440 分钟窗口、50,000 个 `(minute, accountId)` 联合单元原子驱逐/coverage、safe integer overflow/null、损坏 statistics 启动失败且原 metadata 字节完全不变、参数4xx、断开及晚期 SSE。
- [x] 覆盖六模式 legacy/all-false 等价、旧管理客户端省略 `accountPipeline` 时保留已启用值，以及流水线硬过滤、health fallback、quota 80/95 边界、unknown no-op、容量跨层、sticky 去重、最多换号一次。
- [x] 使用本地 mock 与 test-only timing seam 覆盖额度 endpoint、Bearer、代理、并发/超时/退避/stale、失败立即 unknown、last-good 仅诊断、删除/Key/代理轮换 generation 竞态和关键路径不等待；自动测试不得调用真实账号或真实 Cline 配额。
- [x] 扩展 `test/ui-contract.test.js`：五预设及所有自动预设均不含 401/403、自定义 JSON、merge/replace/clear diff、完整账号快照、四顶层板块、统计未知/覆盖渲染、可访问性和无敏感 raw 展示。
- [x] 必要时为纯 bucket/parser 增加最小可运行测试，但不新增仅使用一次的测试抽象。

## 10. 文档、规范与最终门

- [x] 更新 README 配置/API/UI/统计口径/额度半公开与 fallback 说明。
- [x] 更新 backend database/quality/logging 与 frontend state/quality 规范；只记录本任务新增的可执行契约。
- [x] 运行：
  - [x] `node --check server.js`
  - [x] `node --check lib/jsonl-log-store.js`
  - [x] `npm test`
  - [x] `git diff --check`
- [x] 使用临时 `DATA_DIR` 和假账号/mock quota 做桌面及 500px 窄屏浏览器验收：四板块、预设 diff、pipeline、unknown/partial/override 统计、键盘与焦点。
  - Chrome 实测 1710×984 与 500×900 窗口；规则合并预览保留自定义 418，取消无副作用；抽屉自动聚焦、Escape 关闭并返回触发按钮；统计完整/部分/失败额度和无数据语义正确，宽表提供独立横向滚动区域。
- [x] 全范围 `trellis-check`；确认无重复 usage、伪 0、秘密泄露、旧模式回归或定时器残留。
- [x] 回读 PRD 所有 AC；经用户确认后按逻辑批次提交，不推送。
