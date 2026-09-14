# 实施计划：错误日志与 API 兼容修复

## 0. 前置与基线

- [x] 读取 PRD、生产排查证据、backend logging/quality、frontend state/quality 和 cross-layer/reuse 指南。
- [x] 确认工作区原有未跟踪 `.pi/plan/`，本任务不修改或删除。
- [x] 运行基线：`node --check server.js && git diff --check` 通过；`npm test` 27/27 通过。
- [x] 实施前再次确认仅修改本任务相关代码、测试、任务文档和必要 spec。

## 1. 输入与协议边界

- [x] 在 `server.js` 复用现有 `sendJSON()` 和鉴权分支，为 `POST /v1/responses` 返回固定 501 `unsupported_api`；确保不读取账号、不选租约、不触发上游。
- [x] 增加最小消息 content 空值校验，位置在 JSON/model 校验之后、敏感值提取/会话身份/账号选择之前。
- [x] 支持字符串、content part 数组、assistant tool-call 例外和非文本负载；不做消息删除/补全或完整协议转换。
- [x] 为 400/501 响应断言固定状态、type、param/code 和不泄漏正文。

## 2. 流生命周期与结果投影

- [x] 扩展 `createSseObserver()`：完整观察 `[DONE]` 时设置有界 `done` 状态；保持 CRLF/LF、分片和 64 KiB 事件限制。
- [x] 收敛流 finalizer 的优先级：SSE error/transport error > `[DONE]` success > pre-DONE client cancel > normal flush success。
- [x] 保持 finalizer、statistics finalizer 和 lease release 幂等；每条监听路径清理 socket/body 监听器。
- [x] 非流式客户端取消投影为 499，不把 abort 产生的内部 502 写成上游错误。
- [x] 在请求投影增加 `result: success | client_cancelled | failed`；客户端取消的 `errorCategory` 为 null，并抑制 error-log attempts。
- [x] 保持上游首事件错误、后置 SSE error、网络/代理失败、provider retry 和账号规则原行为。

## 3. 日志 API 与控制台

- [x] 将 `result` 加入请求日志安全投影和可选过滤 allowlist；不改变 error log schema、cursor identity 或存储上限。
- [x] 更新共享日志板块的标题/说明，明确请求日志为最终结果、错误日志为上游失败尝试。
- [x] 请求状态列显示 result；旧记录缺少 result 时安全降级，不迁移历史 JSONL。
- [x] 保持 `LOG_QUERY_ID`、类型切换、游标、筛选、清空确认和 escapeHtml 契约。

## 4. 可运行验证

- [x] 集成测试：上游发送 `[DONE]` 后暂不结束、下游立即关闭；最终仅一条 200/success 请求日志、无错误日志、统计成功、租约归零。
- [x] 集成测试：流式和非流式在完成前取消；最终仅一条 499/client_cancelled、无错误日志/错误统计/健康惩罚、无 provider replay、租约归零。
- [x] 集成测试：首事件错误、后置错误和传输错误仍产生真实失败记录且只提交一次。
- [x] 集成测试：`POST /v1/responses` 为 501 unsupported_api 且 mock upstream 零请求。
- [x] 集成测试：空字符串、空白、null、空/无效数组为 400；响应只含路径；assistant tool-call 和非文本 part 可转发；账号/upstream 在拒绝前未触发。
- [x] UI contract：两个日志板块的计数单位和请求 result 展示明确，仍共享一套安全 DOM/查询逻辑。
- [x] 运行 `node --check server.js`、受影响测试文件、全量 `npm test` 和 `git diff --check`。

## 5. 复核与知识同步

- [x] 运行 `trellis-check`，重点检查一次性 finalization、监听器/租约释放、跨层字段、历史兼容和敏感数据边界。
- [x] 将确认后的 `result`、499、`[DONE]` 和消息校验契约同步到 backend/frontend spec。
- [x] 检查 `git diff --stat` 与 `git diff --check`，确保没有无关格式化或重构。
- [x] 向用户展示本地结果、测试证据和残余风险；等待明确生产部署确认。

## 6. 生产步骤（仅在另行确认后）

- [ ] 创建版本化不可变 release；部署前备份 data/config/metadata/logs、compose 和 deployment metadata。
- [ ] 构建并切换容器；等待 healthy，确认 RestartCount 0、无 OOM、启动日志正常。
- [ ] 验证 `/api/meta`、日志/统计管理 API、501/400 边界和数据文件校验值。
- [ ] 通过 NewAPI 对应渠道执行正常流与主动取消对照；正常流必须同时为 NewAPI `done/ok` 和 Switcher 200/success。
- [ ] 任何健康、接口或数据一致性失败时恢复旧 compose/镜像；不清理旧 release、镜像或历史日志。

## 风险与回滚点

- SSE close/end/error 竞态可能造成双提交或租约泄漏：以单一幂等 finalizer 和竞态集成测试约束。
- 消息校验可能误拒合法多模态/工具消息：仅判断空值，保留明确 tool-call 例外和非文本负载测试。
- 新字段可能影响旧日志：只追加可选字段，UI 对缺失字段降级，不重写历史文件。
- 501 仍可能触发 NewAPI 自身的渠道回退：本项目只保证错误语义稳定，不修改 NewAPI 重试策略。
- 发布失败：恢复 compose 备份和旧镜像，数据目录不回写、不清理。
