# 执行计划：proxy-inflight-timeout

## Ordered checklist

1. [x] 改 `server.js`：`proxyAgentOptions` 去掉 `timeout`；保留 `keepAlive` / `maxSockets` / `maxFreeSockets` / `scheduling`。**不改** `SSE_FIRST_EVENT_MS` / `SSE_STREAM_IDLE_MS` / `NON_STREAM_ATTEMPT_MS` 默认。
2. [x] 改 `clineRequest`：绑定 socket 后同步嵌套 timeout 到 `timeoutMs`；`setIdleTimeout` 同步同一条链。
3. [x] 加回归测试：`test/proxy-inflight-timeout.test.js` + integration SOCKS 慢非流。
4. [x] 跑相关测试：`test/proxy-inflight-timeout.test.js` 与 integration 中 SOCKS / non-stream timeout 相关用例通过。
5. [x] 更新 backend spec：直连 Agent 60s = 空闲池；代理不传构造 `timeout`，进行中由 request/attempt/idle 期限约束。

## Validation

```bash
node --test test/integration.test.js   # 或更窄的文件/grep 过滤，以实际新增用例位置为准
```

验收对照 `prd.md` Acceptance Criteria。

## Review gates

- 不改错误规则 / 换号 / `NON_STREAM_TIMEOUT_RETRY` 默认。
- 不改 `directAgentOptions.timeout`。
- 无密钥写入日志或测试。

## Rollback

还原 `proxyAgentOptions` 与 `clineRequest` 嵌套同步改动；删除新增测例。
