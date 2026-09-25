# 管理 API 与控制台性能审查（只读静态证据，2026-09-25）

范围：当前工作树 `server.js`、`public/index.html`、`test/`、`.trellis/spec/frontend/state-management.md`；没有启动服务、浏览器、基准测试或接触生产数据/凭据。下列“热点”是代码可证的工作量/请求数，**不是已测慢操作**。本文件只供 `09-25-whole-service-performance` 子任务制定实验；其基线应在其它子项集成后重新取得。

## 服务端投影与读写边界

| 路径 | 代码证据与成本结构 | 性质/待测条件 |
|---|---|---|
| `GET /api/statistics` | `server.js:4778-4783` 首先同步 `pruneStatistics()`，再按每个账号 `aggregateRange(id)` 扫 24h `minuteBuckets`、`healthProjection()` 再扫桶；按 `statisticsModelIds()` 收集模型（扫描每桶五张 map），每个模型 `aggregateModelRange()`，`modelProviderProjection()` 收集渠道/聚合最终请求，`providerUsageProjection(model,null)` 再扫桶，每个渠道再调用 `providerUsageProjection(model,id)`、`successHealthProjection()` 分别扫桶；最后 `sendJSON` 同步 `JSON.stringify` 整个 JSON (`server.js:4523-4527`)。`pruneStatistics` 还扫描并裁剪 account/model/provider/usage/valuation cells、遍历旧价格版本引用 (`server.js:2489-2545`)。 | **确定有重复遍历、线性及模型×渠道×分钟项**，单次实际耗时未知；计价版本、覆盖/未知不能为优化而丢弃。大量历史稀疏桶或多渠道时测 CPU/事件循环/响应字节。 |
| `GET /api/accounts` | `server.js:4785-4795` 同步 `clearExpiredCooldowns()`、`cachePoolRoles()`（`server.js:1575-1612` 使用 `pipelineCandidates`、筛选/排序），对每个账号再 `aggregateRange(id)` 和 `healthProjection()` 扫桶、`quotaProjection()` 在一行中调用两次，构造包含配置账号自身字段、实时摘要、规则/管线的完整 JSON；`cachePoolMembership(enabledAccounts())` 再算一遍。 | **确定重复汇总和池计算**；两次 quota 投影的内部成本未单独实测。此路由返回上游密钥等敏感完整对象，只能在本地合成数据测量，不能把响应放进日志/报告。 |
| `GET /api/models` | `server.js:4607-4618` 先 `await catalog()`；`server.js:4534-4542` 命中 1h 内目录缓存直接返回，否则通过上游 `/models` 发起最多 60s 的 `fetchJSON`，有新目录时 `saveMeta()`；再拼已知模型和配置、逐模型 `projectModelMeta()` (`server.js:2282-2289`)，对每个已知渠道 `successHealthProjection()` 扫 24h 桶；`sendJSON` 序列化目录+模型。根 HTML `server.js:4603-4605` 每次 `fs.readFileSync(public/index.html)`。 | 冷/过期目录 **存在远程依赖**，不能把等待归因本地 CPU；缓存命中时仍有重复扫描和 HTML 同步 I/O 候选。区分冷/热目录、并发过期请求（是否重复拉取需测）、账号作用域数量。 |
| `POST /api/accounts` | `server.js:4796-4881` 完整账号/规则/路由校验、按 ID 规范化，遍历旧账号及各模型路线、清理各桶的已删除账号、重算绑定/池、`saveConfig(); saveMeta()` 同步写；不是普通模型请求频率。浏览器 `saveAccounts()` (`public/index.html:1292-1295`) 成功后 `loadAll()`。 | 只在编辑保存发生；测规模性延迟、主线程阻塞和原子落盘，不能通过跳过校验、隐字段或持久化换性能。失败/重启往返也要验证。管理探测/测试是显式上游网络操作，别混入纯投影基线。 |

`server.js:2567-2660` 的统计终态双次 `pruneStatistics()` 和 `record()` 的同步元数据落盘是另一条**写入热路径候选**；不能把管理页重复读取误写成它已被证明是瓶颈。`test/integration.test.js` 和 `test/model-provider-ui.test.js` 等提供语义/竞态回归，不是延迟基线。父任务现有 `research/current-contract-and-hotpaths.md` 提到归档 5 MiB 脱敏约 118ms event-loop p99；那是特定脱敏样本，不能外推到这些管理端点。

## 前端导航、筛选、绘制

- 初次认证会先 GET `/api/auth/state` 再 `/api/auth/session`，成功后 `loadAll()` (`public/index.html:1550-1557`) 并行发 **六个**管理读：`/api/models`、`/api/accounts`、`/api/security`、`/api/meta`、`/api/model-aliases`、`/api/statistics` (`:638-667`)。`Promise.all` 的页面完成时间受最慢项影响；这些请求在单进程事件循环中并非 CPU 并行。`loadAll()` 把 statistics 模型行按 ID 加入 DATA、重置账号和规则草稿，`render()`/`renderAccounts()` 都执行；手动“刷新”、切换路由作用域（`:902`）及多种写入成功再次调用同一组六读。**网络请求数量可证，是否请求风暴/造成阻塞未测**；`loadAll()` 没有自己的 AbortController/代际检查，并发刷新接受哪个结果及草稿安全需单独回归，不能仅为性能加粗暴缓存。
- `render()` (`:571-624`) 为每个订阅模型生成整行 HTML，每行 `upstreamPanel()` (`:516-544`) 为每个渠道生成多控件、`providerHealthView()`，最后 `#subBody.innerHTML` 整体替换，还重建测试模型选项、`renderCatalog()`。`renderCatalog()` (`:626-636`) 每次目录输入即同步 filter 全目录并截前 400，对每个匹配行用 `DATA.subscription.find(...)` 线性搜索，然后整体替换最多 400 行；**至少 O(目录条数 + 400×订阅条数)** 的 JS 查找和 DOM 解析（未计字符串长度）。订阅模型×渠道导致隐藏 `<details>` 面板的 DOM 仍预先生成。`#catFilter` 的每次 `input` 都触发，未做节流（`:1539`）；不能假定 400 上限意味着目录过滤廉价。
- `renderAccounts()` (`:1057-1140`) 搜索/选中/修改草稿后重建全部可见账号 `<tr>`；`updateBulkSelection()` 自行调用 `visibleAccountRows()`，随后 `renderAccounts()` 再调用，且每账号格式化缓存/额度/日期。账号 drawer `openAccountDrawer()` 只填控件，`saveDrawer()` 修改本地草稿再绘表，**没有自动落盘** (`:1299-1305`)；`collectAccounts()` 序列化全部账号及隐藏字段后才明确保存。规则草稿每次改动克隆、校验并重绘整张规则表 (`:1145` 起)；属于编辑规模候选，不是请求级热路径。搜索必须保留无效草稿、账号 identity、选择和焦点语义。
- `switchSection()` (`:1414-1426`) 对统计页面启动 `startStatisticsVisit()`：先 GET `/api/statistics`，后 POST `/api/statistics/quota-refresh`（入口 `force:false`），完成后**再次** GET `/api/statistics`；手动刷新及可见时每 5 分钟定时器也可能触发 POST + GET (`:1408-1413`)。同一 visit 的刷新 Promise 合并、切走取消、陈旧响应不画，不能描述为无限轮询。统计页前端还按账号/四个时点计算预测 `statisticsQuotaForecast()` (`:1321-1349`) 并构建含多列额度/Token 表 (`:1356`)。与控制台六读并存时测服务端 CPU、Quota 上游等待分离。
- 模型/渠道页 `loadModelProviders()` (`:1394-1406`) **另一次完整** GET `/api/statistics`；每次切页/点刷新有新请求，控制器 abort 旧读、代际/可见性保护。筛选 `oninput=renderModelProviders()` (`:166,1376-1393`) 只重绘已接收快照，**不发请求**；却对全部模型及子渠道筛选、逐行 `mpMoney()` 遍历计价版本/费率，生成长价格/覆盖文本并整体替换表格。按条数、文本字节及 DOM 节点数实测，不要把筛选误算为服务端请求风暴。UI 简化交付可能改变节点量，性能基线应以集成版本为准。

## 本地模拟量测（建议，无现有数值）

1. 同一提交、单进程、本地 mock `/models`/chat/quota、隔离临时 `DATA_DIR`，生成**虚构**管理员和上游凭据；不引用仓库 `config.json`、`metadata.json`、`data/`。用稀疏 24h 桶和不同组合：账号 1/10/100、模型 5/50/200、每模型渠道 0/2/10、目录 100/1000/5000、规则少/多、价格版本少/多（遵守真实 schema 限制）。固定数据种子/文件大小并标注投影覆盖/裁剪，不能通过超规格伪造有效状态。
2. 对 `/api/statistics`、`/api/accounts`、热/冷 `/api/models`、`/` 分开测试单读、混合并发读、与本地聊天最终写入混合；每种预热后多次采样。用外部客户端记 TTFB/完成 p50/p95/p99、响应字节及状态；服务进程测 `process.cpuUsage()`、`monitorEventLoopDelay()`、RSS/heap、可选 CPU profile 火焰图与同步 I/O 时间（仅合成环境）。冷目录分别记录 mock 上游响应时间/调用次数、超时，统计失配/错误和诊断丢弃；比较服务端工作与网络等待，不拿整页耗时证明哪段聚合慢。
3. 用真实浏览器（本地 mock + 独立数据）Performance/Network/Memory trace：首登 6 读的瀑布、DOM Content Loaded→`loadAll()` 最后完成、JS scripting/layout/paint long tasks、节点/heap，切路由作用域/统计页/模型渠道页、目录连续输入与账号搜索/打开抽屉/应用草稿/保存，记录每动作请求数与帧/INP 类响应、重绘节点数；测试 100/1000/5000 目录、少/多渠道、账号规模、窄屏。VM/static 单测只验证逻辑，不能代替浏览器 DOM/焦点测量。
4. A/B 保持同一数据规模、mock 延迟、诊断模式、并发和硬件，先定位 profile 最大 CPU 栈/长任务，再考虑在**现有投影 owner** 内共享单次桶聚合或缩减无用重绘；独立测试统计未知/覆盖、完整账号字段/草稿、安全认证及并发响应竞态。避免对管理 API 添加绕过鉴权的全局缓存、复用含密钥 JSON 给其他客户端，或取消原子持久化。报告单次开销与调用频率乘积：大页面偶发慢与高频 chat 写入慢分别排序，不以 300 RPM 代替编辑体验/冷读。
