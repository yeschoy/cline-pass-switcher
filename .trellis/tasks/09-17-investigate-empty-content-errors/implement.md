# 执行计划：批量空 content 错误只读诊断

1. **安全与生产基线**
   - 验证仓库根目录、SSH identity 路径、gitignore 和 `0600` 权限，不读取密钥内容。
   - 记录 UTC/本地时间、Switcher/NewAPI 容器 ID、镜像、健康、启动时间、重启/OOM 及关键配置哈希。

2. **NewAPI 同类错误完整统计**
   - 使用 `BEGIN READ ONLY` 按渠道 71、路径、HTTP 400 和固定错误类别聚合当前容器启动以来的事件。
   - 定位截图请求 ID，记录安全字段与相邻时间簇；统计每分钟数量、模型、stream 和调用主体不可逆分组。
   - 不选择请求正文、Header、token/key 值或可还原敏感字段。

3. **Switcher 交叉验证**
   - 只读取 detailed manifest 元数据，统计相同时间范围内 `status=400`、`attemptCount=0`、路径匹配的记录。
   - 对比 NewAPI 与 Switcher 的秒级计数；检查普通 requests/errors JSONL 是否缺少这些前置拒绝。
   - 核对生产代码哈希和当前空消息校验执行顺序。

4. **不可见原因核查**
   - 检查 detailed logging 设置、存储健康、manifest body descriptor 状态及安全省略标记。
   - 结合 NewAPI schema/日志字段和 Switcher redactor 代码，分别判断未采集、安全省略、UI 未展示或保留期影响。

5. **报告与只读验证**
   - 将结果写入 `research/current-empty-content-analysis.md`，区分已确认、高概率和未知。
   - 检查报告不含凭据、Header 值、正文或响应体。
   - 复核远程容器与配置哈希前后未因检查改变。

6. **本地红灯复现**
   - 使用临时/合成完整 JSON 证明普通字面 `\\uNNNN` / `\\xNN` 在无凭据时也会造成整组 `omitted-for-safety`。
   - 保留现有转义凭据跨组回显测试作为安全基线。

7. **最小修复**
   - 只修改现有 `DetailRedactor` 的完整文本转义发现/投影路径，不新增依赖、配置或存储/API schema。
   - 学习凭据的原始与有界解码形式；普通转义保持可读，真正揭示凭据的字符串局部省略/脱敏。
   - 不修改 partial/truncated/invalid/resource-limited 的 group-wide fail-closed。

8. **测试与 spec**
   - 更新 `test/detailed-log-capture.test.js`：普通转义可读、转义凭据跨 Header/JSON/SSE 不泄漏、部分/截断边界不放宽。
   - 运行聚焦 detailed capture 测试、相关 integration、语法检查、`npm test` 和 `git diff --check`。
   - 更新 `.trellis/spec/backend/logging-guidelines.md` 的转义凭据契约。

9. **授权后的生产部署**
   - 提交已验证代码与任务记录；从 committed HEAD 生成 allowlist archive、远端不可变 release 和候选镜像。
   - 只读预检当前 cache-pool release、配置/账号/详细日志、API、内部别名和公开 DNS；创建版本化备份及自动回滚材料。
   - 证明候选 Compose 只改变 image/context，预构建并核对镜像源码哈希，再原子切换。
   - 验证即时和 90 秒延迟健康、restart/OOM、配置哈希、认证 API、非法 quota 输入拒绝、内部别名和启动日志。
   - 在生产镜像内运行不发送业务请求的合成 redactor witness；成功后原子更新 `deployment.json` 和安全报告，不清理任何历史数据或发布物。

## 验证门槛

- 截图时间簇及其前后同类错误总量均有可复核计数。
- NewAPI 与 Switcher 的关联强度和缺失的共享 ID被明确说明。
- “为什么看不到请求体和请求头”必须分别覆盖 NewAPI 与 Switcher，不能用单一原因概括。
- 完整普通转义不再清空整组；转义凭据及跨组回显仍不可见。
- 不完整/截断/无效/超限安全边界与业务流量语义保持不变。
- 不执行生产清理、重启、部署或业务请求。
