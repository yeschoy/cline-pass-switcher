# 当前 cline-pass-switcher 执行流证据

## 项目形态

- `package.json`：ESM、Node >=18、零第三方依赖，启动命令 `node server.js`。
- 后端集中在 `server.js`；前端集中在 `public/index.html`；配置与元数据分别写入 `DATA_DIR/config.json` 和 `DATA_DIR/metadata.json`。
- 当前仓库没有自动化测试脚本。

## 账号与供应商路径

- `server.js:27-29`：账号只有 `name/key/enabled`，模式只有 single/roundrobin。
- `server.js:106-122`：`pickAccount()` 每次调用独立选号；single 的活动账号不可用时回退第一个启用账号。
- `server.js:123-126`：Cline 请求只显式设置 JSON Content-Type 和账号 Authorization。
- `server.js:468` 附近：`injectPrefs()` 按模型管道注入供应商偏好：planner 使用 `providerOptions.gateway`，direct 使用 `provider`，未知管道两者同时注入。
- `server.js:513` 附近：`buildAttempts()` 将全局 `perModel[model]` 展开成有序供应商尝试。
- `server.js:533-538` 与 `server.js:569-575`：非流式与流式分支都在每个供应商尝试内部重新调用 `pickAccount()`，所以普通故障转移可能换号。
- `server.js:658-666`：`handleChat()` 只读取全局 `perModel[model]`，没有账号级覆盖。
- `server.js:819-842`：账号 GET/POST API 只读写名称、密钥、enabled、mode、active。
- `public/index.html:126` 和 `:670` 附近：已有账号表、模式选择、状态统计、测试/删除。
- `public/index.html:242` 和 `:540` 附近：已有模型上游优先级、排除、严格/优先和排序 UI，可复用为不同路由作用域。

## 错误与流式行为

- `server.js:438` 附近：`unwrap()` 将绝大多数 JSON 上游错误转换成 502，只为 “model not found” 使用 404。
- 非流式 `attemptOnce()` 没有保留 fetch Response 的真实 HTTP 状态后再交给规则层。
- 流式路径会先读首块区分真 SSE 与错误包；真 SSE 返回后立即向客户端写响应，之后不能安全重试。
- 流式 tap 在结束时回读供应商信息并写历史；容量限制接入后必须把账号租约持有到 end/error/客户端断开。
- 当前 trace/history 会保存短错误说明；新增账号状态前必须统一脱敏，不能保存账号 key、代理 key、原始会话或敏感响应正文。

## 兼容性注意

- 旧 `apiKey` 已有自动迁移到账号池的路径，必须保留。
- 全局 `perModel` 已有旧 `upstream` 到 `upstreams` 的迁移和兼容镜像。
- 源码注释称 `maxRetries` 已退役，但 README 仍把它列为配置。本任务已明确账号级整项覆盖包含最大重试数，因此实现必须给出单一、可测试的外层尝试语义，并避免与网关内部 `order` 混淆。
- `/api/*`、`/v1/*` 与聊天路径统一使用 proxyKey 鉴权；`/api/meta` 与静态首页例外。

## 传输层事实

此前本机 mock HTTP 测试确认 Node fetch 在未显式提供时仍会发送 `User-Agent: node`、`Accept-Language: *`、`Sec-Fetch-Mode: cors` 等默认 Header。由于产品要求“缺失值省略且不伪造客户端指纹”，Cline 客户端请求需要改用 Node `http`/`https` 标准库的可控传输；公共目录抓取无需变更。
