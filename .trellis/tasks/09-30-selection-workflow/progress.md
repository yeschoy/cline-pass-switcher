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
- Task4: implementation complete; drag/narrow/confirmation browser coverage remains pending due to Mac lock. Final UI14/14 focused tests pass; real localhost save/reload and historical binding-hit count2→2 verified. Mac locked before reset-confirm cancellation, mouse drag and narrow layout could finish. No production changes.
- Task5: code/docs/review fixes complete; final whole suite414/414, source/UI syntax and diff checks green. Browser-only remaining coverage tracked explicitly; task stays in_progress until that check can run.

- Ruling: draft restore means the last loaded saved config, not durable server version history; no new history store is introduced. Cost: older saved versions require an external config backup.
- Ruling: browser automation is currently blocked by the locked Mac; label gesture/narrow verification pending rather than infer success from VM tests.

## Fresh-context final review and fixes

- Reviewed immutable range e16db146..849cc245. Baseline review suite408/408 green. Reviewer found3 Important,2 Minor; no Critical.
- Important env-only account count pruning: RED showed count2 become empty after restart; fixed by retaining the same envAccountId set used by other metadata. GREEN in19-case workflow integration run.
- Important reset double-submit after redraw: RED button re-enabled mid-request; fixed dedicated reset pending flag and entry guard. GREEN UI14/14.
- Ruling: re-grade false conflict on clean refresh to Important because it blocks a normal refreshed configuration from saving. RED reproduced old revision/conflict after loading new cache parameters; preserve the pre-read dirty state. GREEN UI14/14.
- Ruling: replace per-selection bulk saveMeta with a compact authoritative selection-counters.json written by the existing server/atomicWriteJson owner. This changes planned physical storage, not counter semantics, to satisfy the no-new-admission-hotspot requirement. Every selection still persists synchronously; no debounce loss window. Cost: backups include the companion file; old binaries do not advance it. Metadata fallback is only on absence and explicit reset is persist-first. RED missing snapshot / bulk rewrite; GREEN held-upstream test proves snapshot updates before completion without touching bulk metadata.
- Representative local microbenchmark:50,000 account-minute cells,25,472,576-byte bulk file versus1,580-byte counter snapshot. Old full atomic write mean61.68ms/5 runs; actual new record function mean0.276ms/p950.322ms/100 runs;0 bulk writes on new path. Existing completion-time full writes remain unchanged. See research/counter-persistence-cost.json.
- Final: minor (deferred): MAX_SAFE_INTEGER global tie sequence cannot be recovered by owner count-reset UI alone. Natural exhaustion is impractical, but manually seeded extreme state requires offline sequence/lastSelected recovery preserving real counts. Do not claim reset fixes this boundary.
- Ruling on declined scope: pre-existing incomplete-SSE accounting, general-429 and socket defaults remain unchanged; fixing them here would mix independent behavior. Cost: those production limitations remain.
- Ruling on declined scope: no local model/mock/microbenchmark demonstrates production limits or exact upstream/IP scope; production verification needs a separate deployment/run.
- Ruling on declined scope: browser drag/narrow/confirm-cancel remain unverified while Mac is locked. Keyboard reorder, localhost save/reload, binding-hit2→2, counters and unsampled health were directly verified.
- Ruling on declined scope: inherited account-config commit followed by failed bulk-metadata save can report failure after config changed; not introduced here, deferred to its own transaction contract.
- Approval review rejected the combined docs/test command because it would overwrite the short Trellis design pointer with the canonical spec. Inspected both files, preserved the pointer and appended only a focused amendment; diff verified. Retried only the separate test command. No unresolved approval block.

- Final verification: npm test414/414 passed in89.5s after review fixes, including21 workflow integration,14 workflow UI and10 pure contract cases. Source and inline-script syntax passed, git diff --check clean. Browser fixture auto-stopped after30min with exactly5 synthetic model requests; no production requests. Original source main remains clean at e16db146.

## Authorized follow-on implementation (2026-09-30)

- User extended the existing worktree/branch task after9bb8f79. Initial `git status` was clean on `codex/selection-workflow`; no other worktree or production files were changed.
- Direct HTTP/HTTPS Agent default raised256→512 while retaining the1–1024 environment override/fallback; Compose examples and operator/spec docs match. Proxy Agent remains32, account cap/RPM and wait/first-event/stream-idle limits are independent. Local socket override2 proved3 leased /2 upstream-arrived /1 Agent-queued; invalid zero proved513 leased /512 arrived /1 queued before release, so it cannot mean unlimited.
- Reused `accountWorkflow.healthFilter`/`minimumHealth`; filter remains disabled by default and enabled UI starts at20%. The inclusive gate now protects binding hits as well as miss/replacement selections, with unsampled accounts admitted at100% even under `unknown-last`. Low-health binding invalidates, reselects and counts once. Preview/runtime/log trace includes the bounded threshold and binding invalidation. No eligible account returns a threshold-specific503 instead of bypassing it.
- Workflow account-health projections cache within the current statistics generation/minute and clear on statistics prune/commit and account save. Live capacity, RPM and hard eligibility are never cached; rank, lease and counter mutation still have no `await`. Per-selection compact atomic snapshots remain synchronous; no debounce or new shared store.
- Checked-in `Dockerfile`, package start script and both Compose examples use a single Node process/app service with no cluster or replicas. Thus admission/counter atomicity is process-local. No evidence requires Redis/database for this deployment shape; multiple instances sharing state would need a separate shared atomic owner.
- Added regressions for20% equality, below-threshold binding migration, `unknown-last` unsampled routing, empty-pool reason,429 replacement,500 concurrent requests, reset/read/config/disable/delete interleavings, existing restart/write-failure semantics and UI draft/trace display. Local43×6:258 leases/258 observed mock-upstream requests/0 socket queue, each account6. Local500 burst:258 leased and upstream-in-flight,242 local429,0 socket queue, each account6; no per-account cap was raised.
- Performance evidence is in `research/performance-2026-09-30.md` with environment,43/49,966-cell scales, ranking/hash/JSON/scan microbenchmarks, local throughput/event-loop delay, compact write cost and durability limits. The500-burst event-loop p99 varied substantially across short runs; this is not a production upstream limit or steady-state benchmark.
- Real in-app browser on synthetic localhost: mouse drag visibly exchanged health/quota nodes and marked the draft dirty. At390px, document scrollWidth375px and workflow/node/property/button boxes fit within390px. A nonzero counter stayed unchanged after automated reset-button interaction, but the browser auto-handled the native confirm and no manual cancel-dialog frame was captured; retain that precise gesture as not fully verified. The synthetic fixture tab and server were closed/stopped; its Trellis state record and temporary data were not cleaned.
- Final gate after the513-socket boundary refinement: `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test`420/420 passed in62.4s; server/lib/UI/performance-script syntax, both Compose `config --quiet` checks and `git diff --check` passed. No push, production deploy or real upstream pressure was performed.
