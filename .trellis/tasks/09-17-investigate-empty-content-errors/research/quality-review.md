# 质量复核

最终检查时间：2026-09-17T11:25:01Z。

## 调查证据

- 当前 Switcher 容器目标事件为 25 条、25 个唯一 NewAPI request ID，最后一条为 `2026-09-17T07:43:02Z`；NewAPI/manifest 秒级计数一致。
- 生产只读检查前后 Switcher/NewAPI 容器身份、健康、重启/OOM 状态及 config/compose/deployment 哈希未变。
- 调查报告未包含生产原始正文、响应体、Header 值、Key、Cookie、Authorization、代理凭据或可逆用户/token 标识。

## 代码与安全边界

- 源所有者保持为 `DetailRedactor`；未新增脱敏器、依赖、配置、API、存储字段或 UI 状态。
- 完整普通单层字面转义保持可读；解码后揭示的 credential value/name、Cookie component、URL key 及跨 Header/正文回显均被移除。
- partial、截断、无效编码、嵌套转义和工作上限继续 group-wide fail closed。
- 集成测试证明详细日志开关前后 JSON/SSE 业务状态、正文和上游输入不变。
- 历史 0 字节正文不会被伪造恢复；`resource-limited` 仍保持原安全边界。

## 自动化验证

- `node --test test/detailed-log-capture.test.js`：44/44 通过。
- `node --test --test-name-pattern='detailed logging' test/integration.test.js`：14/14 通过。
- `node --check lib/detailed-log-capture.js test/detailed-log-capture.test.js test/integration.test.js`：通过。
- `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test`：149/149 通过。
- `git diff --check`：通过。
- 338 KiB 合成正文 witness：`state=complete`、`truncated=false`，普通字面转义保持可读。
- `task.py validate`：通过；implement/check manifests 均含真实上下文。

## Spec 同步

`.trellis/spec/backend/logging-guidelines.md` 已更新：完整单层普通转义采用一次有界解码视图；转义凭据仅局部省略并清理跨组回显；partial/嵌套/无效/超限继续整组省略。该文档仍保留完整七段 code-spec 结构。
