# New API Chat 长连接兼容

## Goal

仅修改 cline-pass-switcher，使现有 New API -> switcher -> Cline Chat Completions 链路具备显式 HTTP/1.1 连接复用和可靠 SSE 静默段保活。

## Background

父任务：`../09-21-upstream-diagnostics-account-limits-pool-keepalive/`。源码证据见父任务`research/newapi-keepalive-compatibility.md`：New API已有共享HTTP连接池、SSE scanner和可选下游ping；switcher SSE正确性基本具备，但连接池、入站idle窗口、heartbeat和超时分层不完整。

## Requirements

1. 在现有`clineRequest()` transport owner内为HTTP/HTTPS直连创建进程级bounded keep-alive agents；不引入fetch/undici/第二transport。
2. 现有HTTP/HTTPS/SOCKS代理agent显式启用keep-alive。只有persisted account proxy可进入有界缓存；`/api/accounts/proxy-test`的draft override使用一次性agent并在请求后destroy，避免高基数URL积累。代理失败绝不回退直连。
3. 配置switcher入站`keepAliveTimeout/headersTimeout`，与New API默认90秒idle pool协调且Node>=18兼容。
4. 流式请求分离首响应/首data事件期限与已开始流的Cline socket idle期限；transport返回窄控制句柄以切换已存在request/socket timeout，非流式timeout保持有界。前置SSE注释不延长首data wall deadline。
5. 只有首个合法data事件已向下游提交后，静默时才发送标准SSE注释心跳`: PING\n\n`；上游数据到达后重置心跳。heartbeat与upstream chunks由一个stream-local写入/背压owner串行化。
6. 心跳不进入usage、模型事件、错误分类、Provider attempt、RPM或health统计；`res.write()===false`只暂停额外heartbeat并等待`drain`，不能当作断开。只有throw/socket close/error才按下游失败处理。
7. 首事件解析允许并保留有界的前置注释/空事件/event/id字段，直到首个data事件；仍保持64KiB上限、错误首事件failover和不提前提交响应。
8. 正常DONE、上游错误、timeout、客户端取消、shutdown时清理timer/socket/agent并exactly-once释放lease。graceful shutdown先等待active finalizer再drain logs，deadline后才destroy连接。
9. 文档说明New API自身下游ping需由其现有运维设置启用；本项目不修改New API。
10. 明确不实现HTTP/2/h2c入站、Realtime WebSocket或Responses API。

## Acceptance Criteria

- [ ] New API风格keep-alive客户端跨旧5秒窗口复用到switcher的HTTP/1.1连接。
- [ ] switcher到local mock Cline的direct HTTP/HTTPS、HTTP/HTTPS CONNECT和SOCKS5/SOCKS5H按锁定agent能力矩阵验证连接/隧道复用；若协议端不允许复用必须记录证据，但坏代理不直连始终是硬门禁。draft proxy agent请求后被destroy。
- [ ] SSE首data后静默段收到heartbeat，New API等价scanner重置idle但不产生模型chunk。
- [ ] first-event timeout、post-start idle timeout和heartbeat各自独立；heartbeat不能掩盖Cline永久静默。
- [ ] 前置SSE注释后data/DONE正常通过，首包错误仍不暴露后重试。
- [ ] backpressure让`res.write()`返回false后等待drain并最终成功，不产生伪499；slow client/cancel/stream error/DONE/shutdown路径timer清理、attempt/RPM/usage/log/lease均exactly-once。
- [ ] Node>=18语法/API兼容，focused local mock、integration和完整gate通过。

## Out of Scope

- 修改New API源码或配置。
- HTTP/2/h2c server、TLS termination。
- `/v1/realtime` WebSocket、`/v1/responses`。
- 生产部署或真实上游验证。
