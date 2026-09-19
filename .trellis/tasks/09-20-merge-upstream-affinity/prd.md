# 合并上游亲和分支

## Goal

在独立集成 worktree 中把 `feat/upstream-session-affinity` 完整合入 `feat/quota-forecast-panel`，同时保留目标分支后续加入的可视化内容错误规则、归档/部署证据和所有兼容契约；通过完整质量门禁后，只以 fast-forward 更新目标分支，不覆盖其现有未提交文件。

## Background

- 目标分支：`feat/quota-forecast-panel@1da42d0`。
- 功能分支：`feat/upstream-session-affinity@827fdef`。
- 共同基线：`74913e0`。
- 功能分支包含 Chat 会话亲和、请求日志安全提示、账号作用域 provider 校验、一键配置、provider cooldown/half-open、statistics v3 与完整任务归档。
- 目标分支在共同基线后包含可视化内容错误规则、多个 Trellis 任务归档、journal 和生产部署证据。
- 原目标 worktree 有与合并提交路径不重叠的未提交 `AGENTS.md`、`untitled.md`、`.pi/subagents/` 和部署任务资料；这些文件不得被暂存、覆盖、清理或纳入合并。
- 只读 `git merge-tree --write-tree` 识别 7 个文本冲突：backend database/quality specs、frontend quality spec、workspace index、README、`server.js`、`test/integration.test.js`。其余交叉修改可自动合并，但仍需语义复核。

## Requirements

- 实际 merge、冲突解决、测试和 merge commit 只能发生在 `/Users/lyh_god/GolandProjects/cline-pass-switcher-affinity-merge` 的 `integration/upstream-affinity-into-quota` 分支。
- 冲突解决以目标分支当前行为为基线，逐项叠加亲和功能；不得用整文件 ours/theirs 覆盖 `server.js`、测试、README 或 specs。
- 保留目标分支的 `accountContentErrorRules`、内容匹配优先级、UI 草稿/高级 JSON、相关测试和文档；保留功能分支的 affinity/provider/status/statistics v3 合同。
- `statistics v3` 必须从目标分支现有 v2 模型统计迁移，不能丢失模型 bucket、内容规则统计/健康契约或把迁移前 routing counters 伪装为完整零。
- 保留普通/详细日志敏感数据边界：不得记录 prompt/session key、派生 key、HMAC fingerprint、内容规则关键词或原始响应正文。
- Trellis task archive、research 和 journal 都应保留。`.trellis/workspace/tanggod/index.md` 冲突按 Trellis 约定选择目标分支版本；journal 自动合并后核对双方会话记录存在。
- 合并后完整运行 server/lib 语法、前端 VM、JSON 示例、聚焦测试、全量 `npm test` 和 `git diff --check`。
- 只有 integration 分支形成已验证 merge commit 且目标 worktree 的现有脏路径仍与待快进差异不重叠时，才在目标 worktree 执行 `git merge --ff-only integration/upstream-affinity-into-quota`。
- 不推送、不部署、不修改 NewAPI/CPA/生产；不合并或删除功能 worktree/分支。

## Acceptance Criteria

- [x] Merge commit 有两个正确父提交：目标 `1da42d0` 与功能 `827fdef`。
- [x] 7 个文本冲突逐项语义整合；目标内容错误规则和功能亲和/provider 功能均有可执行测试。
- [x] 自动合并文件经过完整 diff/API/schema/UI 检查，没有隐藏字段、草稿、日志、统计或安全契约回退。
- [x] 完整项目门禁通过；真实浏览器仍受缺少 `agent-browser` 阻塞，未声称通过。
- [x] `feat/quota-forecast-panel` fast-forward 到已验证 merge commit `ca3becd`。
- [x] 目标 worktree 原有 52 个未提交条目在合并前后状态与 SHA-256 完全一致，未被暂存或提交。
- [x] integration worktree 将在提交本任务记录后保持干净；未推送、未部署。

## Out of Scope

- 重写任一功能、扩大产品范围或调整生产配置。
- 清理目标 worktree 的既有未提交文件或其他 worktree。
- 删除 `feat/upstream-session-affinity` 分支/worktree。
