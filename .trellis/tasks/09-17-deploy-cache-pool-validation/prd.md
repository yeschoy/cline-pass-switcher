# 部署缓存活跃池并验证命中率

## Goal

将已通过本地测试和真实浏览器验证的 cline-pass-switcher 缓存活跃池版本安全部署到既定生产服务器，启用 2 个活跃账号的缓存优先策略，并按既定指标验证缓存请求命中率是否达到 70%。

## Background

- 功能提交：`083b9ea`；文档与验证提交：`0e03e21`。
- 已实现 `accountPipeline.cachePoolSize`、priority 稳定双活跃池、hard-state 补位、5 秒容量等待、备用溢出诊断和控制台预设。
- 本地质量证据：146/146 自动化测试通过，Chrome 桌面与 390px 窄屏验证通过。
- 2026-09-17 当前只读预检已重新冻结最近 24 小时基线：2,575 个统计请求、2,426 个明确 cache 样本，缓存请求命中率 63.73%，缓存 Token 占比 88.83%，最终错误 56；普通请求日志 P95 为约 29.3 秒，overflow/capacityFallback/switched 均为 0。正式切换前仍需再次冻结最终基线。
- 当前 9 个配置账号中 7 个启用；6 个 fresh hot、1 个 fresh warm，启用账号均不限并发且 priority 均为 100。基于 fresh 额度、健康与现有缓存表现，当前建议活跃账号为 `account#3efe425de6`（13%、health 100、请求命中 66.58%）和 `account#eb683cec24`（14%、health 99.29、请求命中 68.10%）；别名仅用于本次脱敏报告。
- 生产目标固定为 `ubuntu@167.114.158.4:49555`，远程根目录 `/opt/cline-pass-switcher`，Compose 服务/容器 `cline-pass-console`。
- 当前工作区仍有与本任务无关的 `untitled.md` 删除；部署必须使用已提交 HEAD 的 allowlisted archive，不得上传工作树或该删除。
- 首次 release `20260917-084457-cbdee55-cache-pool` 的直接 build 镜像与最终 Compose build 镜像 ID 不一致，硬门禁在账号配置前触发并已自动回滚；配置 POST 为 0，策略未激活。失败 release、镜像、日志与备份保留。重试必须使用新 release，先以最终 Compose 路径构建 exact image，再用该镜像预演，并以 `up --no-build` 切换/回滚。

## Requirements

- 部署前执行只读预检：本地提交/测试、SSH 身份安全、生产容器/镜像/健康、主机资源、配置/元数据哈希、当前账号池/额度/健康、当前缓存/错误/延迟基线、内部与公开入口。
- 已授权部署脚本基于写入前最新的 fresh 额度、健康与缓存表现自动选择 2 个活跃账号，并为其设置最低且不同的 priority；其他启用账号保留为备用，不改变 Key、名称、代理、Header、模型路由或启用状态。写入前必须输出脱敏候选与选择理由；若不足 2 个合格账号则停止。
- 使用新的不可变 release，从 committed HEAD 构建 allowlisted archive；保留现有 hardened Compose 设置，仅切换 release/image 相关字段。candidate 必须通过最终 Compose 路径预构建，迁移预演和正式切换使用同一 exact image ID，不得在切换或回滚时重新 build。
- 部署前备份 Compose、deployment.json、config.json、metadata.json，并准备自动回滚。除经审阅的 `accountPipeline.cachePoolSize=2`、sticky 模式、`concurrencyWaitMs=5000` 和账号 priority 外，不得改变配置语义。
- 发布后必须验证容器 running/healthy、restart=0、OOM=false、镜像/源码哈希、配置精确预期差异、认证管理 API、模型/统计/日志接口、内部网络别名与公开入口。
- 自然预热阶段单独报告，不得把预热冷启动隐藏在正式观察数据中。
- 正式验证窗口为预热后 24 小时且至少 1,000 个明确 cache 样本；主指标缓存请求命中率 ≥70%。
- 护栏：缓存 Token 占比较重新冻结基线下降不超过 3 个百分点，最终失败率上升不超过 1 个百分点，P95 延迟恶化不超过 20%，备用账号溢出率低于 1%，活跃账号不进入 reserve 或持续不健康。
- 任一即时部署门禁失败自动恢复切换前 exact image ID 与原始配置；回滚禁止重新 build 旧 tag。24 小时观察指标或护栏失败时只生成报告并通知，保留完整配置回滚材料，未经用户确认不得自动修改生产配置。
- 部署成功后自动安排一次约 24 小时后的只读复核，统计主指标、样本数和全部护栏并返回报告。
- 不修改 NewAPI 或 CPA，不读取/输出账号 Key、代理凭据、Header 值、消息正文、原始会话或 HMAC 指纹。

## Acceptance Criteria

- [x] 部署计划包含精确目标、源提交、allowlist、备份、切换、健康门禁、配置差异证明和自动回滚步骤。
- [x] 用户审阅并批准最终部署计划后才执行生产写操作。
- [x] 发布后生产运行在目标不可变镜像，容器健康、无重启/OOM，源码与提交哈希匹配，配置仅含批准字段变化。
- [x] 两个活跃账号来自部署时 fresh、非 reserve、非 unhealthy 的账号，并可通过安全投影确认 active/standby 角色。
- [ ] 预热窗口与正式观察窗口分开记录；正式窗口达到 24 小时且至少 1,000 个明确缓存样本。
- [ ] 正式窗口缓存请求命中率 ≥70%，且全部护栏通过；否则如实报告未达标并等待用户决定是否执行配置回滚。
- [ ] 全过程不泄露秘密，不修改 NewAPI/CPA，不清理日志、镜像、release、构建缓存或操作员数据。

## Out of Scope

- 修改 NewAPI 或 CPA。
- 自动缩减为单账号池。
- 为达到 70% 隐藏预热、缺失 usage、失败请求或回滚窗口。
- 未经额外批准调整模型/provider 路由、账号启用状态、Key、代理或错误规则。
