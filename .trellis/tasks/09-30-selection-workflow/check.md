# Local verification report — 2026-09-30

Implementation branch: codex/selection-workflow. Source baseline e16db146. Production unchanged.

- Final full suite:414 tests,414 passed,0 failed,0 skipped;89.5s. Raw log /tmp/cline-workflow-final-tests.log.
- New contract coverage:10 pure workflow tests,21 real-process/mock-upstream integration tests,14 production-script VM UI tests. Existing369 tests preserved.
- Syntax:server.js,lib JavaScript and inline public/index.html script checked. git diff --check passed.
- Final independent read-only review identified3 Important and2 Minor. All3 Important plus the clean-refresh issue (regraded Important) fixed with RED→GREEN evidence; no second review per execution protocol. See research/final-review.md and progress.md.
- Runtime:43 synthetic accounts ×6 slots reserve258 concurrent leases, each count/active6; a259th is locally rejected without counting. Default256 direct sockets queue2 requests; releasing streams lets all258 complete. This is local scheduling evidence only, not production upstream capacity.
- Persistence: compact snapshot updates before the held model stream completes without a bulk META rewrite; survives environment-only account restart, legacy import, reset with stale metadata mirror; corrupt authoritative file fails without overwriting. Write failure keeps visible error/live counting, reset failure keeps prior state.
- Cost: actual new record function with43 accounts and25.5MB simulated background statistics writes1.58KB, mean0.276ms/p950.322ms over100 local runs; prior full atomic write mean61.68ms over5. Existing completion-time bulk writes unchanged. See research/counter-persistence-cost.json.
- Actual browser verified: keyboard node selection/reorder and focus; unsaved status; pure preview; save and reload preserving revision/order; request trace binding-hit count2→2; saved account counts total4 for5 synthetic requests; unknown health0 samples and100% routing display.
- NOT VERIFIED in real browser: pointer dragging, narrow viewport, reset-confirm cancellation. Mac lock blocks input and screenshot capture; user was asked to unlock. VM/API checks do not substitute for those gestures. The task remains active for these checks.
- Browser fixture automatically stopped: research/browser-fixture-state.json reports stopped:true,modelHits:5; no real credentials/upstreams. Browser close itself was also blocked by Mac lock.
- Deferred low-probability numeric boundary: global tie sequence at MAX_SAFE_INTEGER cannot be recovered with owner reset alone; requires offline repair. Existing SSE completeness and config/meta transaction edge remain separate tasks.
- No pushes, merges, deployment, production config changes, or new production model requests. No static task intermediates deleted; all Trellis history retained.
