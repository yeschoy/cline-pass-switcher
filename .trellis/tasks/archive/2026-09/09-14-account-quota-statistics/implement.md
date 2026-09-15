# Statistics Quota Implementation Plan

## Activation and Dependency Gate

- [x] User reviewed the task set and explicitly approved continuing all remaining work with “全都执行”.
- [x] Both manifests validate with real spec/research entries; current task/branch and prior changes were verified.
- [x] Bulk concurrency, raw scheduling JSON and detailed logging passed their feature gates. The subsequent test-only follow-up truthfully exposed the planned global quota-admission defect, which this child owns in ordered steps 2–4.
- [x] This child is activated (`in_progress`); all dispatches begin with `Active task: <task.py current path>`.

## Ordered Work

1. [x] Read `research/quota-refresh-ownership.md`; trace every `quotaProjection`, `refreshQuota`, scheduler, account-save invalidation and statistics navigation caller. Preserve parser, metadata schema, strict fresh-routing predicate and empty-key persistence behavior.
2. [x] Add failing local-mock regressions for the missing global admission cap and individual-disable publication fence. Use actual live transport accounting and explicit response barriers, not the old fixture's prematurely decremented synthetic counter.
3. [x] Implement one shared per-account admission/promise owner with two slots, cache/backoff rechecks, bounded page owners, source tokens and cancellation. Keep aborting work ID/slot-locked until settlement; prevent old-finalizer replacement deletion and duplicate forced work.
4. [x] Separate account generation from routing epoch. Preserve key/proxy/deletion cache invalidation, retain disabled last-good data, and fence old routing callbacks across off/on. Publication requires both valid identity and a live requesting source.
5. [x] Add an absolute quota-fetch deadline with the existing timeout constant/controller; ensure input and upstream early-close/abort paths settle. Reuse preceding transport/capture fixes rather than adding competing consumers/listeners.
6. [x] Add strict authenticated POST `/api/statistics/quota-refresh` with one finite request-owned sweep and safe outcome counts. Validate before admission; register response-close withdrawal before awaits; no IDs/keys/proxies from the browser and no config writes. Keep GET free of new quota initiation.
7. [x] Extend statistics quota with safe view timestamps/eligibility/refresh metadata and explicit used/remaining/reset/partial/stale/failure labels. Retain current quota routing status/pool semantics and do not merge old windows into a partial fresh snapshot.
8. [x] Add the statistics visit timer/controller, entry cache reuse, manual success-cache bypass, coalescing and generation-guarded success/catch/finally. Leave/pagehide cancels only page ownership; preserve all account/raw/bulk drafts and ordinary/detail log state.
9. [x] Execute the complete QC1–QC8 matrix and earlier-feature regressions; perform fresh quality review and manual browser checks. Only then hand off for parent AC1–AC5 integration and verified spec updates.

## Required Verification

Use existing temporary `DATA_DIR` and local upstream/proxy helpers; clear real credential/base environment overrides. No production server or account credentials are required.

```bash
node --check server.js
node --test test/ui-contract.test.js test/account-draft.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node --test --test-name-pattern='quota|statistics|account HTTP proxy' test/integration.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node --test test/integration.test.js
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

Execution evidence (trellis-check, retained corrective pass): server and embedded-browser syntax passed; UI/draft tests passed 23/23; focused quota/statistics/proxy integration passed 11/11; full integration passed 44/44; full `npm test` passed 127/127; `git diff --check` passed; no files are staged. The combined delayed-body/identity-rotation regression first failed 0/1 because a replacement identity reset its success version, then passed 1/1 after key/proxy replacement retained the monotonic per-account version while true deletion alone removes it. Prior live-owner force scoping, page lifecycle, truthful quota rendering, body cancellation, A→B→A generation fencing, and all earlier features remain green. The final retained read-only reviewer returned `OK` with no findings; durable report: `/Users/lyh_god/.pi/agent/sessions/--Users-lyh_god-GolandProjects-cline-pass-switcher--/subagent-artifacts/outputs/151ef942-66bf-4158-9061-0f6be09392f0/reviews/quota-identity-version-retry.json`.

Parent browser acceptance used real isolated Chrome 152 and a temporary real backend/local quota fixture with routing disabled. Keyboard Enter opened statistics and triggered manual refresh; the native button busy state and `aria-live` completion text were observed. Entry reused the five-minute cache, manual refresh queried only the enabled keyed account, and `config.json` bytes stayed identical. Used/remaining/reset labels, known 0%/100%, disabled last-known values, escaped HTML-like account text, draft preservation, page transition restoration, desktop layout and a 500px horizontally scrolling table passed. The parent inspected both screenshots. Evidence: `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-quota-browser-evidence-EKXBTd/report.json` with sibling `desktop.png` and `narrow.png`. Real browser `PageTransitionEvent` ownership was exercised, but a true history BFCache restoration and screen-reader audio are not claimed.

## Acceptance Evidence Matrix

| Criterion | Required cases |
|---|---|
| QC1 | Distinct per-account 5h/week/month fixtures; 0/100/fractional usage; missing/partial/invalid windows, invalid/missing resets, no monetary/token invention, safe names |
| QC2 | Routing off entry refresh/config bytes unchanged; last-success-based five-minute cache; expired automatic refresh; force/manual bypasses success cache only; timer exists only on statistics visit; leave/pagehide cancels future/pending page work; routing still runs |
| QC3 | Disabled with/without retained snapshot; no disabled calls from manual/background; keyless normalization remains unchanged; synthetic unconfigured projection renders safely; unsaved drafts never become server query inputs |
| QC4 | Failed/stale/partial last-good values labelled; latest partial replaces all windows rather than merging old ones; 15-minute routing freshness and pool thresholds unchanged; safe timestamps/categories only |
| QC5 | Multiple pages plus forced/background calls and overlapping account-save scheduler runs globally <=2; same-ID promise join; no sequential duplicate forced calls after a new success; failure backoff applies everywhere; model traffic completes while quota is held |
| QC6 | Before-admission and during-header/body departure; one page leaves while another/routing owns the job; routing off/on and stale callback rearm; disable/re-enable and key A->B->A; proxy rotation/deletion during queued/running jobs; old finalizer cannot touch replacement; owner cancellation does not create failure/backoff |
| QC7 | Existing stats/health/selection/preset tests; pending raw/bulk/account edits survive statistics navigation/manual/auto/error; detailed mode on does not capture statistics refresh or quota upstream traffic |
| QC8 | VM tests execute production rendering/lifecycle; stale catch/finally cannot mutate hidden/new visit; static labels/live feedback plus manual keyboard, full names/reset times, narrow scrolling and clear loading/error states |

Resource/error cases: excess page batches reject safely before new jobs; all owners/listeners/deadlines settle; a slow-drip upstream hits the absolute quota timeout; routing scheduler does not clear/rearm from an obsolete callback; finite sweeps never wait through backoff or automatically retry forever. Simulate metadata write failure and ensure safe diagnostics without breaking model traffic.

Use existing accelerated `CLINE_PASS_TEST_QUOTA_{SUCCESS,FAILURE,TIMEOUT,STALE}_MS` hooks, fake frontend timers and explicit network barriers. No production configuration knobs or test-only scheduling framework should be added merely to make tests easier.

## Review, Spec Update and Rollback

Expected application files: `server.js`, `public/index.html`, `test/integration.test.js`, `test/ui-contract.test.js`, `test/account-draft.test.js`. Keep changes scoped to quota/statistics and necessary shared admission/cancellation boundaries; no new dependency/config schema/panel.

Update verified backend quota source/identity/cap/backoff and frontend statistics lifecycle/display contracts during finish. Existing spec wording that all refresh requires quota routing must be narrowed explicitly, not erased along with valid routing guards. Preserve detailed-log exclusions.

Do not report final completion until the parent verifies AC1–AC5 together. On failure preserve partial diff and evidence; rollback only this child's reviewed code changes if requested, retaining all earlier features and operator config/metadata/logs. No activation, commit or archive is authorized by this planning document.

## Final Four-Feature Integration Record

The 2026-09-14 parent integration gate verifies AC1–AC5 together. Quota/statistics/proxy integration passed 11/11 and the initial combined gate passed UI/draft/detail 27/27, integration 44/44 and full suite 127/127. A subsequent P1 correction was confined to detailed-log credential sanitization; the final combined integration suite passed 45/45 and full suite 129/129, followed by an independent **OK / no findings** review.

QC1–QC8 remain satisfied: truthful window labels and freshness, routing-independent entry/manual refresh, disabled/unconfigured fences, global two-slot admission, deduplication/backoff, page/routing source ownership, identity rotation/deletion/disable protection, unchanged chat/SSE/routing behavior and no quota entry in chat statistics or ordinary/detailed logs. Verified quota contracts are now recorded in backend quality/persistence and frontend state/quality specs. The Chrome 152 report at `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-quota-browser-evidence-EKXBTd/report.json` and both screenshots were re-read. It proves temporary-backend/config-byte preservation and keyboard/narrow behavior, but not screen-reader audio or true browser-history BFCache restoration. The index remains empty; no commit, push or archive occurred.
