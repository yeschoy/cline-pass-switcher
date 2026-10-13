# 排查代理 socket hang up

## Goal

只做诊断：弄清生产「socket hang up / 约 60s 代理断连」的主因与账号/出口建议；**不改代码、不动生产配置**。

## Scope decision

- 用户选择：**1 — 只诊断**
- 交付物：任务内诊断报告（`research/diagnosis.md`）+ PRD 验收勾选
- 明确不做：代码改动、生产账号/代理变更、主动探测流量（除非另开任务授权）

## Requirements

- 区分三类信号：字面 `socket hang up`、≈60s Agent/传输超时形、其他上游失败。
- 判断是否绑定特定 SOCKS 出口 / 账号。
- 给出运维向建议与回看指标；代码方向仅作「将来可选」记录。
- 报告与对话不回显代理凭证或完整带密 URL。

## Acceptance Criteria

- [x] 根因结论：字面 hang 偶发 + 更大簇为 ≈60s `transport_proxy`（与 `proxyAgentOptions.timeout=60s` 同形）；非全站代理池整体故障。
- [x] 仍在用出口/账号建议：优先核对 `15.235.125.171:1080` / `zxg-10.13-04`；`zxg-10.13-03` 已删除与尖峰消退一致。
- [x] 代码改动不在范围；可选后续方向已记在诊断报告。
- [x] 运维回看指标已写出（hang 规则计数、≈60s proxy 失败、按 host 聚合）。

## Notes

- 详细论述见 `research/diagnosis.md`。
- 轻量任务：PRD + 诊断报告即可；无需 `design.md` / `implement.md`。
- 激活与收尾需用户确认本规划摘要后，再 `task.py start` → 核对报告 → `finish`/`archive`。
