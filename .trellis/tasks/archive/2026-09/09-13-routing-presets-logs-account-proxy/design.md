# 调度预设、可观测日志与账号代理：技术设计

## 1. 范围、依赖与实施边界

该任务延续已部署的账号路由实现，继续使用单 Node 服务、`config.json`、`metadata.json` 和静态控制台。调度、日志、账号代理/请求头、模型别名都穿过同一条 `handleChat -> acquireAccountLease -> runChatChain -> clineRequest` 链路，并共享账号保存 API，因此作为一个原子任务分阶段实施，不拆成会产生中间契约不兼容的并行子任务。

前置依赖：当前 `cpa-cline-routing-integration` 的未提交修复必须先完成质量检查并单独提交；本任务不得把该三文件差异混入后续提交。

不修改 NewAPI、CPA、部署拓扑或其他仓库。不实现自适应评分、RPM、消息正文日志、指纹伪造。

## 2. 静态配置契约

### 2.1 账号与调度

```js
{
  accountMode: "single" | "roundrobin" | "sticky" |
               "least-connections" | "weighted-roundrobin" | "priority-failover",
  accounts: [{
    id, name, note, key, enabled,
    maxConcurrent, weight, priority,
    proxyUrl,
    headers,
    perModel
  }],
  modelAliases: { [clientAlias]: "cline-pass/<model>" }
}
```

默认与校验：

- `note`: 默认 `""`，最多 500 字符；允许 `\n`，拒绝 `\r` 及除换行外的 C0/DEL 控制字符。
- `weight`: 1～100 整数，默认 1。
- `priority`: 1～100 整数，默认 100；数值越小越优先。
- `proxyUrl`: 默认 `""`；非空时必须为 `http: | https: | socks5: | socks5h:`，总长不超过 2048，必须有 hostname/有效端口，不允许 query/hash，path 只能为空或 `/`；用户名/密码可选。
- `headers`: 默认 `{}`；最多 32 项，名称必须是 RFC token 且不超过 128 字符，值为不含控制字符的字符串且不超过 2048 字符，总序列化大小不超过 16 KiB。
- `modelAliases`: 默认 `{}`；最多 500 项。别名与目标均为 1～300 字符、无控制字符；目标必须以 `cline-pass/` 开头并存在于 `knownModels`；别名不得与原始模型 ID 冲突或重复。

启动迁移只补默认字段，旧账号和旧三种模式保持原行为。管理 API 严格拒绝非法输入且失败时不写文件。

### 2.2 自定义 Header 禁止集合

禁止项大小写不敏感，包含：

- `Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie`、`Host`、`Content-Length`；
- 所有逐跳 Header；
- 当前 Codex/Claude/通用会话、线程、conversation、agent 身份 Header；
- Attestation、Installation ID；
- 名称中明确表示 API key、access token、secret、credential 或设备身份的字段。

合并顺序：

```text
客户端协议白名单 Header
-> 账号 headers 覆盖同名安全字段
-> 强制 Content-Type
-> 强制账号 Authorization
```

会话识别在合并账号 Header 前完成；自定义 Header 不参与粘性身份提取。日志只记录通过校验且实际应用的 Header 名称。

## 3. 调度算法与选择解释

账号候选首先统一过滤空 Key、禁用、封禁、未到期冷却。容量候选再过滤 `maxConcurrent` 已满账号。

所有选号返回统一结果：

```js
{
  lease,
  strategy,
  preferredAccountId,
  preferredAccountName,
  selectedAccountId,
  selectedAccountName,
  reason,
  overflow,
  sessionSource
}
```

`reason` 使用稳定枚举而非自由文本：`single-selected`、`roundrobin-next`、`sticky-primary`、`sticky-overflow`、`sticky-no-identity-roundrobin`、`least-active`、`weighted-slot`、`priority-tier`、`replacement-after-account-action`。

算法：

- `least-connections`: 在有容量账号中选择最小 `activeCount`；并列账号按独立 RR 游标轮询。
- `weighted-roundrobin`: 对当前有容量候选按 `weight` 虚拟槽位轮转，常量候选集下一个完整周期严格符合权重比例；不可用账号不占槽位。
- `priority-failover`: 找有容量候选中的最小 `priority`，同一优先级按 RR 轮询。
- 新三种模式若有任一容量候选则立即租用；仅所有静态候选都满载时等待 `concurrencyWaitMs`，每次容量通知后重新计算候选。
- `sticky` 保留现有先等待 HRW 首选、再临时溢出的语义；旧模式不因新增策略改变。
- 账号冷却恢复、解封或重新启用后自然重新进入候选，不持久化调度游标。

账号错误导致的最多一次换号继续保留；换号原因写入选择解释，但供应商普通重试不换账号。

## 4. 预设

预设定义只存在于控制台代码中，不增加“当前预设”持久字段。选择预设后生成变更草案，逐项展示当前值与新值，用户确认后通过普通账号保存 API 原子持久化。

只允许修改 PRD 列出的六类字段。错误规则按状态码合并；未列字段保持不变。按额度预设在确认界面允许编辑权重，主备预设允许调整自动生成的优先级。取消确认不改变前端快照或服务器配置。

## 5. 模型别名

请求进入后先保留 `requestedModel`，再执行：

```js
resolvedModel = config.modelAliases[requestedModel] || requestedModel
```

粘性身份仍从原始请求提取；出站 body 的 `model` 改为 `resolvedModel`。账号 `perModel`、全局 `perModel`、供应商元数据与路由都按 `resolvedModel` 查找。请求/错误日志同时记录二者。

管理契约：

```text
GET  /api/model-aliases
  -> { aliases, targets }
POST /api/model-aliases
  <- { aliases }
  -> { ok, count }
```

批量生成在前端完成：从 `knownModels` 中筛选 `cline-pass/*`，默认去前缀，可加统一前缀/后缀；预览冲突后一次提交完整映射。后端重新执行全部校验。

`GET /v1/models` 返回原始可见模型和别名的去重并集；别名条目 `id` 为客户端别名，不暴露为另一种目标。原始模型继续存在以保持兼容。

## 6. 出站代理

新增固定版本运行依赖：

- `https-proxy-agent@7.0.6`
- `socks-proxy-agent@8.0.5`

两者支持项目 Node >=18。HTTP/HTTPS 代理使用 `HttpsProxyAgent`，SOCKS5/SOCKS5H 使用 `SocksProxyAgent`。按规范化代理 URL 缓存 Agent；配置保存后使变更账号对应缓存失效。未配置时不传 `agent`，保持直连。

只有携带具体账号的 Cline chat、探测、校验和账号连通性测试使用该账号代理。公共目录抓取、管理 API、本地健康检查不使用账号代理。配置代理后任何 DNS、CONNECT、TLS、认证或超时错误都作为 `proxy`/`network` 错误进入现有 trace、错误日志和账号规则，不再尝试直连。

管理端点：

```text
POST /api/accounts/proxy-test
  <- { accountId, proxyUrl? }
  -> { ok, proxyType, ms, status?, errorCategory?, reason? }
```

可用已保存 URL或抽屉中的草案 URL测试。响应和日志不得回显用户名、密码或完整代理 URL；测试向 Cline Pass 发送最小、非消息正文的受控请求。

## 7. 请求与错误日志

### 7.1 存储

日志位于：

```text
DATA_DIR/logs/requests-<segment>.jsonl
DATA_DIR/logs/errors-<segment>.jsonl
```

单进程追加使用串行 Promise 队列。分段达到 5 MiB 时滚动。启动时及每 100 次追加后整理：删除超过 30 天的记录/分段，再从最旧开始执行 50,000 请求、10,000 错误、两类总计 100 MiB 上限。清理通过写新临时文件并 rename 保留边界分段中的新记录；不完整尾行忽略。

旧 `metadata.history` 保留读取兼容但停止新增，不自动迁移。新 UI 只读新日志。

### 7.2 记录契约

每个代理请求生成内部 UUID `requestId`，响应通过 `X-Cline-Request-Id` 返回。不得把未经校验的客户端请求 ID作为内部主键。

请求记录包含：`ts/requestId/requestedModel/resolvedModel/stream/strategy/sessionSource/preferredAccountId/preferredAccountName/accountId/accountName/selectionReason/overflow/targetProviders/actualProvider/attempts/status/upstreamStatus/durationMs/accountActions/appliedHeaderNames/errorCategory`。

错误记录按失败的上游/代理尝试写入，包含：`ts/requestId/requestedModel/resolvedModel/accountId/accountName/attemptIndex/targetProvider/providerPath/status/upstreamStatus/category/reason/accountAction`。`reason` 统一脱敏、去换行并截断 200 字符。

禁止字段：账号 Key、代理 URL/用户名/密码、原始会话值、HMAC、消息正文、Cookie、Authorization、任意 Header 值、响应正文、备注。

### 7.3 查询 API

```text
GET /api/logs/requests?<filters>&limit=50&cursor=<opaque>
GET /api/logs/errors?<filters>&limit=50&cursor=<opaque>
DELETE /api/logs/requests
DELETE /api/logs/errors
```

`limit` 1～200。游标编码 `(ts, requestId, segment)`，从新到旧稳定分页。过滤字段严格白名单并限制长度；时间范围为整数时间戳。删除只作用于指定日志类型。所有端点沿用管理鉴权。

## 8. 控制台设计

- 页面宽度改为响应式 `min(100%, 1800px)`；外层保持安全边距。
- 每张表使用可横向滚动容器；窄屏不压缩到不可操作。
- 账号名称列给常见邮箱至少约 240px，并提供完整 `title`；主表移除 Key、备注全文及高级字段编辑。
- 统一右侧账号设置抽屉编辑完整名称、备注、并发、权重、优先级、代理和 Header，并展示专属模型路由入口。
- 抽屉使用 `role="dialog"`、标题关联、焦点进入/返回、Esc 关闭和未保存确认；动态错误使用 `aria-live`。
- 代理认证输入默认 password；列表只显示“直连/HTTP/HTTPS/SOCKS5”状态。
- 请求日志和错误日志使用独立视图，共享筛选栏、分页、详情展开和明确清空确认。
- 模型映射提供批量生成预览、冲突标记和完整映射编辑。

所有动态文本继续经过 HTML 转义，禁止将 Header 值、代理认证或备注渲染到日志详情。

## 9. 兼容、失败与回滚

- 缺少全部新字段的旧配置直接启动并使用默认值。
- 非法已有代理/映射不应被静默用于请求；启动规范化记录安全警告并禁用对应非法项，但不得覆盖无法解析的整个配置文件。
- 配置仍使用同目录临时文件 + rename。
- 日志写入失败不能中断代理响应；应输出不含敏感信息的服务级错误并继续，后续追加可恢复。
- 代理依赖安装或构建失败时不部署；锁文件必须提交。
- 部署沿用不可变 release 和健康失败自动回滚；`DATA_DIR` 先备份。旧镜像可读取含额外字段的配置并忽略它们，但回滚前应保留配置备份。

## 10. 验证矩阵

自动化至少覆盖：六种模式兼容/比例/优先级/容量恢复；预设草案不越界；配置严格校验与旧配置迁移；HTTP/HTTPS/SOCKS5/SOCKS5H 代理及禁止直连回退；Header 合并与禁止项；模型别名改写和 `/v1/models`；JSONL 重启、分页、筛选、清空、天数/条数/总容量清理；请求 ID关联与敏感信息扫描；SSE、断开和账号换号原行为。

手工验证：宽屏、窄屏、邮箱名称完整展示、抽屉焦点/未保存提示、代理掩码、预设变更预览、日志筛选和映射批量冲突。
