# Implementation

Execute [the five-task plan](../../../docs/superpowers/plans/2026-09-30-selection-workflow.md) inline with red/green tests and a final independent review.

- Baseline:369 tests passed,0 failed, Node26; original product checkout unchanged.
- Use the ledger in this task directory to survive compaction. Preserve all other tasks.
- Each implementation task owns its verification/commit. Production deployment is excluded.

## Follow-on execution (2026-09-30)

1. Trace current workflow admission, binding, preview, transport, persistence and deployment topology; preserve the clean `codex/selection-workflow` worktree and existing tests.
2. Reuse the health-filter fields and add inclusive threshold coverage for binding hits and miss/replacement paths; keep a single bounded trace contract in the UI, preview and ordinary logs.
3. Change only the direct socket default to512, update the Compose/operator examples, and distinguish lease, Agent queue and upstream arrival in local mock tests.
4. Profile the small selector and counter snapshot plus large synthetic health scans; optimize repeated health projections without changing per-selection durable writes.
5. Test 43x6, a500-request burst, concurrent admin read/reset/config/disable/delete with held leases, restart and persistence errors. Run focused checks, full project gate and available real-browser interactions. Record results and limitations, then commit all code and Trellis changes; do not deploy or clean static artifacts.
