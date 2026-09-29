# Guided Account Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Implement a guided account-selection editor and active-cache minimum-selection-count scheduling, with persisted counters, zero-cost binding hits and optimistic unknown account health.

**Architecture:** A small pure module owns normalized workflow and counter contracts. server.js remains the sole owner of account eligibility, leases/RPM, bindings, metadata persistence and model calls; the workflow adds an enabled path rather than replacing legacy routing. The existing static page owns one workflow draft, renders its real branches and saves it with account settings.

**Tech Stack:** Native Node ESM >=18, existing HTTP/SOCKS agents, vanilla HTML/CSS/JS, node:test; no frontend framework or new dependency.

**Spec:** ../specs/2026-09-30-selection-workflow-design.md

## Global Constraints

- Scope is current owner-scoped active cache members, never the whole pool by accident.
- Unknown observed health stays null/sample0; effective account routing health is100% in optimistic mode. Provider health unchanged.
- Minimum selection count is primary; lower live occupancy and stable rotation break ties. Successful new lease selection increments once; direct hit and same-account Provider retry do not.
- Counters persist by stable account ID; new accounts0; explicit owner-scoped reset; no inferred history or automatic rebasing.
- Reuse the existing atomic lease/RPM path and metadata writer. No new scheduling queue or state owner; the final-review performance ruling adds a compact counter snapshot under the same atomic writer, no live credentials in tests, no production changes/deployment.
- Legacy configuration remains behaviorally unchanged while accountWorkflow.enabled=false. Preserve account IDs, keys, owner, note, headers, proxy, perModel and unrelated drafts.
- Source main is clean at e16db146; isolated branch codex/selection-workflow. Baseline369/369 tests passed on Node26.

## Review Focus

- Concurrent equal counters with nearly full slots: no stale-read concentration/overcommit; task2 black-box burst test.
- Binding hit versus true temporary overflow/replacement: only new automatic selections increment; task2 integration test.
- Restart and failed metadata/reset persistence: counts restore, failure never silently resets or fabricates an upstream error; tasks2/3 tests.
- Stale account drafts and owner/counter reset scope: preserve unrelated fields and return409 on revision conflict; task3 API + task4 VM tests.
- Preview/keyboard/mid-edit redraw: no model call/count increment or lost draft, accessible alternate to drag; task4 tests and browser evidence.

## Contract decisions

Add optional root config accountWorkflow with version1, enabled(boolean), bindingEnabled(boolean), onBindingBusy(overflow|wait-overflow|reject), missSteps(exact permutation of quota and health), quotaFilter(boolean), quotaPools(subset of hot|warm|unknown), healthFilter(boolean), minimumHealth(number0..1), unknownHealth(optimistic|unknown-last), selector(least-selections|roundrobin|least-connections|health). Defaults: disabled compatibility; when enabled, binding on, overflow, quota/health order, quota filter on, health threshold off, minimum0, optimistic and least-selections. Active-cache size must be positive while enabled.

The graph is deliberately guided: fixed system entry and atomic lease exit, explicit binding hit/miss/busy branches, draggable typed miss filters and a selectable terminal picker. It is not a general graph interpreter. Existing accountPipeline owns cache/TTL settings; graph property controls edit that same draft rather than introducing duplicates.

Metadata selectionCounters is a version1 object keyed by stable ID with count and bounded tie sequence. Missing state initializes empty; malformed state fails without overwriting. A selected lease updates count synchronously and atomically writes only selection-counters.json, following the final-review performance ruling. The server remains the sole state/writer owner; metadata is a compatibility mirror. Persistence failure remains visible and in-memory counts remain effective; explicit reset is persist-first and never changes leases/bindings. Any chosen account at the numeric safe limit is reported explicitly, never wrapped or silently reset.

GET /api/accounts adds workflow, configurationRevision, account.selectionCount, effectiveRoutingHealth and counter persistence status. POST /api/accounts preserves omitted workflow for old clients, validates supplied workflow and optional expectedConfigurationRevision, persists together with the full account save before publishing. Guided drafts send the revision.

POST /api/account-workflow/preview accepts workflow, owner and optional boundAccountId; returns bounded node trace and predicted selection from a read-only snapshot. It does not write config/meta, create bindings, acquire leases, advance tie counters or call upstream. POST /api/account-workflow/reset-counts accepts owner plus expectedConfigurationRevision; only independent admin+CSRF can invoke it. Request logs add an optional bounded workflow decision projection with version and count facts, never raw session/candidate secrets.

### Task1: Pure workflow contract and counter state

**Files:** lib/account-workflow.js; test/account-workflow.test.js.

**Interfaces:** normalizeAccountWorkflow(value); normalizeSelectionCounters(value,validIds); effectiveRoutingHealth(observed,policy); rankWorkflowCandidates(candidates,{selector,counts,activeCounts,cursor,unknownHealth}); defaultAccountWorkflow().

- [x] Write tests for defaults/invalid nodes/unknown fields, thresholds, unknown-vs-observed statistics, minimum count before health/load, stable ties, invalid/overflow counters and immutable inputs.
- [x] Run node --test test/account-workflow.test.js and confirm intended failures.
- [x] Implement only pure validation/ranking/state projection, with no transport or filesystem.
- [x] Run focused tests and node --check; commit.

### Task2: Guided admission, binding and persistent counts

**Files:** server.js; test/workflow-integration.test.js; existing test/admin-fixture.js reused.

**Interfaces:** workflowSelectionContext(identity,options); acquireWorkflowAccountLease(identity,options); recordWorkflowSelection(lease); selectionCountProjection(account); config.accountWorkflow and META.selectionCounters.

- [x] Write isolated43-account/mock tests: equal new sessions, repeated same-session hits, unknown health, concurrency cap, disabled/cooled/foreign accounts, replacement and same-account Provider retry, restart/rename/reactivation.
- [x] Observe the first focused failures, implement guided dispatch only when enabled, retain original legacy path.
- [x] Use current cache membership and flatten applicable miss candidates for the count selector; do not run hidden exact-health/low-role rank ahead of it. Reuse atomic tryLeaseResult, bindings, waiters and grow-one.
- [x] Record once at new lease selection, not when headers/token/Provider attempt happen. Preserve original binding on temporary overflow; maintain request-local excludes on replacement.
- [x] Validate/init persisted counts, preserve counts while absent from active membership and after rename, remove only deleted IDs; exercise save failure/restart boundaries.
- [x] Run focused + existing routing suites; commit.

### Task3: Management contract, preview/reset and bounded diagnostics

**Files:** server.js; test/workflow-integration.test.js; test/account-workflow.test.js.

**Interfaces:** GET /api/accounts extensions, expectedConfigurationRevision on POST, POST preview/reset-counts, optional request.workflow diagnostics.

- [x] Write failing tests for invalid/stale saves, omitted-field preservation, zero-side-effect preview, reset owner isolation and failed-write rollback.
- [x] Add normalization before persistence, opaque config revision and admin-only preview/reset routes. Preview eligibility must not call pruning paths that mutate state.
- [x] Add bounded workflow traces and counts to ordinary request logs; ensure existing outputs still omit secrets and raw affinity.
- [x] Verify no profile/body capture changes and no upstream call from preview/reset; commit.

### Task4: Guided flow UI and actual browser behavior

**Files:** public/index.html; test/workflow-ui.test.js; test/ui-contract.test.js; existing account-draft tests.

**Interfaces:** workflow draft hydration/collection; renderWorkflow; moveWorkflowStep; previewWorkflow; resetWorkflowCounts; account configuration revision snapshot. Reuse api(), existing account draft ownership and saveAccounts().

- [x] Write production-VM tests for draft persistence, readonly system guards, draggable/keyboard step ordering, selector parameters, unsampled100 copy, counter table and stale preview responses.
- [x] Render fixed entry/cache/binding/lease nodes and hit/miss/busy edges, movable supported filters, parameter panel, compatibility toggle, validation/preview, explicit save and reset confirmation.
- [x] Keep existing account fields/presets/raw editors coherent; preserve workflow/revision through programmatic saves and reject unsupported combinations clearly.
- [x] Add selection diagnostics to request details without a generic new store. Show when legacy mode is active and do not claim an unapplied draft is live.
- [ ] Verify actual local browser interactions at desktop/narrow widths, keyboard reorder/focus, unsaved edits, preview no mutation and reset; commit.

### Task5: Contracts, full verification and review

**Files:** README.md; config.example.json; .trellis/spec/backend/{database,quality,logging}-guidelines.md; .trellis/spec/frontend/{state-management,quality-guidelines}.md; task check report.

- [x] Document workflow/counter fields, save/reset behavior, first-time counter initialization, catch-up consequence, compatibility and deployment/rollback limits.
- [ ] Run all source syntax and full npm test with credential env scrubbed, git diff --check and relevant browser evidence.
- [x] Perform one fresh-context whole-branch review per executing-plans; address important findings with regression tests and record rulings.
- [ ] Commit remaining artifacts and journal. Do not push/merge/deploy or delete static artifacts without the user's applicable authorization. Deliver implemented local result plus answers to all nine annotations.
