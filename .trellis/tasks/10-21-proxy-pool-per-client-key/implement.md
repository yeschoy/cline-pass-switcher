# Implement — 代理池按客户端密钥开关

## 顺序

1. `lib/proxy-pool.js`：`normalizeProxyPoolClientKeys`、默认常量；单测（合法/非法/未知 id/多余字段/报错不含值）。
2. `server.js` 配置接线：四处 + 删除密钥路由的 override 清理；`effectivePoolClientKeys`、`accountUsesProxyPool`、`anyClientKeyUsesProxyPool`。扩展 `test/proxy-pool-config.test.js`：字节不变、400 不写、SIGHUP、revision、删除密钥清理。
3. 出口判定：`resolveEgress` 与 `poolEgressExpected` 改按账号归属；`applyProxyPoolConfig` 的 FloppyData 启动条件加入 `anyClientKeyUsesProxyPool`。**门禁**：完整 `npm test` 全绿（字段缺省时行为不变）。
4. 投影与控制台：status 的 `clientKeys`、GET `/api/accounts` 的字段；卡片小节、`collectAccounts`、徽标；更新 `test/proxy-pool-ui.test.js`。
5. 集成测试（扩展 `test/proxy-pool.integration.test.js`，使用现有 fixture，必要时加一个第二客户端密钥及其账号）：AC2～AC5、AC7、AC9（旧镜像改为 68c6158，即当前线上版本）。
6. spec（database/quality/logging 中涉及代理池的段落）与 README 代理池章节补充"按客户端密钥"说明。

## 验证

```bash
node --check server.js lib/*.js
node --test test/proxy-pool.test.js test/proxy-pool-config.test.js test/proxy-pool.integration.test.js test/proxy-pool-ui.test.js
env -u CLINE_PASS_KEY -u CLINE_PASS_UPSTREAM_BASE timeout 900 npm test
git diff --check
```

## 发布

- 提交并推送后，按本机发布流程发布：复用 `archive/2026-10/10-20-proxy-pool/research/deploy/` 的脚本，无配置迁移（字段缺省时不写回），上一版本为 `20261021-68c6158-proxy-pool`。
- 回滚：直接换回旧镜像；旧镜像忽略新字段。
