# 父子任务规划一致性独立评审

## 评审范围

只读核对了以下内容：

- 父任务：
  - `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/prd.md`
  - `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/design.md`
  - `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/implement.md`
- 四个 09-21 子任务各自的 `prd.md`、`design.md`、`implement.md`：
  - `.trellis/tasks/09-21-error-detail-log-performance/`
  - `.trellis/tasks/09-21-account-rpm-limits/`
  - `.trellis/tasks/09-21-low-quota-pool-refresh-cooling/`
  - `.trellis/tasks/09-21-newapi-chat-keepalive/`
- 三份父任务研究：
  - `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/research/logging-error-detail-performance.md`
  - `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/research/account-rpm-quota-pool.md`
  - `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/research/newapi-keepalive-compatibility.md`
- 既有动态池任务：
  - `.trellis/tasks/09-20-dynamic-cache-pool-growth/prd.md`
  - `.trellis/tasks/09-20-dynamic-cache-pool-growth/design.md`
  - `.trellis/tasks/09-20-dynamic-cache-pool-growth/implement.md`
- 相关 backend/frontend/cross-layer specs。

总体结论：任务拆分、串行顺序和大部分用户决策已经清楚写入；09-20 dynamic 的 min/max/target/grow owner 与 09-21 low-quota 的 role composition/hold owner 已明确分开，没有发现重复实现 target、成员表、waiter 或扩容器的规划。但目前仍有 **2 项阻塞矛盾**，以及若干重要的验收/语义缺口，建议在启动实现前收敛。

---

## 阻塞

### B1. `cachePoolLowQuotaSize=0` 同时被定义为“legacy 不改变流量”和“全池 high-only”，两者不可同时成立

**冲突路径：**

- `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/prd.md`：R3 要求旧配置缺失 low 时按 0 兼容，且“不能在升级后静默改变流量范围”。
- `.trellis/tasks/09-21-low-quota-pool-refresh-cooling/prd.md`：Requirements 1–4、AC1 要求 legacy 缺失不改变流量。
- `.trellis/tasks/09-21-low-quota-pool-refresh-cooling/design.md`：§2 将 high target 定义为 `target-low`；§3 在 low=0 时先选 T 个 high，并按剩余额度降序；§8 又声称“low=0 恢复旧 membership”。
- `.trellis/tasks/09-20-dynamic-cache-pool-growth/prd.md`：Requirement 5 的旧/基础 membership 是所有 non-reserve 候选按 priority/stable ID 选择。
- `.trellis/tasks/09-20-dynamic-cache-pool-growth/design.md`：§3 同样规定基础 membership 为 non-reserve + priority/ID。

**为什么阻塞：**

现有/09-20 基线会让 warm 和 unknown 账号按 priority/ID 进入池；09-21 算法在 low=0 时会优先选择 high，并按 remaining 排序，只有 high 不足才使用 unknown/warm。即使 low 字段缺失被规范化为 0，账号集合和流量范围仍可能立即变化。因此“low=0 恢复旧行为”和当前算法不成立，AC1 也无法按现有文字通过。

**需要在规划层明确二选一：**

1. `low=0` 表示禁用 role-aware membership，完整沿用 09-20 的 non-reserve + priority/ID；只有 `low>0` 才启用 high/low composition；或
2. 接受 low=0 也变成 high-only，并删除“legacy 不改变流量/low=0 恢复旧 membership”的兼容承诺，明确这是迁移行为。

如果希望同时保留兼容和新算法，需要额外的显式启用状态；不能仅靠已被规范化并持久化的数值 0 区分“legacy missing”和“operator 显式配置 0”。

### B2. 错误详情 UI 要求精确区分 unavailable 原因，但设计只有一个无法反推原因的 404

**冲突路径：**

- `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/prd.md`：R1 要求 UI 区分“开关关闭、已过期/清空、捕获失败、没有上游响应”。
- `.trellis/tasks/09-21-error-detail-log-performance/prd.md`：Requirements 2、5 和 AC2–AC3 要求稳定关联、publication failure/clear/expiry 可解释。
- `.trellis/tasks/09-21-error-detail-log-performance/design.md`：§4 只为 ordinary row 规划 `detailCapture`/`detailCallId`，并把 404 合并解释成“未开启/已过期或丢弃”；异步 publication 又明确不声称 durable。
- `.trellis/spec/backend/logging-guidelines.md`：详细 store 的 persistence failure 可能使记录完全不存在，health 只能说明全局损失，不能证明某个 request 的具体失败原因。

**为什么阻塞：**

开关关闭和“无上游响应”可以由 row intent/attempt transport state 表达；但某一 request 的“已过期”“被 clear”“publication/捕获失败”在 group 不存在时都只表现为 404。全局 health 计数无法把失败归因到指定 `requestId + attemptIndex`，而 ordinary row 在异步 publication 完成前已经写出，也不能事后诚实更新 durable 状态。

**需要在规划层选择：**

- 放宽产品文案，把 expiry/clear/drop/publication failure 合并为“详情不可用”，只精确区分 off 与 no-response；或
- 设计一个仍由现有 detailed owner 持有、受界且可持久/可查询的 per-request publication outcome/tombstone，并明确 clear/expiry 的状态寿命和安全边界。

在未选择前，当前 AC 无法被黑盒测试可靠证明。

---

## 重要

### I1. “新配置默认 low=1”与当前默认禁用池、严格约束 `low <= size` 的组合未定义

**路径：**

- `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/prd.md`：R3 规定新建配置或启用对应预设时默认 low=1。
- `.trellis/tasks/09-21-low-quota-pool-refresh-cooling/prd.md`：Requirement 1–2 同时规定 `0 <= low <= size <= max`、legacy missing=0、新建/预设默认 1。
- `.trellis/tasks/09-21-low-quota-pool-refresh-cooling/design.md`：§2 没有定义如何识别“全新配置”或 `cachePoolSize=0` 时的默认值。
- `.trellis/spec/backend/database-guidelines.md`：当前 canonical 默认/基线是 `cachePoolSize: 0`，即池关闭。

若新安装仍以 size=0 启动，则 low=1 会使默认对象自身不合法；若 missing 一律归一为 0，则“新建默认 1”不会发生。应明确：新安装 disabled 状态是否 low=0，只有将池 size 设为正数或应用指定预设时才注入 low=1；并为“新文件、旧文件、旧客户端省略、preset”分别给出测试期望。

### I2. low 账号进入 refresh hold 的触发条件在父任务和子任务内部不一致

**路径：**

- `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/prd.md`：R3 说 low 账号发生 account-scope 健康失败（鉴权、额度、账号代理等）即 hold；只排除 provider/model、显式 `ignore`、取消。
- `.trellis/tasks/09-21-low-quota-pool-refresh-cooling/prd.md`：Requirement 7 将条件缩窄为 “account-scope degrade”。
- `.trellis/tasks/09-21-low-quota-pool-refresh-cooling/design.md`：§5 一处只说 account-scope degrade，另一处又说显式 account cooldown/hard-quarantine 与 quota hold 可并存。
- `.trellis/spec/backend/quality-guidelines.md`：现有 cooldown/hard-quarantine 不计作 degrade health sample，scope、rule action 和 health sample 是不同维度。

需要明确触发判断是：

- `scope=account && action != ignore && !cancel`（则显式 cooldown/hard-quarantine 也设置 hold）；还是
- 仅实际产生 account health degrade sample 的结果。

当前文字无法确定显式 account cooldown/hard-quarantine 是否必须同时进入 waiting-refresh，也无法写出唯一测试期望。

### I3. Provider retry 被 RPM 阻塞后的等待期限、最终 HTTP 状态和日志归因未固定

**路径：**

- `.trellis/tasks/09-21-account-rpm-limits/prd.md`：Requirements 7–8、AC4–AC6 只规定不得发送、不换号和提供 Retry-After。
- `.trellis/tasks/09-21-account-rpm-limits/design.md`：§4 提到“在当前请求剩余的 bounded wait 内”等待，然后返回 local rate-limit，但没有定义该期限来自 `concurrencyWaitMs`、attempt timeout 还是独立 deadline。
- `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/prd.md`：R2 要求真实 attempt 计数，同时项目总契约要求保留上游状态/错误含义。
- `.trellis/spec/backend/logging-guidelines.md`：local capacity 429 与 upstream error attempt 必须分开归因。

例如首次真实 attempt 返回 500，第二个 Provider retry 因 RPM 无 permit：最终应立即返回 429、等待到 `min(retryAt, concurrency deadline)` 后返回 429，还是保留先前 500？request row 的 `status/upstreamStatus/errorCategory` 和错误页中已有真实 500 attempt 应如何组合，也未规定。该决定影响客户端语义、延迟、Retry-After 和测试，应在 design/AC 中固定。

### I4. error-detail 的 off-mode AC 文字过宽，与新增设置 API/UI 本身矛盾

**路径：**

- `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/prd.md`：R1 较合理地限定为 ordinary request/error 字段、数据面和展示行为保持现状。
- `.trellis/tasks/09-21-error-detail-log-performance/prd.md`：AC1 写成 off 时 “API/schema/files/UI 和请求字节与现状一致”。
- `.trellis/tasks/09-21-error-detail-log-performance/design.md`：§4 必然扩展 settings GET/POST 和控制台开关，也计划给 ordinary row 增加关联字段。

新增独立开关后，settings API schema 和 UI 不可能与当前版本完全相同。应把 AC1 限定为：模型流量、ordinary row（字段是否完全不出现需明确）、ordinary 文件敏感数据面和错误列表默认交互不变；同时允许 settings API/UI 出现新控制项。若 ordinary row 在 off 时仍输出 `detailCapture: off`，也应明确这是有意 schema 变化，而不是声称完全不变。

### I5. error-detail 关联字段和状态枚举没有冻结，导致跨层实现容易漂移

**路径：**

- `.trellis/tasks/09-21-error-detail-log-performance/prd.md`：只要求 bounded 关联/捕获意图。
- `.trellis/tasks/09-21-error-detail-log-performance/design.md`：§4 提到 `detailCapture`、`detailCallId`，但没有给出允许枚举、字段出现条件、transport-no-response 的投影、旧 row 的 UI 行为或 API filter 规则。
- `.trellis/spec/backend/logging-guidelines.md`：ordinary request/error 是严格 allowlist，新增字段必须精确定义。

建议在实施前固定最小 schema，例如字段仅出现于 error row、允许哪些 enum、off/intent/no-response/unavailable 如何映射，以及历史 row 缺字段时 UI 文案。否则 backend、UI 和 specs 可能各自形成不同状态模型。

### I6. 低额度偏向和日志性能的部分 AC 仍是主观描述，不能形成稳定自动化门禁

**路径：**

- `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/prd.md`：AC4 使用“统计上明显偏向”。
- `.trellis/tasks/09-21-low-quota-pool-refresh-cooling/prd.md`：AC4 使用“显著/完全优先”。
- `.trellis/tasks/09-21-low-quota-pool-refresh-cooling/design.md`：§4 实际已经定义 deterministic low-first，因此可直接断言 low 可准入时 100% 选择 low，而无需概率阈值。
- `.trellis/tasks/09-21-error-detail-log-performance/prd.md`：AC9 使用“性能证据”；父任务 AC6 使用“不阻塞/显著拖慢”，但没有 baseline、上限或只作非 CI 证据的说明。
- `.trellis/tasks/09-21-error-detail-log-performance/design.md`：§7 仅说绝对时间作同机证据，CI 固定调用次数/边界。

建议把调度 AC 改成 deterministic 场景断言；性能 AC 明确区分必须自动通过的结构性门禁（复制字节数、parse 次数、pending 上限、saveMeta 调用次数、deadline）与仅记录的同机 wall-time/event-loop benchmark，避免实现完成后仍无法判断 pass/fail。

### I7. 父研究中的早期推荐与最终用户决策直接相反，context manifest 会同时把两者交给实现者

**路径：**

- `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/research/account-rpm-quota-pool.md`：
  - “结论摘要”第 3 点和“计数、释放和请求生命周期”推荐一次 lease admission 计一次，Provider retry 不重复计数；
  - “低额度错误立即冷却”推荐固定 cooldown duration 配置；
  - “需要用户确认”仍保留这些未决问题。
- `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/prd.md`：最终决定是每个真实 Chat HTTP attempt 各计一次，且 low 错误 hold 不使用固定时长、由 quota refresh 驱动。
- 四个任务的 `implement.jsonl`/`check.jsonl` 都会加载父 research。

最终 PRD/design 已无损写入正确决策，但研究文档未标记哪些推荐已被否决。实现者若优先读 research，可能误做 lease-based RPM 或固定 60 秒 cooldown。建议在启动子任务时明确优先级：PRD/最新 design 是最终合同，research 的“推荐/待确认”仅为历史备选；最好在子任务实施上下文中列出两项 superseded decision。

### I8. management chat caller 的 RPM 覆盖虽已决定，但测试计划没有逐一路径列出期望

**路径：**

- `.trellis/tasks/09-21-account-rpm-limits/prd.md`：Requirement 4 明确“实际 chat 管理测试”计 RPM。
- `.trellis/tasks/09-21-account-rpm-limits/design.md`：§6 列出 chat、probe/test/validate/account chat test，排除 models/quota。
- `.trellis/tasks/09-21-account-rpm-limits/implement.md`：只写“所有真实 chat management caller”和“全 caller 审计”，未形成逐 route 验收表。
- `.trellis/tasks/09-21-upstream-diagnostics-account-limits-pool-keepalive/research/account-rpm-quota-pool.md`：已证明当前 `/api/accounts/test`、catalog、quota 等路径并不都经过 lease。

这是共享 transport 的高风险改动。建议在计划中将 `/api/test`、`/api/probe`、`/api/validate-upstreams`、`/api/accounts/test` 逐项列成“真实 `/chat/completions` attempt 必须 permit”，并把 models/catalog/quota/proxy-test 明确列成“不计”，防止只迁移现有 lease callers 后误报完成。

---

## 建议

### S1. 给每个子任务列出必须更新的精确 spec 路径，而不是只写“相关 spec”

当前 specs 正确描述的是现状，实施后必然需要同步。建议至少明确：

- error detail/log performance：
  - `.trellis/spec/backend/logging-guidelines.md`
  - `.trellis/spec/backend/database-guidelines.md`
  - `.trellis/spec/backend/error-handling.md`
  - `.trellis/spec/backend/quality-guidelines.md`
  - `.trellis/spec/frontend/state-management.md`
  - `.trellis/spec/frontend/quality-guidelines.md`
- RPM：
  - `.trellis/spec/backend/database-guidelines.md`
  - `.trellis/spec/backend/quality-guidelines.md`
  - `.trellis/spec/frontend/state-management.md`
  - `.trellis/spec/frontend/quality-guidelines.md`
- dynamic + low quota：
  - `.trellis/spec/backend/database-guidelines.md`
  - `.trellis/spec/backend/quality-guidelines.md`
  - `.trellis/spec/backend/logging-guidelines.md`
  - `.trellis/spec/frontend/state-management.md`
  - `.trellis/spec/frontend/quality-guidelines.md`
- keep-alive/env：
  - `.trellis/spec/backend/quality-guidelines.md`
  - `.trellis/spec/backend/error-handling.md`
  - `.trellis/spec/backend/database-guidelines.md`（其中维护 runtime environment key 清单）
  - 如新 env 会影响生产运维，再更新 `.trellis/spec/backend/deployment-guidelines.md`。

所有永久 spec 继续使用英文，符合 indexes 的语言合同。

### S2. 明确 quota-exhausted reconciliation 适用于所有 fresh 100% 账号，而非仅 waiting-refresh 的 low 账号

父任务 R3 的文字是“任一有效额度窗口达到 100%”即进入持久化 exhausted。`.trellis/tasks/09-21-low-quota-pool-refresh-cooling/design.md` §6 看起来支持全局 reconciliation，但实现步骤与前文主要围绕 low hold，容易被误读为只有先进入 waiting-refresh 才会转 exhausted。建议在测试矩阵增加：一个从未发生 chat failure 的 high/low/standby 账号，仅由 fresh quota refresh 观测到 100%，也必须进入 exhausted；恢复同样只由 refresh 确认。

### S3. 为新配置字段补充“旧客户端省略字段”矩阵

`maxRpm` 已明确按 stable ID 保留；`cachePoolMaxSize` 和 `cachePoolLowQuotaSize` 也应分别写清：

- 启动读取旧文件的 missing default；
- 旧客户端 POST 完整 `accountPipeline` 但省略一个或两个新字段时，是保留 current 还是使用 legacy default；
- 新建配置/新 preset 的默认；
- operator 显式设 0 的语义；
- save/restart 后是否失去 missing-vs-explicit 信息。

这尤其关系 B1/B2（低槽兼容）能否实现。

### S4. keep-alive 的代理复用 AC 应允许按 agent 能力给出受支持矩阵

`.trellis/tasks/09-21-newapi-chat-keepalive/design.md` §1 已要求先验证锁定的 proxy-agent API；PRD AC2 则笼统要求“受支持代理”复用连接/隧道。建议在实现前冻结当前依赖下 HTTP、HTTPS CONNECT、SOCKS5、SOCKS5H 哪些必须复用同一 socket/tunnel，并明确无法由 agent 保证的协议不能用不稳定 timing 断言。无论是否复用，坏代理绝不直连仍是硬门禁。

---

## 已确认一致、无需调整的部分

1. **用户关键决策总体已写入最终合同：**
   - RPM 按每个真实 Cline Chat HTTP attempt，而非 lease admission；Provider retry 分别计数。
   - RPM 是进程内滚动 60 秒，重启清空、多副本独立。
   - 并发检查先于 RPM，首次 permit 预留后在真实发送前 commit，未发送可释放。
   - low 使用 warm（80%–<95%），reserve（>=95%）不进入常规池，unknown 与已知 0 分离。
   - low account failure 采用 quota-refresh-driven hold，不使用固定 cooldown 时长。
   - error detail 是独立默认关闭开关，复用 detailed store，不扩大 ordinary 敏感数据面。
   - New API 仅补 HTTP/1.1 Chat/SSE；不做 HTTP/2/h2c 入站、Realtime WebSocket 或 Responses API，也不修改 New API。

2. **父子边界和串行依赖清楚：**
   - error detail/logging 先提供 capture、queue、metadata finalization、shutdown owner；
   - RPM 随后修改 lease/attempt permit；
   - 09-20 dynamic 继续独占 min/max/persisted target/concurrency-only grow-one；
   - low-quota 只扩展同一 membership/quota-state owner；
   - keep-alive 最后接入同一 transport/shutdown owner。

3. **09-20 dynamic 未被重复：**
   - `.trellis/tasks/09-20-dynamic-cache-pool-growth/prd.md` 和 `design.md` 已显式把 high/low composition 留给 09-21；
   - 09-21 low task明确不复制 target、member table、waiter、quota queue 或 grow owner；
   - RPM-only 不 grow、只有 all-active finite concurrency-full 才 grow 的条件在父任务、RPM、dynamic 和 low-quota 四处一致。

4. **New API 证据与实现边界一致：**
   - 研究中的 shared HTTP pool、300 秒 scanner、comment-before-filter、普通 Chat 首响应前取消缺口均已在 child design 中正确反映；
   - child design 没有错误声称 switcher 能修复 New API 首响应前 context 缺口，而是用 first-event timeout 有界收敛。

5. **安全边界一致：**
   - ordinary JSONL 不保存 Header 值/body/credentials；
   - error-only/full 共用 redactor/store/retention/auth；
   - proxy failure 不回退直连；
   - diagnostic failure fail-open；
   - 测试限定临时 `DATA_DIR` 和本地 mock，不使用生产凭据或付费上游。
