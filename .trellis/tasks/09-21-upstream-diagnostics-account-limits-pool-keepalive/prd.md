# 上游诊断、账号限流、热池调度与长连接兼容

## Goal

在不修改 New API 代码的前提下，增强 cline-pass-switcher 的上游错误诊断、账号级流量保护、额度热池调度和长连接兼容能力，同时降低日志持久化对用户请求与上传链路的性能影响。

## Source Requirements

1. 错误日志需要记录上游错误响应头和响应体。
2. 账号需要支持 RPM（每分钟请求数）限制，并遵循“并发数限制优先于 RPM 限制”的准入顺序。
3. 额度热池需要：
   - 保持 `n` 个高额度账号和少量低额度账号可用；
   - 在可用性约束下，尽可能优先消耗低额度账号；
   - 低额度账号一旦发生错误，应立即冷却，避免继续影响请求成功率。
4. 优化日志记录性能，避免日志工作阻塞或显著拖慢用户上传/请求链路。
5. 调查 New API 是否支持长连接，并核实当前 cline-pass-switcher 是否兼容；如不兼容，只修改 cline-pass-switcher 以实现与 New API 配合，不修改 New API。

## Confirmed Facts

- 普通 request/error JSONL 已采用异步增量段存储，ready 后 append 不扫描或重写历史；详细日志 store 也已用内存 inventory 消除 publication/query/分钟维护的全语料扫描。当前主要剩余开销不是历史扫描，而是完整详细模式对所有成功请求/响应的同步复制、解析和脱敏，以及同一请求中的重复同步 metadata 原子写。
- 上游响应头和响应体当前已经可由 `DetailedLogStore` 保存：响应头位于 attempt metadata，正文由 body descriptor 指向按需读取的脱敏文件；但该能力默认关闭，错误日志页只读取普通 JSONL，无法直接打开对应 attempt。
- 普通日志现有安全契约禁止保存 Header 值和上游正文；它们只能进入独立、受控、按需读取的详细存储。
- 当前账号准入只有 `maxConcurrent`，没有 RPM；账号 lease 是并发检查、计数、释放和等待的唯一 owner。
- 当前额度分层顺序为高额度优先，固定热池成员也不按余额构成，和“低额度优先消耗，同时保留高额度兜底”目标相反。
- New API 已明确支持 HTTP/1.1 keep-alive 连接池、TLS 上游 HTTP/2、Chat Completions SSE、可选 SSE ping 和流式空闲超时；当前集成到 switcher 使用 HTTP/1.1 Chat Completions。
- switcher 已支持 Chat Completions SSE 和取消/租约释放，但直连/代理出站连接复用不是跨 Node 18+ 的显式契约，入站 keep-alive 生命周期依赖 Node 默认值，且不生成 SSE 心跳；它不支持 WebSocket Realtime、HTTP/2 入站或 `/v1/responses`。

## Task Map

- `09-21-error-detail-log-performance`：错误详情独立开关、错误页联动、日志热路径和退出 drain。
- `09-21-account-rpm-limits`：账号字段、滚动 RPM、真实 Chat attempt permit 和完整管理面往返。
- 既有 `09-20-dynamic-cache-pool-growth`：先提供总池 min/max、持久化 target 和 concurrency-only grow-one；仍由原父任务拥有，不复制到本任务树。
- `09-21-low-quota-pool-refresh-cooling`：依赖 RPM 和既有动态池，实现 high/low 组成、低额度优先、刷新冷却与耗尽恢复。
- `09-21-newapi-chat-keepalive`：HTTP/1.1 连接复用及 Chat SSE 心跳/超时兼容。
- 本父任务负责需求源、串行顺序、跨子任务验收和最终规格一致性，不作为直接代码实现目标。

## Requirements

### R1. 上游错误诊断

- 新增独立的“错误详情记录”开关，默认关闭以保持现有行为；它不与完整详细日志开关互相替代。
- 开关关闭时，普通请求/错误日志字段、数据面和展示行为保持现状。
- 开关开启时，记录每个真实失败上游 attempt 的状态信息、经脱敏的响应头和有界响应体，包括最终失败前的中间 Provider/账号尝试、HTTP 4xx/5xx、HTTP 200 错误 envelope，以及可识别的流内错误事件。
- 传输失败若未收到上游响应，只记录无响应/传输失败事实，不伪造响应头或空正文。
- 复用现有详细日志 store、脱敏、保留、鉴权和按需正文 API；普通错误 JSONL 只保留安全关联字段，不直接承载 Header 值或正文。
- 错误日志页能够通过 `requestId + attemptIndex` 精确打开对应上游 attempt 的脱敏 Header/正文；可精确区分开关关闭、未收到响应、已收到响应后流中断和已有详情的安全省略状态。若详情 group 不存在，只能诚实显示“详情不可用（可能已过期、已清空、被容量边界丢弃或发布失败）”，不得伪造逐请求原因。
- 仅错误详情模式不得复制 ingress 正文、成功响应或完整成功 SSE；完整详细模式继续作为独立人工排障能力。完整模式开启时不得重复发布同一错误详情。
- 诊断记录失败不得改变模型请求的错误语义或造成二次故障。

### R2. 账号级并发与 RPM 限制

- 每个账号可配置最大并发数和 RPM 限制。
- RPM 按该账号实际发往 Cline `/chat/completions` 的每次真实 HTTP attempt 计数；同账号 Provider 重试分别计数，未实际发出的请求不计数。限流使用每账号、单进程内的滚动 60 秒窗口；服务重启后窗口清空，多副本各自独立，不提供跨进程全局硬上限。
- 账号选择/准入时先执行并发约束，再执行 RPM 约束；并发容量不可用的账号不能因 RPM 尚有余量而被选择，并发未通过时不得预占或消耗 RPM。
- 取得账号并发 lease 后必须为首次真实 attempt 保证一个 RPM 名额；后续 Provider attempt 每次独立取得 RPM 名额。RPM permit 在 `ClientRequest` 创建成功并调用 `req.end()` 交给 Node transport 时提交；提交后不因成功、错误或取消而返还，调用 `req.end()` 前失败/未发送的预留必须释放并唤醒等待者。
- Provider retry 没有 RPM permit 时不再等待或换号，立即停止后续 attempt并返回本地 429 + `Retry-After`；此前真实失败 attempt仍按原始上游状态进入错误日志，请求行明确标记本地 RPM 终态而不伪造上游 429。
- 配置保存、加载、接口返回及控制台草稿必须完整保留新字段。

### R3. 额度热池与错误冷却

- `cachePoolSize` 继续表示最小总活跃池大小，`cachePoolMaxSize` 表示动态扩容上限，新增 `cachePoolLowQuotaSize` 表示当前池中的低额度槽数量；高额度目标数为当前动态 target 减低额度槽数。动态扩容新增的槽默认用于高额度兜底。
- `cachePoolLowQuotaSize=0` 明确关闭 role-aware membership和低额度优先，完整沿用既有 non-reserve + priority/stable-ID 热池行为；旧配置缺失该字段时按0兼容，不能在升级后静默改变流量范围。默认关闭的新安装仍为size=0/low=0；只有operator把池设为正数或启用对应预设时，控制台才建议/写入low=1。动态扩容不自动增加低额度槽。
- 高额度沿用现有 `hot`：三个额度窗口的最大已使用比例低于 80%；低额度沿用 `warm`：最大已使用比例为 80%～不足 95%；`reserve`（已使用 95% 及以上）继续保护，不进入常规热池或低额度优先消耗层。
- 在不破坏高额度兜底容量和请求可用性的前提下，提高低额度账号的请求分配概率，以尽可能先消耗低余额。
- 启用role-aware pool时，角色快照为low且最终规则结果为`scope=account, action=degrade`的attempt立即触发独立的quota removal outcome，退出调度并进入`waiting-refresh`，不使用固定时长；显式account cooldown/hard-quarantine只执行其规则动作，不叠加quota hold。Provider/model-scope、显式`ignore`和客户端取消不设置quota hold。
- 冷却账号只有在下一次额度刷新成功后才重新判断：额度变为可用则自动解除该冷却；刷新失败、额度未知或仍不可用时继续排除。
- 启用role-aware pool时，最新成功额度快照中任一已知有效窗口达到100%即进入持久化`quota-exhausted`调度状态，即使快照不完整；刷新失败或其余窗口未知不会解除已确认耗尽。不修改operator的`enabled`，也不冒充人工禁用/硬隔离；到最早已耗尽窗口的有效未来`resetsAt`后刷新并重新判断，只有所有已知窗口均低于100%才自动解除，仍耗尽则继续排除并计算下一次。
- 未知额度与已知数值零必须保持不同语义。

### R4. 日志性能

- 普通日志和详细诊断日志不得在请求/上传关键路径上执行无界、重复或不必要的同步工作；CPU脱敏仍在Node主线程时必须描述为有界、延后且fail-open，不得误称为真正非阻塞。
- 普通日志 append queue 必须有记录数/字节数边界；超限仅丢诊断并记录安全健康计数。
- 合并同一请求终态中的重复 metadata 持久化；如采用异步合并写，只允许一个版本化 owner，避免旧快照覆盖新状态。
- 完整详细模式应消除可证明重复的请求正文解析/学习；错误详情模式只复制失败所需的有界内容。
- 优化后仍须保留有界存储、顺序一致性、失败隔离和进程退出时可验证的落盘行为。

### R5. New API 长连接兼容

- 基于 New API 的公开文档/源码行为和本项目实现，确认双方对长连接相关能力的支持情况。
- 对现有 New API → switcher Chat Completions 链路，补齐 switcher 侧显式 HTTP/1.1 出站连接池、入站 keep-alive 生命周期、SSE 成功起流后的注释心跳、首事件/已开始流空闲超时分离，以及前置 SSE 注释兼容。
- 本任务明确不实现 HTTP/2/h2c 入站、WebSocket Realtime 或 Responses API；这些协议不属于现有 Chat Completions 集成。
- 不修改 New API 代码，不依赖生产凭据或付费上游完成验证。

## Constraints

- 不修改 New API 源码。
- 不新增框架、前端构建链、重复调度器、重复队列或第二套状态所有者。
- 复用现有账号选择、租约、错误规则、详细日志捕获和原子持久化边界。
- 上游错误内容属于高敏感诊断数据，不得直接扩大普通日志的数据面。
- 保持现有管理 API 和配置的向后兼容；未配置 RPM 时不得意外限流。
- 测试使用临时 `DATA_DIR` 和本地 mock，不访问生产数据或真实上游。

## Acceptance Criteria

- [ ] AC1：错误详情开关关闭时模型流量、ordinary敏感数据面和默认错误列表行为与当前版本一致；开启时每个真实失败attempt都发起有界捕获，成功发布后可查看脱敏Header/body。未收到响应、已起流后中断、安全省略和group不存在分别使用诚实状态；普通日志仍不包含Header值、正文、密钥、代理地址或凭据。
- [ ] AC2：账号并发和RPM限制均生效；自动化测试证明并发优先且并发失败不消耗RPM，每个调用`req.end()`的真实Chat attempt（包括Provider retry）各计一次，发送前预留可释放并唤醒等待者；retry无permit时返回本地429且保留此前真实attempt，lease在完成/错误/取消路径正确释放。
- [ ] AC3：账号配置的 RPM 字段可经配置文件、管理 API 和浏览器控制台完整往返，旧配置保持兼容。
- [ ] AC4：low=0时成员与既有priority/ID行为一致；low>0且至少一个low账号可准入时确定性选择low，low被并发/RPM/quota状态阻塞且high可用时立即选择high；实际high/low/unknown组成如实投影。
- [ ] AC5：low角色账号命中account-scope degrade后立即产生quota removal outcome、首包前最多换号一次并进入waiting-refresh；显式rule disposition和quota disposition互不误清。启用role-aware pool后任一已知窗口确认100%即进入quota-exhausted，并在resetsAt后的真实刷新确认全部已知窗口恢复时自动解除。
- [ ] AC6：结构性测试证明成功error-only路径不复制请求/成功正文、ordinary单条与pending队列有固定边界、同一chat终态只执行一次可合并metadata保存、shutdown有deadline；同机benchmark记录wall time/event-loop/heap但不作为跨机器绝对门禁。写入故障保持fail-open。
- [ ] AC7：形成 New API 与 cline-pass-switcher 长连接能力的证据化结论；若需改动，集成测试证明仅修改本项目即可协同工作。
- [ ] AC8：相关单元、集成、UI 契约和全项目质量门通过，操作文档、示例配置和可复用规格同步更新。

## Out of Scope

- 修改、部署或维护 New API 代码。
- HTTP/2/h2c 入站、WebSocket Realtime 和 Responses API 支持。
- 使用生产账号、生产数据或真实付费上游进行测试。
- 未经单独授权的生产部署。
