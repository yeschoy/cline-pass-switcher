# 入口、选租与传输性能盘点（只读，2026-09-25）

范围：当前 `server.js`、后端路由规范与本地归档测量；没有运行负载、读取 operator 数据或访问网络。以下「成本」是静态推断，不是实测瓶颈；N=账号数，P=候选 Provider 数，B=正文大小，W=等待请求数。

## 入口及正文

- **事实** `server.js:4557-4574,4576-4600` 每请求构造两次 URL（入口识别和 dispatch），先做路由与认证，管理登录独立；`server.js:1937-1943` 当前模型鉴权仅比较单个非空 `PROXY_KEY`，空 key 兼容开放；鉴权不读取正文。入口 opt-in 详细记录构建 secrets 时遍历账号及自定义 Header（`server.js:4563-4573`），O(N+Header 数)，raw 模式不做该数组。需要与多 key 迁移后重测，不能把默认关闭的详细日志开销算作所有请求。
- **事实** chat `readBody()` 按 chunk 暂存并在结束时 `Buffer.concat(chunks)`，50 MiB 上限及越界即时释放/继续 drain (`server.js:3524-3583`)；`handleChat()` 再 `raw.toString('utf8')` 和 `JSON.parse`、对象浅拷贝（`server.js:4271-4295`）。输入读取/字符串化/解析为 O(B)，峰值可同时持有 chunk、拼接 Buffer、字符串、解析对象；不是流式 JSON 解析。`sensitiveMessageValues()` 遍历消息/多模态文本，身份回退用两次 `find` 扫 messages 并各取最多 4096 字符，数组内容 `map().join()` 在 slice 之前可能处理该消息全部 part（`server.js:1318-1326,2910-2977`）；大消息需单独测内存与 CPU。正文限制不等于堆峰值限制。过限的 `413` 及上游完整保留 content 是规范行为，不应靠缩小正文或改 schema 冒险提速。
- **事实** 无论后续 provider 是否重试，`injectPrefs()` 每一次 attempt 都 JSON.stringify+parse 深拷贝整个 body，再 stringify 上游正文（`server.js:3626-3650,3997-4004,4139-4154`），总量约 O(B × attempts)，大正文/多失败重试时可能成为主线程和内存热点；传输又通过 `Buffer.from` 建立字节副本（`server.js:3049-3066`）。优先测 1/多 attempt、小/大请求的 CPU、事件循环与 heap，不能直接删掉深拷贝而改变客户端 body/Provider prefs 的隔离语义。

## 账号候选、等待与限流

- **事实** `enabledAccounts()` 每次调用扫全部账号并调用 `clearExpiredCooldowns()`；过期时扫 accountStates 并同步 `saveMeta()`（`server.js:1333-1360`）。通常为 O(N)，过期状态命中有潜在主线程磁盘阻塞；需要按冷却到期/账号规模测出现频率，不能认为每次都落盘。未选到 lease 的错误分支额外做 `config.accounts.filter()` 和两次 `enabledAccounts()`（`server.js:4306-4320`）。
- **事实** legacy sticky HRW 是对每对比较计算 HMAC/Buffer 并排序（`server.js:1417-1422,1456-1469`），约 O(N log N) 次加密；weighted-roundrobin 把每个账号的权重展开成 1–100 虚拟槽，然后切片、合并及 Map 去重（`server.js:1429-1447`），O(Σweight) 时间/临时内存；即使最终只用一个候选也会分配整个循环。pipeline 下 `pipelineCandidates()` 为每个账号求 24h health/quota，`buildPipelineGroups()` 多次 filter/flatMap/排序，sticky 可逐组 HRW，cache membership 排序并重建 Set/Map（`server.js:1539-1618`）；启用 healthSort+cache 的大 N 与重复等待唤醒值得测，但不同模式不能混算。`successHealthProjection` 的桶扫描应另计入统计盘点。
- **事实** 绑定 map 有最大 100000/默认 50000 条；创建时只检查前 256 条过期记录及 LRU 容量，full 清理/按账号失效扫全 map（`server.js:1205-1309`）。绑定命中路径等待唤醒后重复构造 `bindingSelectionContext`（再次扫账号、算投影、排序 membership，`server.js:1677-1692,1725-1837`）；等待是 deadline 最多 30 秒，复用全局 Set/timer，容量释放通过复制整个 waiter Set 并逐个唤醒（`server.js:1204-1210,1395-1415`），高 W 时可能形成群体重算；不是忙等，且无 per-account 队列。`acquireCachePoolAccountLease()` 与普通 pipeline 也在醒后重建候选（`server.js:1839-1910`）。动态 cache 扩容才 `saveMeta()`（`server.js:1662-1688`），应与常见命中分开测。
- **事实** RPM 每账号一个 60s 进程内滑窗，裁剪用 head、累计过半才 slice，后续真实 provider attempt 独立预留，在 `req.end()` commit，失败前退还；并发先于 RPM（`server.js:620-690,1371-1393,4130-4138`）。有容量过滤及到最早恢复时刻的等待，没有逐请求全窗口遍历或定时器扫描。不得用跳过 RPM/并发限制换吞吐，300 RPM 与并发不同。`runChatChain` 账号固定、前置 account removal 最多一次重选（`server.js:4092-4139,4338-4370`），但重试每次规划/序列化真实发生。

## HTTP、重试、SSE 与取消

- **事实** 直连 native http(s) agent keepAlive、LIFO，默认 256 sockets/32 free，账号代理默认 32/2；缓存最多 128 个已配置代理 URL，临时/超量 URL 用 disposable agent，且 `clineRequest` 为判断是否持久化代理每请求 `.some()` 扫账号（`server.js:2994-3018,3048-3074`）。重复 DNS/TLS/代理握手与代理池耗尽是待测候选，不宜改为直连 fallback；慢上游/上游限额应从服务 CPU/排队分离。
- **事实** nonstream `streamToString()` 为每个 chunk `Buffer.from`、累计 chunks、结束 `Buffer.concat().toString()`，无默认上游 body 大小限制；之后 JSON.parse/unwrap（`server.js:3094-3114,3997-4024`），失败响应也可能放大 B、heap 和同步解析耗时。单次尝试有 120s 默认 deadline（`server.js:4139-4148`）；多 Provider 失败延长端到端延迟是预期重试，不等于本地 CPU 低效。规划候选最大 20 配置/100 发现 Provider，`buildProviderPlan()` 给每个可用候选求 health、排序，`selectProviderAttempt()` 每次重新筛选/排序剩余集合（`server.js:3652-3721`）；典型 P 小，先测再改。
- **事实** SSE 在首个合法 data event 前最多缓冲 64 KiB、120s wall deadline；每次 chunk 重新拼接有界头、转换 latin1 并正则搜边界（`server.js:3487-3522,4141-4203`），注释/坏头不能无限放大，但碎片化极端下会重复扫描头部（最坏接近二次方于这个 64KiB 上限）。起流后流经 Writable，`res.write(false)` 暂停上游、等待 drain，heartbeat 仅完整事件边界发送、上游空闲 360s（`server.js:4369-4503`）。每块 observer、4 字节尾部拼接/边界检测有小的 O(chunk) 工作，需测碎片多块、慢消费者及内存，不能牺牲背压或第一事件语义。首个错误数据事件在暴露客户端前分类重试；起流后绝不重放（`server.js:4153-4210,4370-4504`）。
- **事实** 客户端 socket close abort 正在进行的尝试；流终态 idempotent 清理定时器/drain 与 lease（`server.js:4109-4116,4420-4503`）。退出先停止 intake/quota，等 active response 与日志 drain 共用 10s deadline，再销毁连接/agent（`server.js:5033-5081`）；不能通过提前 release/销毁 agent 制造虚高容量。关闭等待及慢客户端归入不同场景，不算每请求常态成本。

## 旧证据与下一步（均非当前路由/传输 benchmark）

- `.trellis/tasks/archive/2026-09/09-21-error-detail-log-performance/research/performance-validation.md`：Node 26 arm64 本地 mock、临时 DATA_DIR，50 MiB error-only 成功 ingress wall 150.02ms、捕获保留 0；其 clientHeapDeltaMiB=100.84 是**测试客户端进程**，不是 Switcher RSS。单独 5 MiB 脱敏捕获 CPU wall 102.24ms、event-loop p99 118.36ms、RSS delta 63.58 MiB；仅默认关闭的诊断场景，不能外推整个程序/300 RPM。
- 采样建议：本地 mock + temp DATA_DIR，定量记录单请求 vs 多请求、小/近上限 body、1/多 Provider、账号规模/权重/绑定命中/等待风暴、代理 keepAlive/新建、短 JSON/有界 SSE/慢下游/取消与关闭；分别获取 client p50/p95/p99、event-loop delay、CPU、RSS/heap、agent 活跃/排队 sockets、真实 attempt 数和错误、限制触发。300 RPM 只是其中一个聚合场景。优先对「大 B × 重试的深拷贝/序列化」「大 N pipeline/HRW 与大量 waiter 唤醒」「nonstream 大上游响应」做隔离 profile，先证明占比再考虑优化；保留字节级转发、鉴权、租约、RPM、背压与取消回归。未做实际压测，不宣称某一项已是瓶颈。
