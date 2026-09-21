# 实施计划：New API Chat keep-alive

## 1. 红灯

- [ ] inbound keep-alive跨旧5秒窗口复用连接。
- [ ] direct HTTP/HTTPS、HTTP/HTTPS CONNECT、SOCKS5/SOCKS5H按锁定agent能力矩阵测试socket/tunnel复用，draft proxy使用一次性agent且无cache增长。
- [ ] 首事件前comment+data、comment-only cap/timeout。
- [ ] 起流后静默heartbeat、upstream idle timeout和New API等价scanner。
- [ ] backpressure `write(false)->drain`不误报断开；cancel/DONE/error/shutdown清理timer、socket和lease exactly-once。

## 2. Agents/server

- [ ] 增加direct agents并把clineRequest所有protocol路径接入。
- [ ] proxy agents显式keepAlive、有界free sockets；persisted cache stale URL先destroy，draft override settle后destroy且不入cache。
- [ ] 显式设置server keepAlive/headers timeout和test overrides。
- [ ] 接入统一shutdown agent destroy。

## 3. SSE lifecycle

- [ ] 分离non-stream/first-event/post-start idle timeout，并通过窄transport控制句柄实际替换旧socket timeout；comment不延长first deadline。
- [ ] 首事件scanner跳过标准comment/meta且保持64KiB上限。
- [ ] 首data后由唯一写入owner启动heartbeat，upstream chunk reset，write(false)等待drain，终态清理。
- [ ] 确认ping不进入usage/error/health/RPM/attempt统计。

## 4. 验证

```bash
node --check server.js
node --test test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- [ ] local mock记录TCP端口、CONNECT/SOCKS握手和静默段时间线。
- [ ] 验证Node18可用API和锁定proxy-agent行为。
- [ ] 更新`.trellis/spec/backend/{quality-guidelines,error-handling,database-guidelines,deployment-guidelines}.md`、README和env示例。
- [ ] check、commit、archive。
