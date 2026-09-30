# Visual account-selection workflow

## Goal

Make the real account-selection branches visible and editable in a guided flowchart, and distribute new selections by the user's minimum-selection-count rule while preserving valid session bindings.

## Background and evidence

- Actual product: /Users/lyh_god/GolandProjects/cline-pass-switcher. This repository holds the design/diagnostic artifacts. No product or production edits have begun.
- Existing UI has separate mode choices and three draggable steps; sticky+health binding hits are an earlier condition gate, not a genuinely linear third step (public/index.html:312, server.js:1864).
- Latest read-only snapshot:46enabled accounts, cap7/maxRpm0, cache target18, broad account429 cooldown3s. Error20-record evidence confirms same targetProvider deepseek before/after account replacement.
- Quota classification uses maximum used percentage, which equals100 minus minimum remaining percentage (server.js:1646). This is not a minimum-used-percentage bug.
- Current exact-health groups can concentrate requests even with correct atomic slot checks (server.js:1691, server.js:1493).

## Confirmed requirements

- R1: Use a guided flowchart with supported draggable strategy nodes, editable branches/parameters and fixed system safeguards; not an arbitrary n8n canvas.
- R2: Unknown account health routes as100%. Keep observed statistics unknown/sample0 and visibly distinguish the effective routing value. Do not change Provider unknown-health semantics.
- R3: The new miss selector operates only inside the current active cache pool and chooses the available account with the fewest actual selection counts. Do not replace this with conventional cursor round robin or least-live-connections, or silently narrow the comparison to the highest-health account.
- R4: An actual new selection that acquires a lease adds1 to the chosen account. Direct binding hits and same-account Provider retries do not add1; failed reservations do not add1. Actual temporary-overflow/replacement selections do add1. Subsequent failure/cancellation does not undo an actual selection.
- R5: Persist counts by stable account ID, restore after restart, expose an explicit reset action, and start new accounts at0. Re-enabling or returning an existing account does not reset it. Do not invent a virtual starting baseline or backfill from historical request totals.
- R6: Explain eligibility, binding behavior, selector choice and execution outcome in UI/logs. A request ID must connect the decision path, policy version and Provider/account attempts without exposing raw session identifiers, bodies or credentials.
- R7: Preserve owner isolation, unavailable-account exclusion, atomic lease/RPM enforcement, bounded retry and no replay after visible stream output. UI rearrangement cannot bypass these rules.
- R8: Existing configurations import into an equivalent compatibility flow. Draft edits, validation, simulation and application are distinct; saves preserve full account data and detect conflicting revisions.

## Design defaults for review

- Among equal minimum counts, prefer lower current occupancy, then stable rotation. Primary ordering remains the user's minimum selection count.
- Health is a visible policy/optional filter in the new template, not a hidden exact-score ordering ahead of the count selector. No health threshold is invented without an explicit configuration.
- Counter reset targets an explicitly selected owner pool and shows affected accounts; it does not clear bindings or disrupt active leases.
- The new template makes quota-role priority explicit rather than secretly overriding the count comparison. Existing quota/cache membership rules remain available and the compatibility template retains old behavior.

## Acceptance criteria

1. With equal starting counts and equally available18 active accounts, N new selections keep count spread at most1; direct hits leave counts unchanged.
2. Concurrent selections reserve leases and update counts synchronously, never exceeding per-account caps or selecting foreign/disabled/cooled/excluded accounts.
3. Replacements and actual temporary overflows each add one to the selected account; Provider retries, preview and failed admission add none.
4. Restart, rename, disable/re-enable and cache leave/re-entry preserve the stable-ID count. New accounts start0; reset is scoped, explicit and persisted.
5. Unknown health participates as100% without fake successes/samples. Provider health remains unchanged.
6. A flow's visible branches, validated configuration, execution and bounded decision trace agree. Invalid graphs and stale saves cannot silently alter routing or discard unrelated account fields.
7. Old-config import preserves old behavior until application of the new template. Metadata/config migration and rollback boundaries are verified with synthetic data.
8. Local mock and browser checks validate semantics before any separately authorized deployment or live test.

## Boundaries and known consequences

- Equal selection counts do not mean equal total requests, tokens or live load because binding hits are excluded.
- A new or low-count returning account can receive repeated selections while catching up, still subject to its slot cap; this follows the user's real-counter semantics.
- General429 narrowing and maxSockets256 were questions to explain. No production rule edits, socket changes, load tests or deployment are performed merely as part of this design.
- Do not bundle the incomplete-SSE success-statistics defect into this feature without separate scope.

## Authorized follow-on scope (2026-09-30)

The user explicitly extended this in-progress task after commit `9bb8f79`; the following supersedes the original socket/load-test exclusion above. Keep the existing guided workflow and compact counter snapshot. Raise the default direct Agent socket limit from256 to512 with the existing1–1024 override validation; document other admission/queue/time limits and test 43 accounts x6 plus a500-request local burst without changing per-account caps. Reuse the existing optional health filter, keep its enablement off by default, offer20% as the enabled default, apply the inclusive threshold to new selections, replacements and binding hits, and preserve unsampled accounts as100% eligible with null/zero measured samples. Make a newly ineligible binding migrate through a real counted selection, return an explicit empty-pool reason and align UI, preview and logs. Verify synchronous lease/counter admission and reset/config/deletion interleavings, restart and write failures; measure ranking, health scans, config hashing, serialization, persistence, throughput and event-loop delay. Establish the deployed process topology from repository evidence; do not infer cross-process atomicity, deploy, or send live upstream pressure. Commit code, docs and Trellis updates; retain static intermediates without cleanup permission.

## Review status

All material interview choices are answered. The authoritative written design is ready for review before implementation planning. This task remains planning.
