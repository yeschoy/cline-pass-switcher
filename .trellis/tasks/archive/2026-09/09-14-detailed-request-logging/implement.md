# Detailed Logging Implementation Plan

## Activation Gate

- [ ] Review the converged PRD, design route/completeness matrix, and this plan with the user. No implementation or activation before approval.
- [ ] Validate both context manifests; confirm actual branch/current task and preserve existing changes.
- [ ] Bulk and raw-editor children have passed their gates; no concurrent writer in `server.js`, `public/index.html`, or shared tests.
- [ ] Every dispatch begins with `Active task: <task.py current path>`.

## Ordered Work and Stop Points

1. [ ] Re-check `research/capture-boundaries.md` against current source, especially root route allowlist, `readBody`, `clineRequest`, model-list `fetchJSON`, SSE head/pipe and final response paths. Preserve one real call per attempt and existing routing/lease/statistics ownership.
2. [ ] Add focused production-module tests for a bounded detail-only sanitizer/capture buffer. Cover configured and ephemeral credentials, ordinary content preservation, escaped JSON, fragmented SSE, invalid encoding, unsafe partial spans and 5 MiB boundaries before wiring traffic capture.
3. [ ] Implement `lib/detailed-log-capture.js` using Node-native bounded copies and context ownership. Prove credential fragments do not leak across chunks/cap boundaries. **Security stop:** do not wire or publish unsafe body capture; unresolved supported-representation failures require a documented plan correction.
4. [ ] Add/implement `lib/detailed-log-store.js` with metadata-only browsing, immutable sanitized body files, one publication/retention/clear owner, byte reservations, seven-day/1 GiB independent retention, restart recovery and failure health. **Storage stop:** no whole-body corpus query, unbounded queue, or pre-clear resurrection.
5. [ ] Add default-off `detailedLogging` configuration and strict GET/POST `/api/logs/settings`. Persist the candidate config before changing runtime mode. Add setting default to `config.example.json`; do not modify live configuration.
6. [ ] Wire allowlisted root contexts, ingress capture in the existing body reader, native outgoing call capture before consumer branching, included catalog calls, and one downstream response observation path. Preserve public API signatures/overloads, header behavior, backpressure, cancellation and existing finalization. Scope checks must exclude background quota/discovery even inside inherited async context.
7. [ ] Add authenticated detail list/metadata/body/clear routes with strict IDs/filters, no-store responses, on-demand bodies, safe missing states and store health. Do not alter ordinary log schemas/APIs.
8. [ ] Add the independent details navigation/panel, persistent toggle/retention/privacy guidance, metadata listing, on-demand attempt/body view, copy and separately confirmed clear. Preserve account/raw/bulk drafts; guard stale list/body/toggle responses.
9. [ ] Extend black-box local-mock integration for every route class, traffic equivalence, safe invalid/unread bodies, all retries, streaming heads, cancellation, settings restart/failure, and ordinary-log non-leakage with detailed mode enabled.
10. [ ] Run fresh full-scope quality checks, inspect the whole diff and complete manual browser checks. Update only verified spec contracts and relevant README usage notes in the finish phase; do not claim completion from unit/static checks alone.

## Required Verification Commands

Tests must use local mocks and temporary `DATA_DIR`. Unset inherited real credential/base overrides before launching the integration harness; never run the service against production data for these checks.

```bash
node --check server.js
node --check lib/detailed-log-capture.js
node --check lib/detailed-log-store.js
node --test test/detailed-log-capture.test.js test/detailed-log-store.test.js
node --test test/ui-contract.test.js test/account-draft.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node --test test/integration.test.js
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

Named new modules/tests are planned deliverables. None of these execution gates is claimed to have passed during planning.

## Acceptance Evidence Matrix

| Criterion | Minimum executable evidence |
|---|---|
| DC1 | Missing/false/true mode; strict invalid body/type/unknown fields; successful toggle and restart; write failure leaves config bytes/runtime unchanged; in-flight roots keep start mode |
| DC2 | All design route classes; early validation/auth/unsupported/unread states; nonstream raw upstream vs final transformed client output; per-call identity during retries, account replacement and concurrent probe validation; excluded roots/calls absent |
| DC3 | Keys/admin/cookies/proxy overrides and credential-shaped headers/JSON; known secret echoes and config rotation; secret splits across chunks/escapes/cap; ordinary text retained; detailed files/temp/API/service logs safe; ordinary log/metadata projections unchanged |
| DC4 | 5 MiB−1/exact/+1 bytes, multi-byte UTF-8 cut, huge upstream chunk, SSE head plus rest exactly once, post-start error and DONE; diagnostic cap never limits actual traffic |
| DC5 | Small clock/byte budget; true oldest-root eviction across out-of-order completions; temporary reservations counted; active-root expiry; restart/orphan/corrupt group recovery; query reads metadata but no bodies |
| DC6 | Metadata-only paging/filter validation; generated-ID path safety and missing records; on-demand body reads/copy; independently confirmed clear leaves ordinary logs intact |
| DC7 | Active stream + queued write + clear; old generation cannot recreate files; post-clear new roots are allowed; stale list/body/clear completion ignored after navigation |
| DC8 | ENOSPC/rename/read failure, budget exhaustion, cleanup errors, aborted/rejected/incomplete capture; safe health counters; byte/status/order equivalence with mode off; no hung lease/finalizer |

Additional resource checks: test bounded retained payload counters with more concurrent calls than the budget permits; instrument the store to assert listing does not read body files; use a blocked/slow writer and verify that proxy responses continue. Do not equate a 5 MiB per-body test with a global memory proof.

Browser checklist: five mutually exclusive sections; keyboard switch/list/detail/copy/clear; copy failure fallback; full sanitized content and truncation reason readable; no HTML execution from response text; narrow scrolling; loading/clearing/toggling diagnostics while raw/bulk drafts remain intact.

## Continuation Evidence and Pending Gate

Native workflow `e628c146-e4af-4759-84e4-6d6cd6318bee` resumed Phase 2.2 with fresh same-role check `811ab6f6-ebc1-4175-a6b4-974ba0b695d5`. Its completed handoff is `/Users/lyh_god/.pi/agent/sessions/--Users-lyh_god-GolandProjects-cline-pass-switcher--/subagent-artifacts/outputs/e628c146-e4af-4759-84e4-6d6cd6318bee/checks/logging-continuation.md`. It fixed ambiguous escaped-string discovery using the existing group-wide unsafe flag, added production-root/API regressions and updated the verified logging spec: focused 59/59, integration 26/26, full suite 88/88, syntax/diff checks, empty index and 70 protected hashes passed. Exact four-file incremental diff and original failing quota assertion are retained in `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-logging-fresh-check-wg7vIB/`.

The quota fixture is byte-identical to HEAD and decrements its synthetic active counter before a held response finishes. A separate temporary real-response barrier proved off/on chat returns 200 while two quota responses remain unfinished; the original failed integration run remains disclosed. This is not quota implementation or proof of all possible timing behavior.

Parent browser validation reran the existing isolated Chrome 152 driver against current production HTML (SHA-256 `0e58697006c6895bbd6bf2363601326240b2701bd714b7e43d2a895bc70f4f4c`) with only local fixture APIs and blocked external page requests. Keyboard navigation/toggle failure and success, draft preservation with zero account writes/reloads, pagination/filter reset, on-demand safe body text, native clipboard denial/selectable fallback, local-sink copy success, clear decline/accept and ordinary-log preservation passed. Parent inspected desktop/500px screenshots; document width 485px, textarea 433px without overflow. Report/screenshots: `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-details-browser-evidence-AGcd3s/`. Physical host-clipboard success and screen-reader audio were not tested.

Independent read-only reviewer `76da5ac3-f317-4b3a-ab9e-af970a31d8cd` completed with **BLOCK**; workflow `e628c146-e4af-4759-84e4-6d6cd6318bee` is terminal. Final review: `/Users/lyh_god/.pi/agent/sessions/--Users-lyh_god-GolandProjects-cline-pass-switcher--/subagent-artifacts/outputs/e628c146-e4af-4759-84e4-6d6cd6318bee/reviews/logging-continuation.md`. **The logging gate is blocked despite passing tests/browser checks.** Parent reproduced current defects with temporary production-module scripts in `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-logging-continuation-g2pulcpo/`:

- `review-probes.mjs/json`: pre-discovery replacement of known strings matching URL/Bearer syntax prevents learning a recognized credential; recognized credential-header URLs also miss component discovery. Earlier headers and root/attempt bodies retain full credentials or reconstructable suffixes while marked complete.
- `store-clear-probe.mjs/json`: after publication rename and temporary cleanup fail, recovered I/O plus `clear()` returns success but leaves sanitized `.tmp-UUID` body files; subsequent age maintenance also leaves them. No real data was touched.
- Source-proven assignment work bound defect: `text()` expands all assignment matches and repeatedly slices/reconstructs the whole input before reaching `known()` limits. Repeated `key=x;` does not exhaust distinct-secret budgets; publication is on the service event loop. No 5 MiB blocking-time benchmark is claimed.

Parent accepts all three P1 findings for a minimal corrective pass: (1) discover credential syntax from original text before substitution, plus reuse URL component discovery for recognized credential Header values; (2) bound assignment iteration/output before allocation and assemble once, reusing existing limits rather than new operator knobs or a test scheduling framework; (3) remove abandoned store-owned temporary groups at safe serial maintenance/clear boundaries and report failed deletion honestly. Add focused red/green regressions, group/API non-leakage and traffic equivalence, exact work-limit boundaries, and failed-publish/failed-cleanup recovery coverage. Preserve corrupt/unknown operator-owned data, path safety, generation fencing and current ordinary-content behavior. No general sanitizer rewrite or quota implementation is authorized.

Do not activate quota, mark this child accepted, or commit/archive based only on the 88-test result. The next native serial workflow is implement accepted fixes → quality check → independent read-only review. Parent owns the final disposition and dependency gate.

## Second Review Disposition and Final Bounded Pass

Workflow `c0bb0553-5013-4d87-8493-bc2359df8110` is terminal. Implementer `4f0dc5ae-a940-4928-8c31-32b5ee5c9120` fixed F1/F2/F3 with red/green evidence; checker `ee8dbd58-48ed-43ac-9f34-5ac472df4527` added scheme-stripped URL component discovery and verified focused 74/74, integration 34/34, full 111/111. Writer's earlier final 31/32 and 106/107 quota failures remain recorded, not superseded by this green run. The user has been asked whether to move the quota fixture counter correction ahead of the quota child; no affirmative answer has been received, so that fixture remains unchanged.

Independent reviewer `a83866c5-e0f1-41a5-bfed-4f5d3b22468e` accepts the original F1/F2/F3 fixes but returns BLOCK for one introduced regression: an outer Bearer token hides internal recognized URL/assignment syntax. Final report is `/Users/lyh_god/.pi/agent/sessions/--Users-lyh_god-GolandProjects-cline-pass-switcher--/subagent-artifacts/outputs/c0bb0553-5013-4d87-8493-bc2359df8110/reviews/logging-p1-corrections.md`. Parent verified semicolon/comma URL-tail leakage through production roots and a full `Bearer api_key=fixture-nested-secret` echo leak; witnesses are `bearer-url-delimiter-probe.mjs/json` and `bearer-assignment-probe.json` under the parent continuation evidence directory above.

Parent accepts this one root-cause correction under F1/F2 for a third and final bounded review pass. Preserve overlapping original-token discovery, monotonic match starts, nested-token accounting within the existing 16,384 cap, cumulative value-span/output budgets and one assembly. Reuse the current overlap mechanism; no per-delimiter patch, recursive whole-text scan, generic parser or new configuration. Add production-root/authenticated API/file/JSON-SSE regressions for all three shapes, plus count-based exact/over-boundary proof and ordinary/partial-content preservation. If this pass still has a blocker or needs broader design changes, checkpoint and ask the owner rather than silently starting an unbounded review loop.

Immediately before the new pass, 32 source/spec/test hashes match `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-logging-p1-check-mtyji0t9/final-hashes.json`, full diff SHA-256 `3865c870659882fef36cac7437f377d7b79175883847d9f33c1cd89db8888242`; all 70 protected hashes, original HEAD and empty index match. Logging remains at Phase 2.2; no quota activation, commit, push or archive is authorized by test counts.

## Final Parent Acceptance — Logging Gate Passed

Workflow `61987054-c77b-474d-9a95-ec9e4fc0fb70` completed. Checker `11254031-70e0-4afe-bffc-c6dfc31aadf7` fixed the accepted token-shadowing regression with one production cursor-advance line, retained all prior boundaries, and recorded red 0/7 → green 7/7, focused 77/77, integration 38/38 and final full suite 118/118. Fresh read-only reviewer `2d344589-39bf-49bb-8972-48eddc4878cf` returned **No issues found / OK** for the correction and preservation of F1/F2/F3. Reports: `/Users/lyh_god/.pi/agent/sessions/--Users-lyh_god-GolandProjects-cline-pass-switcher--/subagent-artifacts/outputs/61987054-c77b-474d-9a95-ec9e4fc0fb70/{checks,reviews}/logging-token-shadow.md`.

Parent inspected the incremental correction and review, confirmed current 32 source/spec/test hashes exactly match the tested snapshot, all 70 protected hashes remain intact, HEAD is still `dd3cfc00b70b5b7b318237b7de041b723a61fe3c`, index is empty, and `git diff --check` passes. Evidence: `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-logging-continuation-g2pulcpo/final-parent-audit.json`; full application diff SHA-256 `0d8505c3021e75e62d3465736edf514da887659312ec2dca33f5db9ac98dfb45`. Production HTML is unchanged from the parent browser gate above.

The DC1–DC8 code/test evidence, source review, resolved findings and scoped real-browser checks are accepted; no known logging blocker remains. Phase 3.3 was reviewed: checker updates already capture original/overlapping credential discovery, bounded scanning and abandoned-temporary-group recovery in the existing seven-section logging code-spec, so no duplicate spec addition is needed. Ordinary-log restrictions remain intact.

Acceptance does not claim universal secret detection, historical-log migration, minimum Node18/Windows execution, full1GiB performance, exact RSS/latency, host clipboard writes or screen-reader audio. Historical quota fixture failures remain disclosed; that fixture still matches HEAD and its correction question remains unanswered. The parent must obtain the requested scope confirmation before moving that correction ahead. No quota activation, staging, commit, push, archive or automatic cleanup occurred; this task remains `in_progress` until the separately authorized finish workflow. The parent four-feature integration gate is not complete.

## Approved Test-Only Follow-up

The user answered “好先修正”, superseding the pending approval recorded above. While retaining this active task as the shared validation follow-up, correct only the inaccurate quota test fixture in `test/integration.test.js`: measure real unfinished response lifetime with exactly-once completion/close cleanup, and use explicit fixture synchronization to prove chat returns while quota is genuinely outstanding. Do not merely inflate timing thresholds, delete/mute/move assertions without equivalent coverage, or retry until green. Preserve concurrency<=2, success/backoff intervals, generation/key/proxy/deletion/disable and chat fail-open assertions. If truthful accounting reveals a production defect, stop and report rather than modifying server/quota behavior.

Allowed code scope is this test file's quota fixture and only necessary local validation coverage. No production/server/library/UI/config/dependency changes; no statistics feature activation. Reuse existing local mock and temporary-DATA_DIR helpers plus the prior real-response-barrier evidence. Before writing, recheck current test helpers and scheduler callers. Validate a deterministic counter-lifetime witness, the isolated quota case under a small predeclared bounded repeat count (not retry-until-pass), one full integration run and one full npm suite, syntax/diff and protected-file audits. A fresh check must verify both fidelity and unchanged production hashes. Record any narrow test convention during Phase3.3 only after verification; commit/push/archive remain unapproved.

## Test-Only Follow-up Stopped — Production Concurrency Blocker

Workflow `353e00df-9336-4c8e-b054-58aabf38c4fc`, implement child `40c275ca-5fa8-4af4-8e55-ea41b51daf47`, ended with exact gate error `Acceptance rejected: Required criterion 'criterion-1' was reported as not-satisfied.` This is honest acceptance rejection after a test exposed a production defect, not provider/launch infrastructure failure. **The dependent independent check did not launch.** No execution-mode fallback or retry was used.

Only the quota test block changed (+26/-5). Native exactly-once finish/error/close counting and an explicit held-response chat barrier have deterministic red/green evidence. Fixed-count focused run1 passed; run2 failed at `test/integration.test.js:1060` with `quota concurrency exceeded 2 across refresh/configuration phases: 3`; both causal chat barriers passed. This comes from newly added whole-configuration-phase coverage, not the original synthetic counter's false-negative window. The original test checked max only before account changes. Run3, full integration and npm were not run after the agreed stop condition.

`refreshQuota` protects same-account IDs but has no global admission cap; `scheduleQuotaRefresh` takes two per batch while account saves may schedule a new batch during the previous await (`server.js:1278–1312,2110`). Parent inspected this path and the failed log. Exact request interleaving is not fully traced; preserve the concrete failure for the production fix instead of deleting the new assertion or changing counters.

Handoff: `/Users/lyh_god/.pi/agent/sessions/--Users-lyh_god-GolandProjects-cline-pass-switcher--/subagent-artifacts/outputs/353e00df-9336-4c8e-b054-58aabf38c4fc/implementation/quota-fixture.md`. Evidence: `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-quota-fixture-implementation-v8nngph7/`, including deterministic counter witnesses, focused1/2 logs, `test-only.diff` SHA256 `62343319419bcdc6d14f0be3e55208570ed344ad4f1cc669feee69ca3d625182`, and `parent-stop-audit.json`. Parent verified current files match the stopped handoff; all production files,70 protected hashes,original main/HEAD and empty index remain unchanged.

The prior logging-feature gate stays recorded, but the current test-only follow-up is **blocked/not fully verified**, not all-green. Production changes remain outside “好先修正” test-only approval; parent has asked whether to fix the production global concurrency limit and is awaiting an answer. No statistics activation, further checks, commit/push/archive or reset should occur without resolving that boundary.

## Handoff and Rollback

Expected changes are the two focused modules/tests, `server.js`, `public/index.html`, `config.example.json`, focused additions to existing integration/VM/static tests, relevant README notes and verified specs. Keep `lib/jsonl-log-store.js` unchanged unless an independently necessary shared-contract issue is evidenced and reviewed; no speculative cleanup.

Parent review must correlate recorded byte/result evidence with traffic and inspect the entire cross-child draft flow. If blocked, preserve partial diff and report failing command, environment and residual limitation. Disable capture via its ordinary setting as an operational mitigation; do not clear logs, reset configuration, commit, or archive automatically.

## Final Four-Feature Integration Record

The 2026-09-14 parent integration gate initially passed detailed capture/store plus ordinary JSONL 56/56, focused detailed integration 18/18, full integration 44/44 and full suite 127/127. Fresh review then found one P1: a recognized credential header containing `Bearer api_key=<secret>` learned only wrapped forms and could leave a bare earlier/cross-body echo.

The bounded correction changed `DetailRedactor.learnHeaders()` to apply the existing bounded original-token/assignment discovery to the scheme-stripped credential without recursive wrapped scanning. Focused root and authenticated JSON/SSE regressions prove the bare secret is absent from metadata, body APIs, files and service output while forwarding bytes, 16,384-match limits and resource cleanup remain intact. Final gates passed: UI/draft 23/23, detailed capture/store 54/54, integration 45/45 and full suite 129/129. Final fresh reviewer `a11d134d-2ba7-4126-b51b-d22c4465fb50` returned **OK / no findings**.

DC1–DC8 remain satisfied with quota/statistics traffic excluded, ordinary logs unchanged, request-start mode and clear fences intact, and account/raw/bulk drafts preserved through settings/read/body/copy/clear/navigation. The verified recognized-header assignment rule is now in `.trellis/spec/backend/logging-guidelines.md`. The Chrome 152 details report and all three declared screenshots were re-read. Native clipboard denial/selectable fallback and a page-local copy sink were verified previously; successful physical host-clipboard writes and screen-reader audio remain unclaimed. The index remains empty; no commit, push or archive occurred.
