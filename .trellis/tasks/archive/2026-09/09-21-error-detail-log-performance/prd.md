# 错误详情记录与日志热路径优化

## Goal

在不扩大普通日志敏感数据面的前提下，为每个真实失败上游 attempt 提供可按需查看的脱敏 Header/正文，并降低完整日志、ordinary queue和重复 metadata 持久化对模型请求/上传的影响。

## Background

父任务：`../09-21-upstream-diagnostics-account-limits-pool-keepalive/`。当前 full detailed logging 能保存 attempt Header/body，但默认关闭且错误页无法关联；ordinary/detailed store 的历史扫描性能已优化，剩余成本主要在 full capture热路径、无 pending byte fence、重复同步 metadata 保存和退出不 drain。

## Requirements

1. 新增独立 `errorDetailLogging` 布尔开关，缺失默认 false；full `detailedLogging` 保持独立。
2. off时模型流量、ordinary row字段/敏感数据面、现有full store及默认错误列表交互保持当前行为；settings API/UI允许新增独立控制项。on时对每个真实失败chat attempt发起捕获：中间重试、HTTP 4xx/5xx、HTTP 200 error envelope、可识别SSE error；请求未收到响应只保存no-response事实，已起流后断开则保留已收到Headers和stream-transport-failed事实。
3. 复用 `DetailedLogStore`、`DetailRedactor`、7天/1GiB、0700/0600、clear generation、认证和按需 body API，不建第二 store。
4. error-only 不保留 ingress/outbound request body、成功 response body、完整成功 SSE或最终客户端 body；full开启时同一request只有一个group。
5. ordinary error row仅在捕获意图存在时增加`detailProfile: "error"|"full"`和validated`detailCallId`，不含Header值/body；历史/off row省略字段。manifest attempt显式保存同一`attemptIndex + callId`，UI双重匹配，不一致时安全拒绝。
6. response Header/body按现有group-wide learn-before-project规则脱敏；每body沿用5MiB硬上限和安全省略状态。用户所说“全部错误”指每个失败attempt，不取消安全容量上限。
7. ordinary projection先把`reason`限制为脱敏后16KiB UTF-8并增加`reasonTruncated`，使单条serialized record不超过64KiB；再应用固定pending records/bytes上限。超限drop并记health，绝不阻塞模型响应；完整有界错误内容由error detail承担。
8. 同一chat终态的statistics/record metadata mutation合并为一次保存；管理写入和状态持久化语义不降级。
9. 移除full capture中可证明重复的body解析/metadata提取，并以benchmark证明转发字节和安全性不变。
10. 增加有界SIGTERM/SIGINT drain：先停止新接入/调度并等待active request finalizer，此时store仍接收终态记录；再fence新日志、drain队列/handles/timers；deadline后才abort active sockets并退出。长流或blocked writer不能无限阻塞。

## Acceptance Criteria

- [ ] off模式的模型请求字节/状态、ordinary row字段与敏感数据面、full detailed行为及错误列表默认交互与现状一致；settings API/UI仅增加独立开关。
- [ ] on模式中每个真实失败attempt都创建capture intent；成功发布的详情可查看正确脱敏Header/body，retry/account replacement通过index+callId关联。off、no-response、stream transport failure、安全省略和missing-group文案诚实且可测试。
- [ ] full+error同时开启不重复group/body；clear/expiry/publication failure不复活或影响流量。
- [ ] ordinary API/files始终无Header值、body、key、proxy credential、message或raw session。
- [ ] 50MiB ingress在error-only成功路径不产生5MiB额外request capture；成功SSE不被完整复制。
- [ ] pending queue在blocked I/O下保持记录/字节边界，超限fail-open。
- [ ] 同一chat终态不再执行可合并的两次metadata原子保存；统计、状态和重启语义不丢失。
- [ ] 响应完成后立即SIGTERM可在期限内落盘ordinary/error detail；有active请求时先允许finalizer写入，永久blocked writer按deadline强制收敛。
- [ ] focused tests、性能证据、UI契约、integration和完整gate通过。

## Out of Scope

- 把敏感内容加入ordinary JSONL。
- 保存成功请求的error-only详情。
- 修改额度、RPM或HTTP keep-alive行为。
- 生产启用开关或部署。
