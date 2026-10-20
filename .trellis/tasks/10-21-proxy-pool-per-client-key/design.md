# Design — 代理池按客户端密钥开关

## 配置契约

```jsonc
// config.json 顶层；缺省 = { default: "on", overrides: {} }，且不写回
"proxyPoolClientKeys": { "default": "on", "overrides": { "ck_xxx": "off", "legacy": "on" } }
```

- `lib/proxy-pool.js` 新增 `normalizeProxyPoolClientKeys(value, { knownIds, strict = true })`：
  - 只接受 `default`、`overrides` 两个字段；`default` 只能是 `on` 或 `off`；`overrides` 必须是普通对象，键在 `knownIds` 中（`legacy` 加 `config.clientKeys[].id`），值只能是 `on` 或 `off`。
  - 报错信息只带字段路径或 id，不带任何密钥值。
- `PROXY_POOL_CLIENT_KEYS_OFF = { default: 'on', overrides: {} }`，`effectivePoolClientKeys()` 在字段缺省时返回它。
- **四处接线**（与 `proxyPool` 相同）：
  1. `normalizeConfigAndMeta`：字段存在时严格校验，缺省时不写回。
  2. `POST /api/accounts`：照 `proxyPoolPatch` 的写法，`undefined` 表示保留现值；文件里本来没有该字段、且提交的值等于默认值时，继续保持缺省。
  3. `reloadConfigFromDisk` 的 pick 和 next。
  4. `ACCOUNT_CONFIGURATION_FIELDS`：字段缺省时不参与 revision 计算，旧 revision 保持不变。
- **校验顺序**：`knownIds` 取本次请求或文件中的 `clientKeys`。`POST /api/accounts` 不能修改 clientKeys（它是 restart-only，有独立路由），所以 `knownIds` 取现值。
- **删除密钥路由**（7088）：构造 `next` 时，同时删掉 `proxyPoolClientKeys.overrides[id]`。如果删除后 overrides 为空、default 为 on，并且文件里本来没有该字段，就保持缺省。整个修改在同一次 `atomicWriteJson` 里完成。

## 生效判定

```js
function accountUsesProxyPool(account) {
  if (!effectiveProxyPool().enabled) return false;
  const scope = effectivePoolClientKeys();
  return (scope.overrides[account?.clientKeyId ?? 'legacy'] ?? scope.default) === 'on';
}
function anyClientKeyUsesProxyPool() // default on，或任一 override 为 on（只统计仍存在的密钥）
```

- `resolveEgress`（4318）：分支条件从 `pool.enabled` 改为 `accountUsesProxyPool(account)`。显式 `proxyUrl` 的分支保持在最前，不受影响。不走池时与旧的"关闭"分支逐字一致，不调用 `noteFallback`。
- `runChatChain` 中的 `poolEgressExpected`（5945）改为 `accountUsesProxyPool(account) && hasAvailable(egressExclude)`。换号后它读取的是新账号，因为 account 是每段的局部变量；实现时需要确认闭包拿到的是当前段的账号。
- `egressStep` 只看 `egress.kind === 'pool'`，不用改。

## FloppyData 生命周期

- `applyProxyPoolConfig(prev, next)` 改为同时接收新旧两份 scope。以前的启动条件"enabled 且 source 为 floppydata"改为"enabled 且 source 为 floppydata 且 `anyClientKeyUsesProxyPool()`"。
  - 从 false 变为 true：start（重新导入）。
  - 从 true 变为 false：stop，并 `replaceEntries([])`，让条目退役。
- 手动来源只看 enabled，不看密钥（没有费用，方便随时启用）。
- `applyAccountConfig` 的末尾已经会调用它，覆盖 POST 和 reload 两条路径。删除密钥的路由也要调用一次，因为删掉最后一个 on 的 override 时需要停止导入。

## 投影与控制台

- `proxyPoolStatusProjection()` 增加：
  ```js
  clientKeys: [{ id, name, mode, effective }]   // Legacy 的 name 为 'Legacy'；不含 key 值
  ```
- `GET /api/accounts` 增加 `proxyPoolClientKeys: effectivePoolClientKeys()`。
- `public/index.html`：
  - 代理池卡片新增"按客户端密钥"小节，包括默认下拉框和每个密钥一行的下拉框；数据源用页面上已有的 `CLIENT_KEYS` 列表。
  - `collectAccounts()` 在服务端返回了 `proxyPoolClientKeys` 时附带它，提交时把 mode 为 `default` 的行省略（不写进 overrides）。
  - 账号徽标改为"已保存的池开启且该账号所属密钥生效"时才显示。

## 兼容

- 68c6158 会保留但忽略新的顶层字段。回滚后回到全局语义，不会启动失败（AC9 用 git archive 68c6158 验证）。
- metadata 结构不变。日志枚举不变。

## 风险

- 闭包里的账号变量：`runChatChain` 首包前最多换号一次，必须用当前段的 account 做判定，测试要覆盖"换号后归属不同密钥"的情况。
- 默认 `on` 保证现有的"全局开启"配置升级后行为不变。
