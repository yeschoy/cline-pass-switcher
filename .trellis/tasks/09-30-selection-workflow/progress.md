# Ledger — plan: docs/superpowers/plans/2026-09-30-selection-workflow.md

## Baseline

- Product base e16db14633b397d4edd809cdfafa7c6ed2db999c, branch codex/selection-workflow.
- Native worktree tool unavailable for the non-Git chat directory; created an isolated Git worktree in the writable workspace using the canonical product repo.
- Offline npm cache was incomplete. Copied existing installed node_modules only after exact package-lock equality check; no dependency/version changes.
- Full baseline:369/369 passing, approximately60s. Log /tmp/cline-workflow-baseline-tests.log.
- No runtime code changes yet. Scope and implementation plan are saved.

## Rulings

- User's explicit feature requests and three concrete scope answers authorize local implementation; do not add repetitive approval gates for already confirmed choices. No production edit/deploy is authorized by this local step.
- Use current active-cache membership and minimum actual selection count; preserve raw unknown health statistics and map only effective routing health to100%.
- Preserve static intermediate artifacts under the user's cleanup instruction; do not follow generic skill cleanup deletion automatically.
- Quota-node ruling: filtering reserve again would duplicate cache membership and make the editable node uninformative. Add a strict allowed-role subset hot/warm/unknown, default all three; this preserves the confirmed active-cache scope and exposes an actual optional filter without hidden role priority. RED test observed missing quotaPools before implementation.

## Tasks

- Task1: complete. RED: module import failed before implementation. GREEN:9 pure contract tests passed, covering strict workflow validation, unknown-health100 without fake samples, minimum-count primary ordering, occupancy/rotation ties,181 selections over18 accounts, distinct alternate pickers, persisted state corruption and prototype-safe IDs. Node syntax passed.
- Task2: complete. RED: all7 initial runtime cases failed on absent counting. GREEN:9 workflow integration cases pass, including equal new choices, zero-cost hits, concurrent caps, temporary overflow, replacement versus Provider retry, restart/rename/reactivation, owner/disabled exclusion, new-account0 catch-up and metadata-write recovery. Combined existing integration/multi-client + workflow suite154/154 passes (~60s). Runtime reuses tryLeaseResult, binding tokens, cache membership and saveMeta; preview support will use a no-prune read path. Log /tmp/cline-workflow-task2-tests.log.
- Task3: complete. RED:6 management tests failed on missing projections/routes/logs. GREEN:16 full workflow integration cases and10 pure tests pass. Added optional config-revision guard, strict workflow save preservation, side-effect-free snapshot preview (including no RPM pruning), admin/CSRF-scoped persist-first resets, bounded workflow log traces, and explicit quota-role filtering. Local API old-client omission preserves the saved workflow. Logs /tmp/cline-workflow-management-green.log and /tmp/cline-workflow-task3-tests.log.
- Task4: implementation complete; final browser coverage pending. UI12/12 focused tests pass; real localhost save/reload and historical binding-hit count2→2 verified. Mac locked before reset-confirm cancellation, mouse drag and narrow layout could finish. No production changes.
- Task5: in progress; README, config example, backend/frontend contracts updated. Whole-suite and fresh-context review remain.

- Ruling: draft restore means the last loaded saved config, not durable server version history; no new history store is introduced. Cost: older saved versions require an external config backup.
- Ruling: browser automation is currently blocked by the locked Mac; label gesture/narrow verification pending rather than infer success from VM tests.
