# Implement — 全局出口代理池（手动 / FloppyData）

## 顺序

1. **`lib/proxy-pool.js`（纯逻辑）**
   - 实现 `normalizeProxyPool`（strict 模式，含 floppydata 子对象）、`entryIdFor` 和运行时。
   - 运行时接口：`pickEntry`（round-robin / random，支持 exclude、冷却、RPM 预留、提交、退还）、`replaceEntries`（保留同 URL 的条目状态，退役旧条目）、`release`、`noteThrottle` / `noteConnectFailure`、`hasAvailable`、`statusProjection`、`secretSeeds`。
   - 另实现 `parseRetryAfter`；把 `normalizeProxyUrl` 迁到这里共享。
   - 单测 `test/proxy-pool.test.js`：轮询顺序与跳过、随机覆盖、冷却到期、RPM、退役引用计数、去重与碰撞、上限、校验错误路径。
2. **`lib/floppydata-source.js`**
   - 实现：refresh（并发 8、单次超时、半数阈值、`session` 互不相同、401/402 提前终止）、调度与退避、start/stop/参数变更、balance、状态。
   - 单测 `test/floppydata-source.test.js`：注入假 fetch 与时钟。
3. **配置接线（server.js）**
   - 接入四处：`normalizeConfigAndMeta`、`POST /api/accounts`、`reloadConfigFromDisk`、`ACCOUNT_CONFIGURATION_FIELDS`。
   - 缺省时不写回；保存或热加载后调用 `applyProxyPoolConfig()`，负责 replaceEntries 和 source 的 start/stop。
   - 测试 `test/proxy-pool-config.test.js`：
     - 400 时文件字节不变；
     - SIGHUP 能开关、切换来源，非法配置被拒绝；
     - 旧配置字节不变；
     - revision 冲突返回 409。
4. **Transport**
   - 实现 `resolveEgress`（含 poolFallback）、池 agent 生命周期、free-socket 超时、连接阶段识别与 `connectTimeoutMs`、`clineRequest` 内的健康上报与 release、返回值带 `egress`（url 不可枚举）、详细日志传入实际 URL。
   - **门禁 A**：池未开启时 `npm test` 全绿，证明默认零行为变化。
5. **聊天链路**
   - `egressHint` 透传；新增 `egressStep`；pool attempt 跳过账号级 gateway 退避。
   - `settleAttempt` 增加池条目连接失败的归因；最终返回 429 并带 Retry-After。
   - 11 处归因改为 `egressOrigin`。
6. **其他路径**：额度 job 不再传 `job.proxyUrl`；`catalog()` 改走 `clineRequestJSON`（D7）。
7. **日志、统计、脱敏**
   - trace、请求行、错误行增加 `egress` / `poolFallback`；`proxyHealth` 按实际出口归属。
   - 新增 `configuredEgressSecrets()`（含 retiring 条目和 apiKey），替换 6 处种子来源。
   - `DetailRedactor` 调整上限和种子策略，补性能单测。
8. **管理 API**：`GET`/`POST /api/accounts` 增加 `proxyPool`；新增 `/api/proxy-pool/status`、`/refresh`、`/balance`、`/test`。
9. **控制台**
   - 代理池卡片：开关、策略、来源；手动来源的掩码列表与编辑；FloppyData 表单、刷新、余额；状态表。
   - 账号徽标与抽屉提示。
   - 更新 `ui-contract`、`account-draft` 测试。
10. **集成测试 `test/proxy-pool.integration.test.js`**（对应 AC2～AC12）
    - **假上游**：本地 http server，`upstreamBase` 指向它；可按入口代理返回 200 SSE、非流 JSON 或 HTML 429。
    - **假代理**：
      - `net` 实现的 SOCKS5，支持无认证和 RFC1929 两种；
      - `http` 实现的 CONNECT，支持 407/Basic；
      - 多实例；外加一个"已关闭端口"条目；
      - 另起一个"账号自带代理"实例，用来断言开启时它不被使用、回退时被使用。
    - **假 FloppyData API**：本地 http server，`apiBase` 指向它。按请求体的 `session` 生成 `socks5://user-test-session-<session>:pass-test@127.0.0.1:<假 SOCKS 端口>`，让每个会话映射到某个假代理实例。可脚本化返回 401/402/500/部分失败。
    - **流量归属判定**：代理记录出站连接的 `localPort`，上游用 `req.socket.remotePort` 反查经过的代理；查不到的视为 `direct`。
    - **刷新间隔**：用最小值 60000ms 太慢，所以通过 `POST /api/proxy-pool/refresh` 手动触发换批，验证换批语义与"旧 SSE 流不中断"；定时调度由第 2 步的单测（假时钟）覆盖。
    - **冷却**：参数取最小值 1000ms，测试中真实等待。
    - **泄漏检查**：凭据只用占位值。断言日志文件、日志 API、`metadata.json`、错误体、`/api/proxy-pool/*` 中都不含这些占位凭据和假 apiKey。
    - **AC12**：用 `git show HEAD:server.js` 等旧版本文件，在临时目录启动，加载新 config 与 metadata。
11. **文档与 spec**
    - `README.md` 的配置表增加 `proxyPool`，并加一段 FloppyData 使用说明，写明流量计费提醒。README 里有用户未提交的改动，只追加本任务段落，提交时用 `git add -p` 只暂存本任务的 hunk。
    - spec 更新：
      - `quality-guidelines.md`：出口选择、回退规则、HTML 429 换代理；
      - `database-guidelines.md`：`proxyPool` 契约，FloppyData 条目不落盘；
      - `logging-guidelines.md`：`egress` / `poolFallback`、动态脱敏种子；
      - `error-handling.md`：池条目失败归因、不在同一 attempt 内直连；
      - `deployment-guidelines.md`：`ulimit`、FloppyData 出站访问、回滚说明。

## 验证命令

```bash
node --check server.js lib/proxy-pool.js lib/floppydata-source.js
node --test test/proxy-pool.test.js test/floppydata-source.test.js
node --test test/proxy-pool-config.test.js test/proxy-pool.integration.test.js
env -u CLINE_PASS_KEY -u CLINE_PASS_UPSTREAM_BASE npm test
git diff --check
git diff --cached | grep -nE 'socks5h?://[^ <"]*:[^ <"]*@|X-Api-Key: [A-Za-z0-9_]{20,}'   # 只允许占位符
```

## Review gates

- 第 4 步后（门禁 A）：池未开启时 `npm test` 全绿。
- 第 5 步后：`test/workflow-integration.test.js` 中 HTML 429 的断言在关闭模式和回退模式下都保持不变。
- 第 10 步后：dispatch trellis-check 做全量检查，重点是凭据和 apiKey 泄漏、兼容性（旧配置字节、metadata、旧镜像能否启动）。
- 上线前，**经用户同意**做一次真实冒烟：在生产或预发环境配置 FloppyData（apiKey 只写入运行时的 config.json），观察一批导入、几十个真实请求的 egress 分布、HTML 429 是否消失，以及流量消耗。不进入自动化测试。

## 风险与回滚点

- **高风险位置**：`clineRequest`（4198）、`runChatChain` 的 attempt 循环（5612-5770）、`settleAttempt`（5499）。每完成一个阶段跑一次全量测试。
- **本地排查**：用 `git diff` 定位问题；不要用 `git checkout` 覆盖用户在 README / AGENTS 上的改动。
- **生产回退**：关闭开关（立即生效，FloppyData 调度随之停止），或回退镜像（design §13）。

## 提交范围

- **只提交本任务的文件**：
  - `lib/proxy-pool.js`、`lib/floppydata-source.js`、`server.js`、`lib/detailed-log-capture.js`、`public/index.html`；
  - 新增或修改的测试；
  - spec；
  - 本任务目录；
  - README 中属于本任务的 hunk。
- **不提交**：AGENTS.md 中用户新增的那一行；README 中与本任务无关的 hunk。
- **FloppyData apiKey 只存在于运行时 config.json**（已被 gitignore），绝不进入任何提交。
- `docs/upstream-ip-rate-limit-findings.md` 是否提交，询问用户。
- 提交后按 AGENTS.md 推送到 `main`。
