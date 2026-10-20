# 代理池按客户端密钥开关

## Goal

现在代理池是全局开关：开启后，所有客户端密钥名下账号的上游调用都走代理池。本任务让运营者可以**按客户端密钥**决定是否使用代理池。例如只让某个用户的流量走住宅代理，以控制流量费用；其他用户继续用各自账号原有的出口。

采用方案 A：仍然只有一个全局池（手动或 FloppyData），每个客户端密钥可选"跟随默认 / 使用 / 不使用"。用户于 2026-10-21 选择该方案。"密钥"指客户端密钥 `clientKeys`（含 Legacy），不是账号的上游 key。

## Background（代码已确认）

- 每个账号有 `clientKeyId`，缺省为 `'legacy'`，归属是独占的。所有带账号的上游调用都在 `resolveEgress(account, …)` 里决定出口（`server.js:4318`），因此可以按 `account.clientKeyId` 判断是否走池。聊天、额度刷新、探测、校验、目录拉取都经过这里。
- `clientKeys` 每一行被严格校验为只含 `id`、`key`、`name` 三个字段（`server.js:172-187`），并且它是只能重启生效的字段（`RESTART_ONLY_CONFIG_FIELDS`）。如果在行上加字段，旧镜像会启动失败。
- 线上 68c6158 的 `normalizeProxyPool` 在 strict 模式下会拒绝 `proxyPool` 里的未知字段。如果往 `proxyPool` 里加字段，回滚到 68c6158 时会启动失败。旧镜像会原样保留未知的**顶层**字段，只是不使用它（`server.js:162`）。
- 聊天链路中 `poolEgressExpected()`（`server.js:5945`）只看全局开关，用来决定是否跳过账号级 HTML-429 退避。改成按密钥生效后，这里也必须按账号归属判断。
- 删除客户端密钥前，它名下必须没有账号（`server.js:7088`），删除接口单独写 config。

## Requirements

### R1 配置

- 新增顶层字段 `proxyPoolClientKeys`：
  ```jsonc
  { "default": "on" | "off",              // 未单独设置的密钥是否使用代理池；缺省 "on"（等同现状）
    "overrides": { "<clientKeyId>": "on" | "off" } }  // 键为 'legacy' 或现有 clientKeys 的 id
  ```
- 字段缺省时等同 `{ default: "on", overrides: {} }`，行为与现在完全一致；启动时不补写，以保证 config 字节不变。
- 严格校验（启动、`POST /api/accounts`、SIGHUP 热加载三处一致）：
  - `default` 只能取上述两个值；
  - `overrides` 的键必须是存在的密钥 id（含 `legacy`），值只能是 on 或 off；
  - 不允许出现其他字段。
  - 非法时：启动失败、接口返回 400、热加载拒绝，三种情况都不改文件。
- `POST /api/accounts` 省略该字段时保留现值；它纳入 `configurationRevision`，冲突返回 409；支持热加载。
- 删除客户端密钥时，同一次写盘里删掉它的 override。

### R2 生效规则

- 某账号"使用代理池"的条件：`proxyPool.enabled` 为真，且该账号所属密钥的有效设置为 on。有效设置 = 该密钥的 override，没有 override 时取 `default`。
- 账号使用代理池时，行为与现在完全相同：选池条目、冷却、换代理重试、无可用条目时回退账号原出口（poolFallback）。
- 账号不使用代理池时，行为与"全局关闭"完全相同：走账号的 `proxyUrl` 或直连，按账号做 HTML-429 退避并在同一出口重试，不记 poolFallback，也不计入池的回退次数。
- 聊天链路"是否跳过账号级退避"的判断，改为看当前账号是否使用代理池。
- `/api/accounts/proxy-test`（显式 URL）不受影响。`/api/proxy-pool/test` 是池级诊断，与密钥无关，不受影响。
- **FloppyData 导入条件**：`enabled` 为真，且至少有一个密钥的有效设置为 on。如果所有密钥都是 off，就停止定时导入，并让现有条目退役，避免空耗 API 调用。手动来源的条目照常加载，不产生费用。

### R3 管理接口与控制台

- `GET /api/accounts` 返回 `proxyPoolClientKeys`，字段缺省时返回默认对象。
- `GET /api/proxy-pool/status` 增加 `clientKeys: [{ id, name, mode: 'default'|'on'|'off', effective: boolean }]`，其中 `effective` 表示该密钥名下的账号此刻是否走池。只给 id、名称和枚举值，不含密钥值。
- 控制台"代理池"卡片新增"按客户端密钥"小节：
  - 一个"未单独设置的密钥"下拉框（使用 / 不使用）；
  - 每个密钥一行（Legacy + 各 clientKeys 名称），下拉框为"跟随默认 / 使用 / 不使用"，并显示当前是否生效。
- 随"保存账号配置"一起保存。
- 账号列表的"代理池"出口徽标只显示在所属密钥实际生效的账号上。

### R4 兼容与安全

- 不改 `clientKeys` 行结构，不改 `proxyPool` 结构，metadata 结构也不变。
- 旧镜像（68c6158 及更早）保留但忽略新字段：回滚后回到"全局开关"语义，不会启动失败。
- 现有日志字段（`egress`、`poolFallback`）不变。不使用池的密钥的请求记为 `direct` 或 `account-proxy`，不记 poolFallback。

## Acceptance Criteria

- [ ] AC1：配置中没有 `proxyPoolClientKeys` 时，所有现有测试通过，config 字节不变，行为与 68c6158 一致。
- [ ] AC2：两个密钥 A、B，池已开启，`default: off`、`overrides: { A: on }`：A 名下账号的请求走池条目；B 名下账号的请求走 B 账号自己的代理或直连，`poolFallback` 为 false，池的请求计数不增加。
- [ ] AC3：`default: on`、`overrides: { B: off }`：A 走池，B 不走池。改为 `default: off` 且没有 override 时，FloppyData 停止导入，池条目退役；之后再把 A 设为 on，会立即重新导入。
- [ ] AC4：B 不走池时，遇到 HTML 429 保持原有行为：按账号退避，在同一出口重试 1 次。A 走池时，HTML 429 换代理重试，不做账号退避。
- [ ] AC5：A 走池时，额度刷新和探测也经过池；B 的这些调用不经过池。
- [ ] AC6：以下非法输入在 `POST /api/accounts` 和热加载中都被拒绝，文件字节不变：未知密钥 id、非法取值、多余字段。合法修改可以通过 SIGHUP 生效。删除一个密钥后，它的 override 被同时删除。
- [ ] AC7：`/api/proxy-pool/status` 的 `clientKeys` 正确反映 mode 和 effective，并且不含任何密钥值。
- [ ] AC8：控制台能设置默认值和每个密钥的模式、显示是否生效，保存后持久化；徽标只出现在生效的账号上。UI 契约测试覆盖这些。
- [ ] AC9：用 68c6158（旧镜像）启动带 `proxyPoolClientKeys` 的配置能成功，并且保存后该字段被保留。

## Out of Scope

- 每个密钥使用不同的池（方案 B）。
- 按账号单独设置是否使用代理池。
- 按密钥统计池的流量消耗。
