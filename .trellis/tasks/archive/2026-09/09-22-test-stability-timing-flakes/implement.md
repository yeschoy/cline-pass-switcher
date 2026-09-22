# Implementation Plan

## 0. Scope discipline（已与用户确认：最小改动）

- 只修 `research/flake-evidence.md` 记录的 3 个已知 flake。
- 其余时间点（另外 ~30 处睡眠 / 墙钟断言）**只在负载协议下被实测证明会失败时**才改，并给出该次失败证据；不做“顺手统一改造”。
- 不新增规划条文，不扩大改动面。

## 1. Preconditions

- [ ] Confirm working tree is clean and current HEAD contains the latest `test/integration.test.js`（本任务基于 `2c25cc7`）。
- [ ] Re-run the bounded-load reproduction protocol once to confirm the flake is still reproducible in this checkout (evidence: `research/flake-evidence.md`).
- [ ] Freeze the baseline counts: full-suite test count, assertion-bearing flaky tests, and the two wall-clock assertions (`:1355`, `:1790`).

## 2. Shared fixtures and wait helpers

- [ ] Inventory every synchronization point in `test/integration.test.js`: fixed sleeps, `waitUntil` calls, injected `CLINE_PASS_TEST_*` deadlines, wall-clock assertions.
- [ ] Add reusable condition-wait helpers only where a pattern repeats (e.g. wait for a specific quota `refresh.state`, wait for `rows.length`, wait for `active === n`); do not create a second generic polling framework.
- [ ] Document each helper's budget semantics and failure message; keep `waitUntil()` as the single polling owner.

Checkpoint: helper additions contain no product-code dependency and every existing `waitUntil` call still compiles untouched.

## 3. Fix `shared quota admission coalesces …` (`:1777`)

- [ ] Decouple "absolute deadline" from "publication complete": wait for the target observable state (account `quota.refresh.state` / row admission) before releasing each mock batch.
- [ ] Raise the injected semantic deadline to a load-tolerant budget and keep asserting convergence (not an absolute constant) after it.
- [ ] Replace the fixed `setTimeout(20/30/…)` gates with observable-state waits.
- [ ] Preserve every invariant in `design.md` §3; re-confirm with the existing assertions unchanged.
- [ ] Reverse-verify: with the fix temporarily reverted, reproduce `refreshed 3 !== 4` under load; with the fix, 3 consecutive bounded-load runs pass.

Checkpoint: no assertion weakened; flake no longer reproducible under the protocol.

## 4. Fix `canonical scoped error rules …` (`:2549`)

- [ ] Identify which condition the 5s `waitUntil` waits on and why it can exceed the budget under load (waiting on the wrong object vs genuinely long work).
- [ ] Fix the condition (or give an explicit, justified budget); do not blanket-raise the default budget.
- [ ] Reverse-verify with the same strategy as §3.

Checkpoint: rule-action/sample matrix assertions and hard-quarantine persistence assertions unchanged.

## 5. Fix `the 50,000 account-minute union cap …` (`:1621`)

- [ ] Reduce fixture scale through the existing `CLINE_PASS_TEST_*` limit hooks to the minimum that still proves atomic eviction plus `coverage`/`incompleteAt` marking (provider/model limits stay independent).
- [ ] If the hook route is insufficient, cut fixture-construction cost (object reuse, avoid full re-serialization) without changing assertions.
- [ ] Confirm the test still fails if the eviction/marking logic is broken (mutation check) rather than only being fast.

Checkpoint: assertion set unchanged; runtime materially lower under load.

## 6. Wall-clock assertions and residual sleeps

- [ ] Re-derive the budgets for `elapsed < 200` (`:1355`) and `elapsed < 500` (`:1790`) from measured bounded-load behaviour; keep the semantic direction and improve failure messages.
- [ ] For every remaining fixed sleep, either replace it with an observable-state wait or annotate it with a bounded reason.

Checkpoint: no "sleep then assert" pattern remains on a critical path.

## 7. Verification and final gate

- [ ] Run the bounded-load protocol 3× (0 failures, test count ≥ 194) and the idle protocol 3× (all green); clean up load processes and temp logs afterwards.
- [ ] `node --check server.js`; `git diff --check`; `git status` shows only `test/**` (plus `server.js` test-hook lines if unavoidable).
- [ ] Produce the invariant-by-invariant accounting and the before/after evidence for each of the three flakes.
- [ ] Trellis check, spec update (if a test-synchronization rule belongs in the specs), commit, archive; no deployment.

Rollback: revert the task commit; no product defaults were changed, so no runtime rollback is required.
