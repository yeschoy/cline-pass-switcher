# 初始证据

## 用户截图

- NewAPI 列表在 `2026-09-17 15:43:01–15:43:02` 对渠道 `71（cpc号池）` 显示多条错误。
- 模型：`deepseek-v4-flash`；请求路径：`/v1/chat/completions`。
- 截图 OCR 初读为 `20260917T0743020657752918268d9d6JKb04xpJ`；后续生产数据库核对后的准确请求 ID 为 `202609170743020657752918268d9d6JKbO4xpJ`。
- 错误摘要：HTTP 400，`…content must not be empty`。
- 截图只是一个短时间片，用户明确说明还有大量同类错误，需要完整统计。

## 既有仓库证据

- `.trellis/tasks/09-16-investigate-remote-cline-pass-errors/research/empty-message-source-analysis.md` 记录了 2026-09-16 的同类事件：当时 NewAPI 转发到 Switcher 的 `messages` 数组至少有一个元素不满足 Switcher 内容校验，且在账号选择与上游调用前返回 400。
- `server.js` 当前本地实现中，`emptyMessageContentPath(body)` 在 `recordChat`/账号租约前执行，错误格式为 `messages.<index>.content must not be empty`。
- `lib/detailed-log-capture.js` 的 redactor 采用 fail-closed 机制：凭据发现不完整或不安全时整组内容可变为 `[OMITTED: incomplete credential discovery]`/`omitted-for-safety`，避免泄露跨 Header/正文出现的凭据。
- NewAPI 页面截图只展示日志摘要，没有请求正文或 Header；是否为当前 NewAPI schema 本身未采集，仍需生产只读查询确认。

## 当前尚未确认

- 当前生产同类错误总数、完整时间范围和是否集中于同一调用主体。
- 截图请求 ID与某个 Switcher manifest 的关联强度。
- 当前事件究竟在原始客户端进入 NewAPI 时已经为空，还是由 NewAPI relay/协议转换形成。
- 当前 detailed manifest 是未采集、UI 未展示、保留期缺失，还是被安全省略。
