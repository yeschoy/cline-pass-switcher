# Cline `providerOptions` 403：对照实测与兼容修复

## 实测范围

用户明确授权后，于 **2026-11-07（首组请求开始于 10:01 UTC）** 从现有生产主机向已配置的 Cline 官方 `/api/v1/chat/completions` 发出最小对照请求。凭据仅在远端进程内读取、使用，没有复制到本地、命令参数或报告。未修改生产配置、运行镜像或账号状态。

请求为简短的“仅回复 OK”，`max_tokens: 1024`，避免小推理预算耗尽导致的假阴性。下表不包含 key、账号标识、原始模型正文或完整响应。

| 样本 | 模型 | 请求区别 | HTTP | 可见内容 / 结论 |
|---|---|---|---|---|
| A | `cline-pass/minimax-m3` | 配置中的 `gateway.only/order` | 403 | 拒绝客户端 `providerOptions` 路由 |
| A | 同上 | 不带 `providerOptions` | 429 | 月额度已用尽；该样本不能用于判定修复成功 |
| B（有已知剩余额度） | 同上 | 配置中的 `gateway.only/order` | 403 | 同样的路由拒绝 |
| B | 同上 | 不带 `providerOptions`，非流式 | **200** | 有可见内容，`finish_reason: stop`，约 0.84 秒 |
| B | 同上 | 只带 `providerOptions.openaiCompatible.strictJsonSchema: false` | 403 | 非 gateway 命名空间也被拒绝 |
| B | `cline-pass/glm-5.3-flash` | 顶层 `provider.only` | **200** | 有可见内容；只证明接受请求，未证明严格命中指定渠道 |
| B | `cline-pass/minimax-m3` | 不带 `providerOptions`，流式 | **200** | 有可见内容且完整 `[DONE]`，约 0.75 秒 |

B 的非流式成功响应记录了 132 个输入、15 个输出、147 个总 token，返回 `cost: 0.0000472`。其他成功请求也可能消耗少量额度；未合计缺失 usage 的请求。结果仅代表被测账号、模型、接口与当时时刻，不宣称所有模型或所有 key 都已经禁止路由。

## 修复契约

- 可选 `config.json.gatewayRoutingEnabled: boolean`。缺省时，官方 `api.cline.bot` 关闭；自建/兼容网关开启。显式布尔值覆盖此默认。不为旧文件自动新增字段，无额外配置迁移。
- 关闭时清除整个 `providerOptions`，而非只清 `gateway.only/order`。规划器/未知管道改为一次无目标的 `auto` 请求；直连保持顶层 `provider.only`。
- 规划器的旧配置渠道列表、排序、能力过滤、亲和提示不再代表生效的硬路由。显式排除、持久硬隔离或未到期冷却存在时，默认路由仍安全拒绝，不偷偷绕过；管理员需自行确认是否解除限制。
- 禁用规划器渠道校验/定时探测的实际请求，手动探测跳过假渠道负对照，结果保持 `unknown`，不把默认路由成功当作钉选证据。
- 此精确 403 归类为 `scope: request` / `evidence: client_provider_routing`，不再仅因状态码误判账号认证失败。真正的认证 403、显式错误规则、直连路由和兼容网关的原有行为保留。
- JSON 与 SSE 共用兼容决策；不通过失败后偷偷去除限制、重放成功内容或额外换号来“修复”。

## Bug Analysis: 上游路由契约变化

### 1. Root Cause Category

- **E — 隐式假设**：历史实测接受 `providerOptions` 被当作永久契约；所有 403 被默认归为账号认证失败。
- **B — 跨层契约**：计划、请求重写、探测、健康归因同时依赖该参数，不能只修客户端 extra body。

### 2. Why Fixes Failed

未部署过试错补丁。首个样本已无月额度，移除参数后仍有独立的 429，因此先换用有已知剩余额度的样本完成对照，未将这个 429 误认作移除参数无效。

### 3. Prevention Mechanisms

| 优先级 | 机制 | 状态 |
|---|---|---|
| P0 | 官方默认不再注入被拒绝的整个字段，同时保留显式兼容开关 | 已实现 |
| P0 | 请求类拒绝在通用 403 认证分类前精确识别；普通认证错误不变 | 已实现 |
| P0 | 本地模拟上游拒绝该字段，覆盖 JSON、SSE、原配置、热加载、健康与探测 | 已实现回归测试 |
| P1 | 保留真实响应证据，不把配置/探测成功冒充实际命中 | 已同步规范 |

### 4. Systematic Expansion

同一兼容边界覆盖客户端原有字段、服务端注入、手动负对照、渠道校验和定时探测。只改 `gateway.only` 会遗漏非路由命名空间；只停聊天注入会继续产生探测 403，甚至错误归因。

### 5. Knowledge Capture

已更新 README、示例配置、旧 DeepSeek 使用说明，以及后端质量、持久化、错误与日志规范。`test/gateway-routing-compat.test.js` 为可重复的本地回归证据；以上实测不是新版本已上线的证据。

## 本地验收

Node **v26.13.0**：新增/相关定向测试 14/14 通过，全量 `npm test` **675/675 通过**（约 125 秒）；`node --check server.js`、`node --check test/gateway-routing-compat.test.js` 与 `git diff --check` 通过。本轮未执行 Node 18 或生产容器运行验证，也未部署新版本。

全量首轮额外捕获到非法上游 URL 被新能力判断提前抛错、将既有 502 变成 500 的回归；已将非法 URL 的错误所有权保留给原生 transport，定向重跑确认未发送 RPM 预留仍释放，最终全量重跑通过。
