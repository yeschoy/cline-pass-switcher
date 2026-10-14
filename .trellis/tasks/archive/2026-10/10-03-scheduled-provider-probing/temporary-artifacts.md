# 本次实施的临时测试产物（待用户同意后清理）

以下仅为 `/tmp/` 中的本地测试输出，不属于业务数据；未经用户同意不清理。项目内此记录也等同待清理的临时文档，Trellis 正式任务/日志不在清理范围。

- 初次聚焦/全量：`/tmp/probe-focused-out.log`、`/tmp/probe-ui.log`、`/tmp/probe-ui-focused.log`、`/tmp/probe-final-focused.log`、`/tmp/probe-cross-focused.log`、`/tmp/provider-probe-npm-test.log`、`/tmp/provider-probe-npm-test-final.log`、`/tmp/provider-probe-npm-test-final-retry.log`、`/tmp/provider-probe-npm-test-final-441.log`、`/tmp/provider-probe-npm-test-final-441-retry.log`。
- 续跑安全审查（先红→修复/聚焦）：`/tmp/probe-mtime-red.log`、`/tmp/probe-mtime-classification-focused.log`、`/tmp/probe-resume-ui.log`、`/tmp/probe-resume-focused-a.log`、`/tmp/probe-resume-focused-b.log`、`/tmp/probe-resume-stale-ui.log`、`/tmp/probe-resume-evidence.log`、`/tmp/probe-resume-evidence-age.log`、`/tmp/probe-resume-exploration.log`、`/tmp/probe-resume-backend.log`、`/tmp/probe-cooldown-focused.log`、`/tmp/probe-parent-cross-recheck.log`。
- 续跑全量：`/tmp/provider-probe-resume-full.log`（442/442）、`/tmp/provider-probe-resume-full-443.log`（443/443）、`/tmp/provider-probe-resume-full-445.log`（同一路径末次复用时，既有跨功能测试的重启读取断言偶发失败）、`/tmp/provider-probe-resume-full-final-retry.log`（最终 444/444 通过）。

- 第三次容量阻断续跑：`/tmp/probe-capacity-red.log`（修复前 0/5）、`/tmp/probe-capacity-green1.log`、`/tmp/probe-capacity-recovery.log`、`/tmp/probe-capacity-focused.log`、`/tmp/probe-capacity-all-focused.log`、`/tmp/probe-capacity-ui.log`、`/tmp/probe-capacity-full.log`（最终 457/457）。
- 本次独立复查全量门禁：`/tmp/probe-independent-full-gate.log`（修正完成写盘失败后独立运行，458/458）。本次本地 mock 的临时 `DATA_DIR` 均在用例或一次性反例结束时清理；该日志未经用户同意不清理。

所有模型交互在测试生成的临时 `DATA_DIR` 与本地 mock 上游内；用例结束时清理各自数据目录。没有读取项目根的 `config.json`、`metadata.json`、`data/`，未调用真实上游或生产配置。
