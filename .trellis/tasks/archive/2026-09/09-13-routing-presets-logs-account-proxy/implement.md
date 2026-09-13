# 实施计划

## 0. 前置基线与范围隔离

- [ ] 先完成当前 `cpa-cline-routing-integration` 的最终检查、spec 更新和独立提交；确认 `server.js`、`test/integration.test.js`、旧任务 spec 不再是未提交状态。
- [ ] 读取本任务 `prd.md`、`design.md`、research 和 manifests 中全部规范。
- [ ] 备份本机实际 `DATA_DIR/config.json`、`metadata.json` 和 logs（如存在）；测试只使用临时目录。
- [ ] 运行 `node --check server.js && npm test && git diff --check` 建立干净基线。
- [ ] 不修改其他仓库、部署拓扑或 SSH 密钥文件。

阻断条件：前序任务未单独提交时，不开始本任务代码实现，避免两个任务无法独立回滚。

## 1. 依赖与统一配置契约

- [ ] 添加并锁定 `https-proxy-agent@7.0.6`、`socks-proxy-agent@8.0.5`，保留 Node >=18。
- [ ] 扩展账号默认/规范化字段：`note/weight/priority/proxyUrl/headers`；扩展 `accountMode` 和 `modelAliases`。
- [ ] 集中实现备注、权重、优先级、代理 URL、自定义 Header、模型别名校验，启动迁移宽容、管理 API 严格。
- [ ] 更新完整账号保存，确保隐藏的 `id/perModel/note/proxyUrl/headers/weight/priority` 不因 UI 保存丢失。
- [ ] 增加非法配置、控制字符、危险 Header、代理认证和别名冲突的“不写盘”回归。

验证点：无新字段的旧配置启动后行为不变；失败请求保持磁盘原字节。

## 2. 调度器与可解释选择

- [ ] 把所有模式返回值统一为带 `strategy/preferred/selected/reason/overflow/sessionSource` 的选择结果。
- [ ] 保持 `single/roundrobin/sticky` 现有语义和 HRW 最小重映射。
- [ ] 实现 `least-connections`，最小 activeCount 并列稳定轮询。
- [ ] 实现 `weighted-roundrobin`，按当前有容量候选权重分桶，跳过不可用/满载账号。
- [ ] 实现 `priority-failover`，最低 priority 优先、同级轮询、满载立即降级。
- [ ] 新三种模式仅在全部候选满载时等待；容量通知后重新计算候选。
- [ ] 账号恢复/解封/启用后重新入池；配置保存重置必要的非持久游标。
- [ ] 将账号动作换号纳入 selection reason，供应商普通重试保持同账号。

验证点：比例、并列公平、优先级降级/恢复、满载等待、冷却/封禁/恢复、租约最终归零。

## 3. 账号 Header 与代理传输

- [ ] 扩充统一禁止 Header 集合并实现账号 Header 规范化；名称大小写去重。
- [ ] 在会话识别完成后合并账号 Header，最后强制 Content-Type 与 Authorization。
- [ ] 根据账号 `proxyUrl` 构造/缓存 HTTPS 或 SOCKS Agent；空 URL 保持 `agent` 缺省。
- [ ] 让账号 chat、探测、校验和代理测试统一走账号传输；公共抓取保持直连。
- [ ] 配置变更使对应 Agent 缓存失效；代理失败不重试直连。
- [ ] 增加 `/api/accounts/proxy-test`，草案 URL不回显凭据。
- [ ] 将代理失败分类为 `proxy`/`network` 并经过统一脱敏后进入 trace、账号规则和错误日志。

验证点：本地 mock HTTP CONNECT、HTTPS CONNECT、SOCKS5/SOCKS5H 分别观察真实代理链路；坏代理无直连请求；Header 允许项生效、禁止项无法保存/覆盖、值不进日志。

## 4. 模型别名

- [ ] 增加唯一 `resolveModelAlias()`，保留 requestedModel 并生成 resolvedModel。
- [ ] 出站 body 使用 resolvedModel；全局/账号 `perModel` 与供应商元数据按 resolvedModel 查找。
- [ ] 增加 `GET/POST /api/model-aliases`，后端完整校验目标存在和冲突。
- [ ] `/v1/models` 返回原始模型与别名去重并集。
- [ ] `/api/test` 和诊断路径使用相同解析规则，避免生产/测试语义漂移。

验证点：无映射兼容、映射改写、原始模型仍可用、无链式映射、冲突不保存、日志同时记录两个模型名。

## 5. 滚动 JSONL 日志存储

- [ ] 将非业务相关的分段追加/查询/清理实现为小型 `lib/jsonl-log-store.js`（或同等单一模块），构造参数允许测试使用小限制，生产使用 PRD 固定默认值。
- [ ] 实现串行追加、5 MiB 分段、崩溃尾行容错、启动/每 100 条整理和边界分段原子重写。
- [ ] 严格执行 30 天、50,000/10,000 条和总计 100 MiB；清理顺序从最旧记录开始。
- [ ] 实现从新到旧过滤与不透明 cursor 分页；限制 limit、时间和字符串过滤输入。
- [ ] 实现按类型清空且不影响另一类日志。
- [ ] 保留旧 metadata history 只读兼容，停止向其追加。

验证点：小限制单元测试可实际触发天数、条数、总字节、滚动、部分尾行、重启、分页和清空，无需在测试中制造真实 100 MiB。

## 6. 请求链观测与日志 API

- [ ] 每个请求生成内部 UUID，并通过 `X-Cline-Request-Id` 返回。
- [ ] 在统一请求上下文中累积账号选择、供应商尝试、代理/Header 名称、账号动作和最终状态，避免各路径重复造日志。
- [ ] 非流式、首包错误、流后错误、客户端断开和容量拒绝都只 finalize 一次请求日志。
- [ ] 每次真实上游/代理失败写错误记录并关联 requestId；原因先脱敏、再截断。
- [ ] 增加两类 `GET /api/logs/*` 和 `DELETE /api/logs/*`，沿用管理鉴权。
- [ ] 对日志对象做最终允许字段投影，不能直接序列化请求/响应/账号配置对象。
- [ ] 全库敏感值扫描测试覆盖 Key、代理用户名/密码、原始会话、消息、Authorization/Cookie/Header 值和备注。

验证点：sticky-primary/overflow、新三种策略、换号和供应商路径都可从单条请求日志解释；错误页可用 requestId 定位同一请求全部失败。

## 7. 控制台与预设

- [ ] 页面容器改为宽屏最高约 1800px，所有宽表使用横向滚动容器并保留窄屏边距。
- [ ] 重构账号主表为常用状态摘要；名称列至少适配常见邮箱且提供完整 title。
- [ ] 增加名称/备注搜索。
- [ ] 实现右侧账号设置抽屉：完整名称、备注、并发、权重、优先级、代理、Header、专属路由摘要/入口。
- [ ] 实现 dialog 语义、焦点进入/返回、Esc、键盘操作、未保存关闭确认和 `aria-live` 错误。
- [ ] 代理认证默认掩码并提供草案连通性测试；禁止 Header 在前端即时提示，后端仍重复校验。
- [ ] 实现六个预设的纯草案生成器、逐项 current -> next 预览、可编辑权重/优先级及确认后普通保存；取消不修改状态。
- [ ] 增加请求/错误日志独立视图、筛选、分页、详情和清空二次确认。
- [ ] 增加模型别名批量生成（去 `cline-pass/`、统一前后缀）、冲突提示、逐项编辑和一次性保存。
- [ ] 所有服务端文本先 escape，代理/Header/备注不得出现在日志 DOM。

验证点：刷新往返不丢隐藏字段；宽屏利用空间、窄屏可横向操作；抽屉无鼠标可操作；预设不越权修改 Key/代理/模型路由。

## 8. 示例、规范与文档

- [ ] 更新 `config.example.json` 展示安全默认值、三种新模式、账号高级字段和模型别名。
- [ ] 更新 README：预设、调度语义、日志 API/保留、安全边界、代理协议、账号 Header、备注、模型映射与迁移。
- [ ] 使用 `trellis-update-spec` 更新 backend persistence/quality/logging 和 frontend state/quality 的可执行契约。
- [ ] package 描述不再宣称“零依赖”。

## 9. 自动化与质量门

执行：

```bash
node --check server.js
node --check lib/jsonl-log-store.js   # 若创建
npm test
npm audit --omit=dev
npm pack --dry-run
git diff --check
```

- [ ] 原有 4 个集成测试全部通过。
- [ ] 新增调度、代理、Header、别名、日志存储和日志 API 回归。
- [ ] 用临时 DATA_DIR 重启验证配置与日志。
- [ ] 运行全范围 `trellis-check`，检查 PRD、设计、跨层往返、安全与依赖锁。
- [ ] 手工浏览器验证宽屏/窄屏、抽屉、预设、日志和模型映射。
- [ ] 部署前备份远程 data，创建不可变 release；健康失败回滚旧 compose。

## 高风险点与回滚

| 风险 | 控制与回滚 |
|---|---|
| 账号完整保存擦除隐藏字段 | 先稳定后端 schema/测试，再改 UI；所有账号快照保留全部字段 |
| 调度器在并发变化时不公平或超卖 | 复用同步 lease；算法只产候选顺序，租约仍由单一入口获取 |
| 代理凭据泄漏或坏代理回退直连 | Agent 仅由账号传输注入；错误统一 URL 脱敏；测试断言直连端零请求 |
| JSONL 清理丢新日志 | 单写队列、边界文件临时写 + rename；限制参数化单元测试 |
| SSE 多次 finalize | 延续幂等 finalizer，日志与 lease 共用一次性完成状态 |
| 模型映射绕过账号路由 | requested/resolved 分离；所有路由只使用 resolvedModel |
| 前序任务与本任务混合提交 | Phase 0 强制先提交前序三文件差异 |
