# 技术设计：批量空 content 错误只读诊断

## 边界

- 生产目标沿用项目部署规范：`ubuntu@167.114.158.4:49555`，Switcher 容器 `cline-pass-console`，NewAPI 容器按现网实际名称确认。
- 全程只读。远程仅执行状态读取、Docker inspect/logs、文件元数据与安全聚合、PostgreSQL `BEGIN READ ONLY` 查询。
- 不读取或输出原始正文与普通 Header 值；详细日志正文文件只检查 descriptor/state/大小等元数据。

## 证据链

1. 用截图显示时间与请求 ID定位 NewAPI 事件，确认其时区、渠道、模型、stream、HTTP 状态和错误类别。
2. 对当前容器启动以来的 NewAPI 渠道 71 同类错误做聚合，得到完整数量、时间簇和调用主体安全分组。
3. 对 Switcher detailed manifest 只读聚合 `POST /v1/chat/completions`、HTTP 400、`attemptCount=0` 的记录，并按毫秒/秒级时间分布与 NewAPI 对齐。
4. 读取 Switcher 普通 requests/errors JSONL 的安全字段，确认这些前置拒绝是否因执行顺序而缺席，并排除账号选择、额度与上游调用。
5. 将运行中生产代码哈希与本地实现比对，再用代码路径解释固定错误和详细日志安全省略机制。

## 日志不可见分类

- **NewAPI 未采集**：业务日志仅保存请求元数据、状态和错误摘要，不保存完整正文/Header。
- **Switcher 普通日志未进入**：空 content 在 `recordChat` 与账号租约之前被拒绝，因此无普通 request/error 行。
- **Switcher detailed 安全省略**：若跨 Header/正文的凭据发现无法证明完整，redactor 对整组 fail closed，manifest/body descriptor 标记 `omitted-for-safety` 或字段显示 `[OMITTED: incomplete credential discovery]`。
- **UI 未展示**：后端可能保留 body descriptor，但列表页只显示摘要，需要区分于真正未采集。
- **保留期/清理**：只有实际证据表明正文文件不存在时才归入该类。

## 修复设计

本地合成复现已确认：完整合法 JSON 的普通消息文本仅含字面 `\\uNNNN` 或 `\\xNN`，即使不存在任何凭据，也会使共享 `DetailRedactor.unsafe=true`，最终把根请求、响应、Header 和所有正文整组发布为空。该行为来自过宽的转义检查，而不是存储/UI 故障。

修复仍由现有 `DetailRedactor` 单一所有者完成，不增加第二套脱敏器：

1. 完整文本先按现有 URL/Bearer/assignment 规则发现凭据；已识别凭据同时学习其原始字面形式和有界解码后的 `\\uNNNN`/`\\xNN` 形式。
2. 对剩余普通字面转义做有界解码探测：若解码形式未揭示已知或结构化凭据，则保留原普通文本；若揭示凭据，只省略/脱敏受影响字符串，并使用已学习的解码凭据清除跨 Header/正文回显，不再把无关的整组内容全部清空。
3. partial=true、截断、无效 UTF-8、无法有界完成解码/凭据发现和现有资源上限继续设置 group-wide unsafe/limited；不降低安全边界。
4. 不改变 BodyCapture、DetailedLogStore、API 或 UI schema；历史已发布的 0 字节正文不迁移。

## 兼容与风险

- 详细正文是诊断投影，不是可重放输入；允许局部可疑字符串显示安全 omission marker。
- 转义解码必须使用固定正则和有限轮次，禁止 `eval`、动态代码执行或无界递归。
- 任何凭据泄漏回归、业务字节变化、工作上限失效或完整测试失败都阻止交付。

## 回滚

生产调查阶段没有远程变更。代码修复只涉及 redactor、聚焦测试与 logging code-spec；回滚时恢复这些本地文件即可。生产部署不在本任务授权范围内。
