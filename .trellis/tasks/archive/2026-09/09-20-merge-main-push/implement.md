# 执行计划

- [ ] 初始化 worktree 开发者上下文并激活任务。
- [ ] 证明 main 是 feature 祖先，执行 `git merge --ff-only`。
- [ ] 更新 main-only 部署规范并提交任务文件。
- [ ] 运行 server/lib/UI syntax、完整 npm test、diff check。
- [ ] 推送 `origin/main` 并验证 refs 相等。
- [ ] 快照原工作区三个 dirty 路径，移除 main worktree，原工作区切到 main并复核。
- [ ] 删除本地已合并 feature 分支和批准的本地/远端临时包。
- [ ] 归档任务并记录 journal；不删除远端 feature 或生产制品。
