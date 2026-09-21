# 账号级 RPM 限流

## Goal

在现有账号租约与真实Chat attempt边界实现并发优先、可解释、单进程滚动窗口的账号级RPM保护。

## Background

父任务：`../09-21-upstream-diagnostics-account-limits-pool-keepalive/`。当前只有`maxConcurrent`和幂等lease；Provider retry会在同一账号内发多个真实HTTP请求。

## Requirements

1. 账号新增canonical `maxRpm`，整数0..100000，0表示不限；config/API/UI/草稿/示例完整往返。
2. 旧配置缺失时为0；旧客户端按稳定账号ID省略字段时保留已有值，不能静默清零。
3. 使用每账号进程内精确滚动60秒窗口；重启清空，多副本独立，不声称全局硬上限。
4. RPM按每个实际调用`req.end()`交给Cline `/chat/completions`的native HTTP attempt计数，包括Provider retry；`/api/test`、`/api/probe`、`/api/validate-upstreams`、绑定已保存accountId的`/api/accounts/test`和`/api/accounts/proxy-test`均计数。models/catalog/quota等非chat请求不计；没有有效已保存accountId的临时credential test因不存在配置owner而明确不受账号maxRpm约束。
5. 准入顺序固定为hard eligibility -> maxConcurrent -> RPM。并发失败不得检查后消费/预留RPM。
6. 成功lease为首次attempt预留一个RPM名额；`ClientRequest`成功创建并调用`req.end()`时提交。调用前同步失败/未发出即释放预留并通知等待者；提交后无论DNS/connect/proxy/TLS/成功/错误/超时/取消均不返还。
7. 同账号后续Provider retry每次独立预留/提交。没有RPM名额时不等待、不发出attempt、不换号，立即以本地429和精确`Retry-After`结束；此前真实上游失败attempt仍保留原始状态和错误记录，请求终态标记local RPM而非伪造upstream 429。
8. 初始账号选择跳过有并发但RPM耗尽的候选，并在所有候选不可用时返回准确`Retry-After`；等待复用现有waiter/deadline，不建refill timer/队列。
9. RPM-only或mixed阻塞不得触发cache pool动态扩容；只有所有active hard-eligible候选都有有限maxConcurrent且全部`blockedBy=concurrency`，等待后仍成立，才允许既有grow-one。
10. 删除/替换账号凭据清理其RPM状态；普通disable/re-enable不绕过仍在窗口内的已提交事实。
11. 管理投影只返回limit、当前窗口已提交/预留计数和最早恢复时间等安全数值，不返回timestamp数组或候选内部状态。

## Acceptance Criteria

- [ ] maxRpm边界、strict validation、旧配置/旧客户端保存和UI完整草稿往返通过。
- [ ] 并发满时RPM余量不变化；释放并发后仍可使用完整RPM名额。
- [ ] 每个调用`req.end()`的真实provider attempt各计一次；request创建/发送前失败释放预留并唤醒等待者，发送后的失败/取消不退款。
- [ ] RPM耗尽时跳过账号或安全429，`Retry-After`来自最早滚动窗口恢复时间且不自旋。
- [ ] single/sticky/roundrobin/pipeline/cache-pool/management chat调用保持现有选择边界。
- [ ] Provider retry没有RPM时不等待、不发请求、不伪造upstream attempt、不换账号；最终local 429/Retry-After与此前真实error attempts可同时被准确观察。
- [ ] RPM-only阻塞不扩池；并发满仍按动态池契约处理。
- [ ] 重启清空和多副本独立语义有明确测试/文档。
- [ ] focused、UI、integration和完整gate通过。

## Out of Scope

- Redis/数据库/跨进程全局限流。
- TPM、计费或额度推断。
- 非chat endpoint统一限流。
- 生产配置或压测真实账号。
