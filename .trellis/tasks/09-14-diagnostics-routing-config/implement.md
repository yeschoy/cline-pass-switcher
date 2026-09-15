# Parent Execution and Integration Plan

> Scope includes all four deliverables. The user approved implementation with “开始”; planning artifacts and all ten manifests are validated. Child activation and quality gates remain sequential. Commit/push authorization is separate.

## Planning/Activation Gate

- [x] User reviews the parent summary and each child PRD/design/plan, including detailed-log route/completeness and quota source/cancellation policies.
- [x] All ten child/parent implement/check manifests, including the new quota child, validate and contain real spec/research entries.
- [x] Confirm current branch, task and pre-existing work; do not modify `.pi/plan/` or operator data.
- [x] Only after approval, activate `09-14-bulk-account-concurrency`. Keep this parent as the requirement/integration owner.

## Planning Validation Record

Final four-feature planning validation on 2026-09-14: all five `task.py validate` commands passed; 15 required Markdown artifacts and ten manifests with 62 real entries exist; all five parent/child tasks remain `planning`. The added quota PRD and parent requirements were converged against the confirmed scope; prior R1–R3 artifacts remain intact. `git diff --check` passed and application-path diff is empty. This supersedes the earlier R1–R3-only readiness record. No application tests, implementation, activation, commit, or archive have been performed. The current planning pointer remains the quota child; after final approval, the first implementation target is bulk concurrency.

## Execution Start

The user approved all four implementations with “开始”. The current session had lost its task pointer following existing Trellis updates; it was restored by activating the bulk-concurrency child (`in_progress`). Application paths were unchanged at start. Seventy pre-existing non-task dirty/untracked files are fingerprinted at `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-implementation-baseline-mylegn65/protected-files.json`; preserve them, including Trellis runtime/config changes and `.pi/plan/`. Work is on `main` at source `dd3cfc0`; task activation warned that branch/base are identical, so branch/commit/archive handling must be resolved in the separately approved finish workflow rather than silently archiving.

## Check Infrastructure Recovery

The original workflow `1af4a594-0ef9-4d7c-925f-d11c37799970` stopped when logging check run `35089426-6c09-4938-95b8-abbfca32d7fe` failed with exact error `fetch failed` after loading context, before completing its QA gate. This is not an application-test assertion result. The logging writer handoff remains available and reports 70/70 automated tests; independent checking/browser acceptance remains pending.

On the user's “继续”, the parent confirmed repo `/Users/lyh_god/GolandProjects/cline-pass-switcher`, shared checkout on `main` at `dd3cfc00b70b5b7b318237b7de041b723a61fe3c`, no isolated worktree, empty index and zero differences in all 70 protected fingerprints. Current application/spec changes, including untracked modules/tests, were captured at `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-check-retry-jprdnqjt/application-before-retry.diff`. The failed checker is reported resumable; recovery will resume that exact child through the native subagent protocol and preserve its stored contract. No CLI/foreground/model fallback or repeated implementation was used. Quota implementation remains blocked on the logging acceptance gate.

## Latest Continuation Checkpoint

The user selected this parent for continuation. Durable mission `e06dc3b8-18e5-454a-a050-69212872ac96` shows a later recovery workflow, `35d2063e-8c7a-41f2-9c1a-2c910f20a579`, beyond the original fetch failure above. Its last child, `detailed-request-logging.retry-check.3` (`4f830da9-8b71-48d6-8982-0fd68745528a`), terminated with `Subagent timed out after 5400000ms.` The terminal log records 86/86 full-suite tests, focused security reproductions, syntax checks and an empty index, but no completed check handoff or independent acceptance. These are historical results, not a new gate pass.

The current application/spec snapshot exactly matches that check's final captured diff: SHA-256 `f19f5db159230b82585697c816a741548eeaff99acf63e34717220f6dddca92f`. Recovery evidence is `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-logging-continuation-g2pulcpo/` (`application-before-check.diff`, `entry-hashes.json`, `audit.json`). Repo remains `/Users/lyh_god/GolandProjects/cline-pass-switcher`, shared original checkout, branch `main`, HEAD `dd3cfc00b70b5b7b318237b7de041b723a61fe3c`; all 70 protected fingerprints match and the index is empty. No active subagent fleet exists.

The current session has no retained resumable child according to `children.list`, so recovery uses a labelled fresh same-role `trellis-check` fallback through the native async workflow, followed by fresh read-only review—not revival of an unlisted child or a CLI/foreground fallback. The logging child is restored as the active `in_progress` task at Phase 2.2. Quota remains blocked until the parent accepts the logging gate; no new implementation, commit, push or archive approval is inferred.

## Current Parent Handoff

Logging acceptance has now passed after the three bounded native continuation workflows recorded in the logging child's implementation plan. Final check: focused77/77, integration38/38, full118/118; final independent review: no issues / OK. Parent accepted source/diff/credential-resource-storage evidence plus the unchanged productionHTML's real isolated Chrome152 gate, reconfirmed32 tested file hashes,70 protected hashes,originalHEAD and emptyindex. Verified logging specs are current (Phase3.3 reviewed); no commit/push/archive occurred.

The remaining feature is statistics quota visibility, followed by the four-feature integration/finish gates. The user answered “好先修正”, approving the narrow test-only correction ahead of that feature. First fix the existing quota fixture's inaccurate in-flight accounting and synchronization without changing production quota behavior, weakening assertions, adding dependencies or starting statistics implementation. Keep quota planning/unactivated for this bounded pass. Historical failures remain recorded even though the final118-test run passed. Logging's implementation/check gate remains accepted; this test correction receives its own implement/check gate.

The approved test-only pass is now stopped: native response counting and the chat barrier are corrected, but newly added cross-configuration-phase auditing observed a real concurrent response peak of3. Workflow `353e00df-9336-4c8e-b054-58aabf38c4fc` rejected its implement acceptance (`criterion-1` not-satisfied), so independent check did not launch. Only the quota test block changed; production and protected hashes are intact. See logging child `implement.md` → Test-Only Follow-up Stopped for preserved diff/evidence. Parent has requested separate approval for a production global quota concurrency fix; do not infer it from the prior test-only answer or proceed with the larger statistics feature.

## Sequential Deliverables

1. [x] Implement/check bulk concurrency according to its plan; preserve all hidden fields and pending scheduling text. Deliver shared hydration/rendering correction and executable draft harness. Parent accepted real-browser keyboard/draft/responsive checks, exact-diff review, 34/34 suite, 20/20 integration and protected-file verification; evidence is recorded in that child's implementation plan.
2. [x] Review the common-path handoff, then activate/implement/check raw scheduling JSON. Bulk/combined draft cases, revision-2 42/42 suite, exact-diff review and parent real-browser SC1–SC6 gate passed; evidence is recorded in the raw child's implementation plan.
3. [x] Activate/implement/check detailed logging. Parent accepted all resolved security/storage findings, bounded capture/cleanup behavior, 118/118 final suite, independent no-issues review, browser/draft gate and exact protected-file audit; evidence and residual limitations are in the child's implementation plan.
4. [x] Activate/implement/check statistics quota visibility. Preserve global quota admission/identity/source fencing, draft state and detailed-log exclusions; validate QC1–QC8.
5. [x] Perform final four-child integration review against AC1–AC5 and all child acceptance matrices, then run the final full-scope checks.
6. [x] Update verified backend/frontend specs for quota admission/source/identity ownership, statistics visit/rendering behavior, persistence boundaries, and recognized credential-header assignment discovery.
7. [ ] Handle the required commit workflow only after its review gate, then use the finish-work workflow for journals/archive when appropriate. Do not automatically archive unfinished children or claim completion from artifact readiness.

## Final Integration Verification

```bash
node --test test/ui-contract.test.js test/account-draft.test.js
node --test test/detailed-log-capture.test.js test/detailed-log-store.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node --test test/integration.test.js
node --check server.js
node --check lib/detailed-log-capture.js
node --check lib/detailed-log-store.js
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

These commands define the final four-child integration gate; individual completed child results are recorded in their implementation plans. The quota feature and combined four-child gate passed in the record below.

## Final Four-Feature Integration Gate — 2026-09-14

- Reviewed the complete application diff from `dd3cfc00b70b5b7b318237b7de041b723a61fe3c`, including the two detailed-log modules and four focused test files. Current hashes are `public/index.html` `843f4ab3362f0b4b424846595d6e1bcf662d40369b6604d270669f0215abe984`, `server.js` `584cd46668adb6d03563e8f733fa2f6f37fa8ddc23f32f8f0c04d0c88a82d74e`, and `lib/detailed-log-capture.js` `cec4581fc4cadf198f68f55a7766b1bac9bfb5e758d8d4cae06546abd7ba13ad`.
- The initial integration checker passed UI/draft/detail UI 27/27, detailed capture/store plus ordinary JSONL 56/56, focused quota/statistics/proxy 11/11, focused detailed integration 18/18, full integration 44/44 and full suite 127/127. A fresh reviewer then found one P1 at `DetailRedactor.learnHeaders()`: recognized credential headers containing `Bearer api_key=<secret>` learned only wrapped forms and could leave a bare cross-body echo.
- The bounded correction reused the existing scheme-stripped bounded token/assignment discovery, suppressed recursive wrapped discovery, and added production-root plus authenticated JSON/SSE API/file/service-output regressions. Final gates passed: UI/draft 23/23, detailed capture/store 54/54, integration 45/45 and full `npm test` 129/129; syntax, embedded script and `git diff --check` passed with an empty index. Commands explicitly unset `CLINE_PASS_KEY`, `PROXY_KEY`, `PUBLIC_BASE_URL` and `PORT`; fixtures used temporary `DATA_DIR` and local upstreams.
- Final fresh review `a11d134d-2ba7-4126-b51b-d22c4465fb50` returned **OK / no findings**. It confirmed the recognized-header assignment leak is closed, exact/excess 16,384-match limits remain covered, forwarding bytes and resource cleanup are unchanged, and no new P0/P1 issue was introduced.
- **AC1 satisfied:** DC1–DC8 cover settings/restart/write-failure, route/call correlation, original and recognized-header wrapped credential discovery, body/work limits, independent retention/clear/recovery, stale UI ownership, failure/backpressure/cancellation and enabled/off traffic equivalence. Quota/statistics traffic remains absent from ordinary and detailed chat logs.
- **AC2 satisfied:** SC1–SC6 cover the five-field raw projection, validation/stale rejection, duplicate/unsaved reference names, invalid live text, cancel/focus, preservation and complete explicit save.
- **AC3 satisfied:** the shared `ACCS` plus live scheduling-control draft owner survives account/bulk/raw changes and detailed/statistics settings, reads, clear, refresh, timer and navigation. Explicit save retains active identity and hidden fields; model routing, retries, proxy behavior, SSE finalization, usage/health statistics and ordinary logs remain green.
- **AC4 satisfied:** BC1–BC5 object-identity targeting, current-filter select-all, search clearing, active-radio independence, strict 0–100000 bounds, no implicit persistence and duplicate/new/delete/reload cases pass.
- **AC5 satisfied:** QC1–QC8 used/remaining/reset and truthful unknown/partial/stale/failure display, routing-independent cache/manual refresh, disabled/unconfigured eligibility, global two-slot admission, deduplication/backoff, absolute timeout, page/routing ownership, credential/proxy/disable/delete/A→B→A fences and diagnostic exclusions pass.
- All four Chrome 152 reports and their declared screenshots were re-read. Browser evidence covers keyboard/focus/dialog/selection, narrow scrolling, draft preservation, safe text, detail clear/copy fallback and quota refresh without config writes. Limitations remain explicit: no screen-reader audio, no successful physical host-clipboard write, and no true browser-history BFCache restoration claim.
- Verified contracts are now recorded in backend quality/persistence/logging specs and frontend state/quality specs. Repository hygiene remains intact: no staging, commit, push, merge, archive, reset, live operator-data access or live config mutation.
- **Verdict: READY** for the separate commit review gate; commit/push/archive remain unapproved.

## Evidence to Collect

- AC1: DC1–DC8 results, route coverage, body/credential boundaries, independent retention/clear, failure/backpressure/memory evidence.
- AC2: SC1–SC6 results and a combined account/raw/bulk explicit-save round trip.
- AC3: pending draft survives detail/statistics navigation and settings/read/clear/refresh, invalid temporary rules survive redraw, existing presets/ordinary logs/statistics preserve behavior, and quota traffic never enters detailed chat logs.
- AC4: BC1–BC5 exact target/field comparison, selection lifetime, active identity and strict numeric boundaries.
- AC5: QC1–QC8 quota-window display, independent page cache/manual refresh, disabled/unconfigured behavior, shared global concurrency/backoff and identity/source fencing. Include overlapping scheduler runs and multiple browser owners, not just a single background loop.
- Manual browser evidence: desktop/narrow widths, keyboard row/select-all, mixed state, dialog dirty close/focus, detail copy and clear confirmation, safe arbitrary body display.
- Fresh reviewer findings and resolutions; confirm the final application diff is limited to the requested features and necessary shared paths.

## Failure and Rollback

If an implementation/check lane or tool infrastructure fails, stop that lane, preserve its partial diff, and report exact command/run/status plus cwd/branch/ref. No unapproved CLI/foreground fallback, reset, data deletion or speculative workaround. Re-plan if a security/capture/storage contract cannot be met rather than weakening an approved requirement.

Do not start a dependent child until the preceding gate is actually verified. Roll back only reviewed child changes when requested; existing server configuration and diagnostics are never reset as part of code rollback.
