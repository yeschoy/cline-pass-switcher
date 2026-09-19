# Main 收敛设计

1. 在独立 `main` worktree 记录 `main...feat/quota-forecast-panel`，要求 main 左侧提交数为 0。
2. `git merge --ff-only feat/quota-forecast-panel`。
3. 更新 deployment spec，创建规范提交及任务记录提交。
4. 运行完整项目门禁。
5. `git push origin main`，确认本地/远端 main 相等。
6. 对原工作区 dirty 状态做 path/status/SHA-256 快照，移除 main worktree后在原工作区 `git switch main`，复核快照不变。
7. 删除本地 `feat/quota-forecast-panel` 分支；远端 feature 保留。
8. 清理本地 `/tmp/cps-affinity-source-*` 与远端本次 release upload tar；保留生产 release、candidate、verification、backups、images、logs。

任何非快进、测试失败、推送拒绝或 dirty 快照变化均停止，不 reset/stash/force。
