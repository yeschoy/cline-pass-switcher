# 缓存命中优先调度：实施计划

> 本计划只修改本仓库并运行本地测试；不得修改 NewAPI/CPA，不得写生产配置、重启或部署。工作区原有 `untitled.md` 删除不属于本任务，禁止纳入或恢复。

## 1. 建立聚焦回归测试

- [x] 在 `test/integration.test.js` 增加缓存活跃池测试场景，先证明当前代码不满足新契约。
- [x] 覆盖配置缺失默认 0、保存/重启 round trip、老客户端省略字段保留、非法/未知字段拒绝且文件字节不变。
- [x] 扩展现有“全关闭流水线等价”测试，证明 `cachePoolSize=0` 对六种账号模式、四步排列和容量行为无变化。
- [x] 增加 priority/id 稳定选池、soft 状态不重排、hard 状态补位、同会话稳定、standby 不接普通请求的测试。
- [x] 增加两个 active 满载、等待、active 内回退、超时 standby、无 standby 429、租约归零和安全日志字段测试。

验证：

```bash
node --test --test-name-pattern='cache pool|pipeline order|legacy pipeline' test/integration.test.js
```

回滚点：只有测试差异，无运行时代码变化。

## 2. 扩展持久化与 API 契约

- [x] 在 `DEFAULT_CONFIG.accountPipeline` 增加 `cachePoolSize: 0`。
- [x] 扩展 `normalizeAccountPipeline()`：启动迁移、严格整数范围、未知字段拒绝、老客户端省略时保留当前值。
- [x] 保持 `order` 为现有四步精确排列，不新增第五个步骤。
- [x] 更新 `/api/accounts` GET/POST 完整 round trip；所有校验必须发生在配置/元数据修改和文件写入前。
- [x] 用统一 `quotaRoutingEnabled()` 让 `quotaPool || cachePoolEnabled()` 复用现有额度 job/pump/epoch；正数池值在非 sticky 模式且无 sticky 步骤时保持休眠，模式/步骤关闭必须撤销旧 routing epoch；不得新增刷新队列或聊天路径 I/O。
- [x] 确保账号全量保存、quota routing epoch、账号 generation 和既有字段不受影响。

验证：

```bash
node --check server.js
node --test --test-name-pattern='cache pool configuration|account API|pipeline order' test/integration.test.js
```

回滚点：删除单个默认/规范化/API 字段即可恢复旧 schema；临时 `DATA_DIR` 测试必须证明旧文件字节保护。

## 3. 实现稳定活跃池选择

- [x] 在现有 `buildPipelineGroups()` 数据流内复用 `healthProjection()`、`quotaProjection()` 和账号 `priority`，不新增第二个账号状态所有者。
- [x] 选池资格：基础 eligibility 后排除明确 unhealthy 和 reserve；available/insufficient/degraded 与 hot/warm/unknown 保持可选。
- [x] 按 priority 升序、stable account ID 字典序选前 N；不得使用名称、Key、activeCount 或瞬时百分比做并列排序。
- [x] 将候选投影为 active/standby tier；在 active 内复用现有 HRW，无身份时复用现有模式排序。
- [x] `pipelineEnabled()` 在缓存池有效时进入现有 pipeline owner；正数 size 配置在非 sticky 模式且无 sticky 步骤时休眠；`cachePoolSize=0` 且四开关全关时直接走原 legacy 逻辑，不运行新分区。
- [x] 复核所有 `buildPipelineGroups()` / `acquirePipelineAccountLease()` 调用方以及 provider/account failover 边界。

验证：

```bash
node --test --test-name-pattern='cache pool selection|pipeline permutations|quota health pipeline|quota refresh' test/integration.test.js
```

回滚点：新选池分支由有效的 `cachePoolSize > 0` 单点控制；关闭配置或移除 sticky 有效条件立即恢复旧选择路径。

## 4. 接入容量等待与备用溢出

- [x] 复用 `tryLease()`、`waitForCapacity()` 和同一全局 deadline；不创建新队列或计数器。
- [x] 有容量时先尝试 active；一个 active 满载可使用另一个 active。
- [x] 至少存在 active 且全部 active 满载时等待 `concurrencyWaitMs` 并在通知后完整重算；hard state 导致零 active 时立即尝试 standby，容量等待超时后才处理普通 standby 溢出。
- [x] `allowOverflow=false` 时禁止 standby；无容量/无账号保留原 429/503 与 `Retry-After`。
- [x] 流式、取消、上游错误、账号 action 换号和普通完成均保持一次且仅一次 lease release。

验证：

```bash
node --test --test-name-pattern='cache pool capacity|client cancellation|stream' test/integration.test.js
```

回滚点：只撤销 cache-pool 专用 acquire 分支；不得改写 legacy lease 生命周期。

## 5. 增加安全诊断与管理投影

- [x] 在统一选择结果中增加 bounded cache tier/size/fallback 事实。
- [x] 扩展普通 request JSONL：`cachePoolSize`、`cachePoolTier`、`cachePoolFallback`；使用稳定选择原因枚举。
- [x] 保留 `overflow`、`capacityFallback`、preferred/selected 现有含义。
- [x] `/api/accounts` 只增加运行时 `cachePoolRole` 投影；不得持久化或由前端回写。
- [x] 对日志、API、metadata 和浏览器状态执行敏感字段检查，禁止原始会话/HMAC/候选列表/Key/代理/Header 值/正文。

验证：

```bash
node --test --test-name-pattern='cache pool diagnostics|sensitive|logs' test/integration.test.js
```

回滚点：诊断字段为向后兼容新增；删除投影不影响选择和持久化。

## 6. 更新控制台配置与预设

- [x] 在账号调度区域增加带 label/help/min/max/step 的 `cachePoolSize` 数字输入，0 表示关闭。
- [x] `loadAll()`、`collectAccounts()`、完整保存和 ACCS snapshot 使用同一字段所有者；视觉保存必须拒绝空值/小数/越界值而不是经 `Number()` 破坏性归零；不得复制账号 store。
- [x] 原始调度 JSON 精确 schema 加入 `accountPipeline.cachePoolSize`，保留 stale/cancel/focus/草稿语义。
- [x] 增加“缓存命中优先”预设：sticky、池大小 2、等待 5000 ms、可预览 priority；取消不修改，确认仍走完整账号保存。
- [x] 账号状态安全显示 active/standby；任意服务器文本继续 escape/textContent。
- [x] 更新帮助文本，说明 priority、hard replacement、standby overflow 和生产指标不保证。

验证：

```bash
node --test test/account-draft.test.js test/ui-contract.test.js
```

手工浏览器证据（实现后执行，不可由 VM 测试冒充）：

- [x] 键盘访问数字输入、预设预览/取消/确认、原始配置 dialog；
- [x] 390px 窄屏与桌面宽屏无不可达控件；
- [x] focus 返回、aria-live、长账号名和 active/standby 文本可读；
- [x] 预设取消后账号、priority、pipeline 和等待草稿完全不变。

回滚点：移除单个输入/预设和对应投影；账号完整保存必须始终保留隐藏字段。

## 7. 完整质量检查

- [x] 运行 backend/frontend 聚焦测试。
- [x] 运行运行时语法检查和完整测试套件，取消真实凭据/地址环境覆盖。
- [x] 检查完整 diff、敏感信息、无关文件和空白错误。
- [x] 运行 Trellis `trellis-check` 流程并修复所有当前任务范围内问题。

```bash
node --check server.js
env -u DATA_DIR -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT -u BIND_HOST npm test
git diff --check
git status --short
```

质量门禁：

- `untitled.md` 的原有删除保持用户状态，不纳入任务说明或提交；
- 不出现 NewAPI/CPA/生产数据修改；
- 不新增依赖、模块、持久化会话表或第二套调度队列；
- 所有临时测试数据仅位于测试临时目录。

## 8. 文档、复核与后续生产计划

- [x] 根据最终实现更新 backend/frontend spec 的配置、路由、日志和 UI 契约；只记录已验证行为。
- [x] PRD convergence 复核需求、设计、测试和 rollout 指标无冲突。
- [x] 向用户展示代码结果、测试证据和仍不可证明的 70% 生产目标。
- [x] 未获单独部署批准时停止；不得修改生产配置或执行发布。

后续另行审批的 rollout/rollback：

1. 保存配置哈希与基线；选择两个健康、非 reserve、priority 最低账号。
2. 设置 sticky、cache pool 2、wait 5000 ms；自然预热单独报告。
3. 观察 24 小时且至少 1,000 个明确 cache 样本。
4. 命中率未达 70% 但护栏正常时只报告未达标，不自动改单账号池。
5. 任一护栏失败，恢复 `cachePoolSize=0`、旧 priority 和旧 wait。
