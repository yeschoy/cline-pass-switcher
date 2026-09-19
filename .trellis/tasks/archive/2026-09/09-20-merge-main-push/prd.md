# 收敛到 main 并推送

## Goal

将已部署、已验证的 `feat/quota-forecast-panel@cd0dd36` 安全快进到 `main`，固化“完成的任务先合入 main，生产只部署 main 已提交 HEAD”的项目规范，推送 `origin/main`，并清理已批准的非业务临时产物。

## Requirements

- 在干净独立 worktree 操作 main；原工作区三个未提交路径不得覆盖、暂存或提交。
- `main` 必须是 feature 的祖先，只允许 `--ff-only`，不制造额外代码冲突或重写历史。
- 更新 `.trellis/spec/backend/deployment-guidelines.md`：正常生产发布源必须是已合入 main 的 committed HEAD；feature 直接部署仅在用户明确批准的紧急例外下允许，并须补回 main。
- 在 main 上运行至少完整 syntax、npm test 和 `git diff --check` 后再推送。
- 推送目标仅为 `origin/main`；不 force push，不自动删除远端 feature 分支。
- 推送后将原工作区切换到 main，验证 `AGENTS.md`、`untitled.md`、`.pi/subagents/` 的状态/内容保持。
- 删除本地收尾 worktree、已合并本地 feature 分支、本地部署临时目录和远端 `/tmp` 上传 tar；不删除生产 release/image/log/backup/evidence。

## Acceptance Criteria

- [x] main fast-forward 包含 feature 全部提交和部署证据。
- [x] 部署规范明确 main-only 正常发布流程。
- [x] main 完整门禁通过并成功推送到 origin/main，无 force。
- [x] 原工作区切到 main，既有未提交路径状态与 SHA-256 未变化。
- [x] 已批准的本地/远端临时产物和本地已合并 feature 分支完成清理。

## Out of Scope

- 删除远端 feature 分支。
- 再次生产部署。
- 清理生产制品、Trellis 证据或其他 worktree。
