# 高用量账号低并发优先消耗（drain 档）

## Goal

当前额度投影把"三窗口最大用量 ≥95%"的账号判为 `reserve` 并剔出缓存池，导致周额度接近用完、但月额度还剩一半的账号完全闲置（线上 2026-10-20 有 12 个）。
改为：用量 ≥ 阈值（默认 95%）且 < 100% 的账号进入新的 **drain 档**——并发上限降为 N（默认 2），并在 Workflow 新选号时优先使用，把残余额度先用掉。

## Requirements

1. **drain 档判定**：额度快照完整新鲜时，三窗口最大 `percentUsed` 满足 `drainThreshold ≤ max < 100` → `drain`；`max ≥ 100` 仍为 `reserve`（继续剔除）。
2. **仅在 Workflow 启用且 drain 开关打开时生效**；关闭时行为与现状完全一致（≥95% 即 reserve）。Legacy / Pipeline 路径不变。
3. **并发上限**：drain 号的有效并发 = `min(账号 maxConcurrent（0 视为不限）, drainMaxConcurrent)`；所有并发判定（准入、等待预算、缓存池扩容判断、诊断）使用有效值。
4. **新选号优先**：Workflow 的新选号 / 临时溢出 / 换号时，先在 drain 候选中按当前 selector 选；drain 号全部满并发或被过滤后，再选其他号。
5. **不影响已有绑定**：绑定命中照常复用绑定账号，不因存在空闲 drain 号而失效或迁移。
6. **可配置**（`accountPipeline` 新字段，控制台可改；只在 Workflow 启用时生效。放在 accountPipeline 是因为旧镜像启动时会静默丢弃 accountPipeline 未知字段，而 accountWorkflow 未知字段会导致启动失败——保证镜像可直接回退）：
   - `drainEnabled`：默认 `false`（升级不改变线上行为，需在控制台打开）
   - `drainThreshold`：百分比，默认 `95`，范围 `(warmThreshold, 100)`
   - `drainMaxConcurrent`：正整数，默认 `2`
7. drain 号仍受 quota 以外的全部过滤：硬状态、冷却、额度保护、health 过滤、RPM。
8. quota 过滤（`quotaPools`）不排除 drain 号（drain 由自身开关控制，避免旧配置把它滤掉）。
9. **warm 分界可配置**：新增 `accountPipeline.warmThreshold`（百分比，默认 `80` 保持兼容，范围 `0 < x < 上界`，上界 = drain 启用时的 `drainThreshold`，否则 `95`）。线上计划设为 `90`：用量 <90% 为 hot，90% 至 drain 阈值为 warm。对所有使用额度分组的路径生效（Workflow 缓存池成员、Pipeline quotaPool 分组、低额度角色）。
10. **`roundrobin` 选择器改为"最久未选优先"（LRU）**：在当前可用候选中选 `selectionCounters.accounts[id].lastSelected` 最小者，并列按 id 升序；不再使用 `sequence % 候选数` 游标。drain 档与普通档各自独立按 LRU 选；不同客户端 key 号池天然独立。绑定命中不更新 `lastSelected`（与现有计数规则一致）。控制台标签改为"轮询（最久未选优先）"。`least-selections` / `least-connections` / `health` 不变。
11. 可观测：请求日志 workflow 决策节点、选号预测、账号列表/统计页能看出账号处于 drain 档及其有效并发。

## Acceptance Criteria

- [ ] `drainEnabled=false`：现有全部测试通过，行为与改动前一致。
- [ ] `drainEnabled=true`：95% ≤ 用量 < 100% 的号进入活动缓存池，`quota.pool === 'drain'`；用量 100% 的号仍不进池。
- [ ] drain 号同时在途达到 `drainMaxConcurrent` 后，不再被新准入；账号自身 `maxConcurrent` 更小时取更小值。
- [ ] 新会话在存在空闲 drain 号时选中 drain 号；drain 号全部满载时选到普通号。
- [ ] 已绑定在普通号上的会话，在 drain 号空闲时仍命中原绑定。
- [ ] 配置校验：非法 `drainThreshold`（≤ warmThreshold、≥100、非数字）与 `drainMaxConcurrent`（0、负数、非整数）被拒绝；strict 保存时未知字段仍被拒绝。
- [ ] 旧镜像兼容：新镜像写回的 config（含四个新字段）被 HEAD 版本 `normalizeAccountPipeline` 非 strict 启动路径接受（字段被丢弃，不抛错）。
- [ ] 控制台可查看/修改三项配置；选号预测能预测 drain 优先结果。
- [ ] `warmThreshold=90`：用量 87% 的号投影为 hot，92% 为 warm；缺省时仍按 80 划分；`warmThreshold ≥ 上界`或非正数被拒绝。
- [ ] 控制台可修改 `warmThreshold`，说明文案中的 80% 改为显示当前配置值。
- [ ] `roundrobin`：N 个空闲号连续 N 次新选号各选中一次且顺序稳定；某号因满并发被跳过后，空闲时下一次优先选中它；新增号（lastSelected=0）只被立即选中一次后进入正常轮转，不连续扎堆。
- [ ] `npm test` 全部通过。

## Out of Scope

- Legacy / Pipeline 路径下的 drain 支持。
- 让绑定会话主动迁移到 drain 号。
