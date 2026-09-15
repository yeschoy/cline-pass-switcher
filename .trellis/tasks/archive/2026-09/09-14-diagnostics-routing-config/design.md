# Integration Design

## Scope and Execution Order

This parent owns R1–R4 and integration acceptance. It has no direct implementation slice; activate the child whose deliverable is next, not the parent.

1. **Bulk concurrency:** owns the minimal shared rendering/hydration correction and production-script draft test harness.
2. **Raw scheduling JSON:** depends on that correction; applies validated values into existing controls.
3. **Detailed logging:** independent runtime feature, serialized after the UI children to avoid concurrent writers and to verify draft preservation with the finished console.
4. **Statistics quota visibility:** shared-source quota refresh and clearer existing quota columns, implemented last to verify its navigation/cancellation behavior against all preceding features. It has no runtime dependency on detailed capture.

Each child has its own `prd.md`, `design.md`, `implement.md`, and context manifests. Child implementation/check prompts start with the actual `task.py current` path. A child gate must pass before proceeding; a parent/child link alone is not a dependency mechanism.

## Shared Draft Boundary

Evidence: `../09-14-bulk-account-concurrency/research/account-draft-flow.md`.

Keep existing ownership: complete account objects in `ACCS.accounts`, active account in `ACCS.active`, scheduling values in existing DOM controls. Only actual `loadAll()` hydration initializes those controls from a server snapshot. Table redraw/search/drawer/bulk/raw applications do not normalize or erase pending values.

Bulk applies only `maxConcurrent` on selected current account objects. Raw JSON applies only validated mode/wait/rules/pipeline controls and includes names as references; it cannot select/rename/reorder accounts. Neither calls persistence. Existing `saveAccounts()` submits the complete intended account/scheduling draft and remains the sole new-feature persistence path for R2/R3. Existing presets remain confirm-and-save.

The raw editor's exact five-field JSON, validation and stale/dirty-dialog behavior are in its child design. The batch selector's object-reference identity, visible-target intersection and search-clear behavior are in its child design. Do not add a second generic draft store or serialize visible table columns as the account source of truth.

## Detailed Logging Boundary

Evidence: `../09-14-detailed-request-logging/research/capture-boundaries.md`.

The detail feature captures at allowlisted HTTP/native transport boundaries, not by enlarging ordinary `record()` projections. Node-native scoped context correlates real upstream calls; body capture is bounded independently of request forwarding and the existing SSE observer.

The detailed-logging child design explicitly includes model-list API responses/calls and console inference tests, excludes background quota/public discovery/config/log/static traffic, and labels unread rejected bodies rather than altering rejection timing. It does not claim provider-internal or packet-wire visibility.

A detail-only credential sanitizer preserves prompts/ordinary headers while removing recognized credentials and known secret echoes. Unsafe/unsupported partial content is marked omitted/incomplete, never dumped raw. This is a narrow exception to current log/view body prohibitions; metadata, statistics, ordinary history/request/error streams retain all existing restrictions.

The existing JSONL store is not suitable unchanged for 1 GiB bodies because it scans all bodies and deduplicates non-error records by root ID. Detailed storage therefore uses dedicated metadata and on-demand sanitized body files, bounded retained payloads, one mutation owner, independent 7-day/1 GiB retention, and a clear-generation fence. No dependency is added.

`config.detailedLogging` is default-off and persisted through a narrow settings route using candidate-then-atomic-write semantics. The detailed panel loads its own settings/data rather than `loadAll()`, so toggling diagnostics cannot submit/discard raw/bulk drafts.

## Statistics Quota Boundary

Evidence: `../09-14-account-quota-statistics/research/quota-refresh-ownership.md`; the parent also checked the shared scheduler/account-save publication guards.

Reuse the existing statistics account list, quota parser/metadata and strict routing projection. Show 5-hour/weekly/monthly used and remaining percentages and available reset times. Unknown/partial/error/stale and disabled last-known values remain labelled; never infer monetary/token balances or post-reset zero usage.

Statistics requests read persisted accounts, not unsaved editor rows. Only enabled keyed accounts are refreshed; disabled values remain last-known. Existing persistence filters keyless accounts, so unconfigured rendering is a safe fallback rather than authorization to change account-save semantics.

Page entry and five-minute automatic refresh reuse the five-minute success cache; manual refresh is explicit. Leaving statistics cancels page-owned work and stale UI updates without stopping the independent routing-owned scheduler. A shared admission owner enforces two actual upstream quota calls globally, deduplicates accounts, preserves failure backoff, and separates account-identity invalidation from routing ownership. The child design defines the exact request/source cancellation contract.

No statistics read or refresh writes scheduling configuration, calls `loadAll()`, changes `ACCS`, or enters ordinary/detailed chat logs or chat statistics. Actual successful validated snapshots may update the existing quota cache, but display of retained data never changes the strict fresh-routing predicate.

## Cross-Child Acceptance Scenarios

1. Edit account A's note/routes and scheduling wait/rules/pipeline; select B/C, apply concurrency; open raw JSON, change mode/rules; filter; navigate/read/toggle/clear detailed logs; ordinary save must persist exactly the intended account and scheduling changes.
2. Keep invalid rule JSON temporarily; account search/bulk redraw must preserve its exact text. Raw opening reports invalid source without replacing it; no implicit write occurs.
3. Use duplicate names and a new unsaved account. Batch targets retain object identity; raw labels never become mutation keys; logging navigation cannot reload/retarget the account draft.
4. Toggle logging during an in-flight SSE request. Its snapshot/finalization remains consistent; later roots use the new setting. No lease/statistics or client payload difference is allowed.
5. Clear detailed logs while a request is active. Pre-clear writes cannot resurrect; ordinary logs and account configuration are untouched; post-clear new requests can still be captured if mode remains on.
6. Run all previous ordinary-log redaction/proxy/routing/preset tests with detailed mode off, and targeted ordinary-log/metadata non-leakage checks with it on.
7. Navigate from pending raw/bulk/account drafts to statistics, automatically/manually refresh quotas with routing off, then return: drafts and scheduling configuration must remain unchanged. No quota payload becomes a detailed log.
8. Leave statistics during a mixed page/routing quota fetch, rotate credentials or disable routing, and open another statistics page: global concurrency stays at two, stale identities are discarded, and valid remaining source ownership alone may publish.
9. Disabled accounts, partial/stale snapshots, explicit 0%/100%, missing reset time, fetch failure and browser cancellation must have distinct truthful display states without altering selection behavior.

## Validation and Operational Shape

Every child runs its focused tests, embedded-script syntax, full `npm test`, `git diff --check`, and a fresh quality review. VM/static tests are not browser automation: keyboard/dialog/focus, mixed selection, copy failures, narrow scrolling and arbitrary text rendering require browser checks.

Default-off makes rollout opt-in. Diagnostic capture/storage can fail without failing traffic; exact omissions and safe store health remain visible. Preserve real config/metadata/log files during testing and rollback; all integration fixtures use temporary `DATA_DIR` and local endpoints with credential overrides cleared.

Rollback is child-scoped: removing detailed logging does not remove raw/bulk work; removing the raw editor does not undo the shared bulk draft fix. Do not delete operator diagnostics, reset `.pi/plan/`, or sweep untracked files. Spec updates record only verified contracts during finish, retaining ordinary-log restrictions alongside the new explicit detailed exception.
