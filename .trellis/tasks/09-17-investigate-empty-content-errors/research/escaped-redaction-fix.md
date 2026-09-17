# 完整字面转义导致详细日志整组空白：根因与修复

## 根因

生产截图中的 `observedBytes=338947`、`complete=true`、`truncated=false`、`capturedBytes=0`、`state=omitted-for-safety` 表明请求完整到达，但在脱敏发布阶段被整组清空。

本地最小复现确认：完整合法、无任何凭据的 JSON，只要普通消息文本出现一个字面 `\\uNNNN` 或 `\\xNN`，旧 `DetailRedactor.text()` 就立即设置共享 `unsafe=true`。同一个 root 的请求/响应正文、请求/响应 Header、model 和 attempt 随后全部变成 omission marker 或 0 字节正文。

红灯复现结果：

```text
control                complete / hasText=true
literal-unicode-escape omitted-for-safety / capturedBytes=0
literal-hex-escape     omitted-for-safety / capturedBytes=0
```

该策略原本用于防止转义形式隐藏凭据并让解码后的凭据回显从别处泄漏；安全目标正确，但将所有完整普通代码转义都升级为整组不安全，误伤范围过宽。对代码类长提示词，这是可观测性 bug。

## 修复

修改现有 `DetailRedactor`，未增加第二套脱敏器、依赖、配置、API 或存储字段：

1. 完整文本继续先扫描原始 URL/Bearer/assignment 语法。
2. 对一个字面转义层生成一次有界解码视图；普通文本未揭示凭据时保留原文。
3. 已识别凭据的原始形式和解码形式都会进入同一个 secret 集，清除更早/更晚的 Header、JSON、SSE 和正文回显。
4. 转义后的 credential field name、Cookie/Set-Cookie name/component 和 URL query key同样按凭据处理。
5. 若解码只在当前字符串中揭示凭据，则仅将该字符串替换为 `[OMITTED: ambiguous escaped credential]`，不再清空整个 root。
6. partial、截断、无效 UTF-8、超过一层的嵌套转义、无法完成发现和 sanitizer 资源上限仍保持 group-wide fail closed。
7. 业务请求/响应字节与状态保持不变；详细日志仍只是异步诊断投影。

## 验证

### 红转绿

同一最小复现修复后：

```text
control                complete / hasText=true
literal-unicode-escape complete / hasText=true
literal-hex-escape     complete / hasText=true
```

338 KiB 合成正文（与生产截图量级一致）验证：

```text
observedBytes=338065
state=complete
complete=true
truncated=false
suffixPreserved=true
```

### 自动化测试

- `node --test test/detailed-log-capture.test.js`：44/44 通过。
- `node --test --test-name-pattern='detailed logging' test/integration.test.js`：14/14 通过。
- `node --check`：`lib/detailed-log-capture.js`、两个相关测试文件均通过。
- `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test`：149/149 通过。
- `git diff --check`：通过。

覆盖场景包括：完整普通字面转义、Header/JSON/SSE 转义凭据、转义 credential name、Cookie component、URL query key、跨组回显、partial/截断/嵌套转义、工作上限、API/文件不泄漏和日志开关前后业务字节相同。

## 边界

- 历史已经发布成 0 字节的详细正文无法恢复或迁移。
- 修复仅对部署后的新请求生效；本任务未部署生产。
- 8 条 `resource-limited` 记录属于独立的 sanitizer 工作上限，不在本次普通转义误伤修复范围内，仍按安全策略保持为空。
