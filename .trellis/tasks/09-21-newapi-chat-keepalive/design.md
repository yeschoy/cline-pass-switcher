# 技术设计：New API Chat keep-alive

## 1. 传输owner

继续由`clineRequest()`统一创建native Node请求。增加进程级direct HTTP/HTTPS Agent和现有proxy Agent显式keep-alive；不引入fetch/Undici/http2。

建议有界默认：direct `maxSockets=256,maxFreeSockets=32`；每persisted proxy `maxSockets=32,maxFreeSockets=2`，均`keepAlive:true,scheduling:'lifo'`。实现前以Node18和锁定proxy-agent API验证参数。配置保存后先destroy再移除无账号引用的cached agents。`/api/accounts/proxy-test`的draft override永不进入全局cache，使用一次性agent并在transport settle后destroy，防止高基数认证URL积累idle tunnels。

## 2. 入站server契约

在`http.createServer`后显式设置约95秒`keepAliveTimeout`，`headersTimeout`严格大于它（例如100秒），保持现有request/body安全上限。测试使用有界env override缩短时间，不依赖本机Node默认。该设置只影响请求间idle connection，不是SSE总时长。

## 3. 三种时间边界

- non-stream attempt timeout：保留现有有界120秒语义；
- stream first-event timeout：120秒，覆盖响应头和首个有效data事件，允许首包前fallback；
- post-start upstream idle timeout：默认360秒，检测Cline永久静默。

`clineRequest()`除response外返回窄控制句柄（例如`setIdleTimeout(ms)`/`destroy()`），或在内部response阶段显式切换同一request/socket timeout；不能只新增参数却保留旧120秒listener。first-event由request-local AbortController负责，前置comment不重置wall deadline；成功起流后清除first timer并切换idle值。下游heartbeat不能重置Cline upstream idle timer。

## 4. 首事件解析

将`readFirstSseEvent()`改为有界事件扫描：累计最多64KiB，允许注释行、空事件及event/id/retry字段，直到首个含data的完整事件。返回从开始到该data事件结束的原始buffer，因此合法前置注释仍转发。首个data为error时保持现有分类/重试；只有注释直到上限/timeout仍失败。

## 5. 起流后heartbeat

新增唯一stream-local heartbeat/forward owner，串行向downstream写upstream chunks与comments：

- 首data提交后启动，默认25秒无upstream bytes发送`: PING\n\n`；
- 每个upstream chunk重置timer；
- `res.write()===false`表示背压：停止额外heartbeat、暂停/沿用pipe背压并等待`drain`后重新arm；只有throw/socket close/error才是失败；
- flush/error/close/finalize幂等清timer；
- observer只解析data事件，comment不改变usage/error/DONE；
- full detailed downstream capture可以观察实际ping字节，但ordinary诊断不为每个ping写记录。

New API scanner会在过滤comment前重置idle timeout并忽略该行。最终客户端保活仍由New API现有PingInterval设置负责。

## 6. 取消、退出与agents

直接client close继续destroy upstream response/request。经New API首响应前取消无法仅由switcher感知，first-event timeout提供有界收敛，文档不宣称即时传播。统一shutdown coordinator先stop intake/调度并等待active流finalizer（stores仍开放），再drain logs，最后destroy sockets和agents；deadline到期才强制销毁。Node18上feature-detect`closeIdleConnections/closeAllConnections`，不依赖较新`keepAliveTimeoutBuffer`。

## 7. 配置与文档

运行参数使用严格bounded env（生产默认固定）：inbound keep-alive、SSE heartbeat、first-event、stream idle、socket pool sizes。非法值启动时采用明确默认或失败策略，不能由数字大小猜单位。新增env同步更新backend persistence/runtime-key清单及部署文档。README给出New API建议：HTTP/1.1 upstream、关闭反代buffering、其自身下游ping按需启用。

## 8. 回滚

heartbeat设0可关闭；Agent仍可通过回滚版本恢复。应用只服务HTTP/1.1 Chat，不修改New API或拓扑。本任务不执行部署。
