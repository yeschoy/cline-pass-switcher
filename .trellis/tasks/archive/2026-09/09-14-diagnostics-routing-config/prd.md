# Detailed Logging, Raw Scheduling Configuration, Bulk Concurrency, and Account Quotas

## Goal

Make request troubleshooting, scheduling-policy inspection/editing, bulk account-concurrency management, and per-account quota visibility possible from the existing console without losing unrelated configuration or changing traffic behavior.

## Background and Evidence

- The user approved the complete four-feature plan and implementation with “开始”. Activate each child in the reviewed order after its predecessor passes review. Commit/push approval is separate.
- The screenshot shows error-rule presets/JSON and four fixed-order account-pipeline switches (`public/index.html:182-187`). Source: `/Users/lyh_god/Library/Application Support/CleanShot/media/media_QUSrH0qDgs/CleanShot 2026-09-14 at 20.04.31@2x.png`.
- Ordinary logs deliberately exclude bodies/header values (`.trellis/spec/backend/logging-guidelines.md`, `server.js:1041-1073`). Detailed capture must be a narrow opt-in exception, not a relaxation of normal projections.
- Account saves replace the full list (`server.js:2004-2052`), while page drafts mix account objects and DOM controls (`public/index.html:745-760`). R2/R3 therefore share draft-preservation and full-round-trip requirements.
- Existing statistics already has quota-window columns (`public/index.html:123,784,787`), but quota fetching requires the routing switch (`server.js:1263-1298`). R4 reuses this path and separates viewing from routing ownership rather than duplicating quota data.
- Child PRDs and research retain detailed file/line evidence and executable validation anchors. No application test result is claimed during planning.

## Confirmed Requirements

### R1 — Detailed logging

- Independent “详细日志” entry and mode switch. Default off; successful toggles affect new requests immediately and persist across restarts, independently of account drafts. Enabled mode continues capturing until manually disabled.
- Cover client-facing model requests/final responses and every locally observable upstream model call, including failure/retry/streaming and console tests/probes. Correlate attempts with their initiating request; do not capture configuration management, log queries or static resources.
- Retain ordinary headers and body content while redacting Authorization, Cookie, API keys, proxy passwords and other recognized credentials. Original credential values are intentionally unavailable.
- Capture at most 5 MiB (5 × 1024 × 1024 bytes) per individual request body and response body. Mark truncation/incompleteness explicitly; never truncate real traffic for logging.
- Independent detailed storage, at most 7 days and 1 GiB total (1024 × 1024 × 1024 bytes); remove oldest detailed records when either limit is reached. High volume may shorten the effective retention. Ordinary logs are unaffected.
- Inspect request headers/body, final response and each upstream attempt on demand; support copying sanitized content and independently clearing detailed logs. Preserve existing management authentication and safe text rendering.
- Diagnostic/storage failures must not alter proxy behavior or expose raw sensitive data through service errors. See the child design for route and incomplete-capture semantics included in final review.

### R2 — Raw scheduling configuration

- Add readable/editable JSON near scheduling controls: mode, capacity wait, account error rules, four pipeline switches, and corresponding account names for reference (“包含对应的账号名字就行”).
- No account credential, proxy/header, model-route or per-account-parameter editor in this entry point; names are references, not mutation identities.
- Validate completely before applying; unsupported/invalid/stale input cannot partially change the draft or server configuration.

### R3 — Bulk account concurrency

- Independent multi-selection, “select all current search results,” and one common concurrency value applied only to selected accounts. Show affected names/count and preserve active-account radio behavior.
- Accept integers 0–100000 (0 means unlimited), reject invalid/empty input rather than clamping, and preserve every other account field.
- Changing search conditions clears selection but preserves draft edits. Selections do not accumulate across searches; hidden/removed accounts cannot become unexpected targets.

### R4 — Per-account quota visibility

- Show each statistics account's five-hour/weekly/monthly used and remaining percentages and available reset times; no monetary/token balance is requested. Unknown/partial/failed/stale data and last-success time remain explicit.
- Refresh independently of the quota-pool routing switch: update on statistics entry with five-minute success-cache reuse, repeat every five minutes while active, and provide manual refresh. Leaving stops page-owned refresh without disabling routing-owned background work. All sources share bounded concurrency, deduplication and failure backoff.
- All persisted statistics accounts remain visible, but automatic/manual refresh queries only enabled accounts with non-empty keys. Disabled accounts show last-known quota/time or unknown; a missing-key projection is unconfigured. Preserve existing account persistence and do not import or submit unsaved account drafts.

### Shared R2/R3 Draft Contract

Raw JSON opens from the current page draft. Applying raw JSON or bulk concurrency updates the local draft only; the existing “保存账号配置” explicitly persists the combined draft. Preserve other pending account/scheduling edits, including temporarily invalid text during table redraw, and clearly identify unsaved state. Existing presets retain their explicit confirm-and-save behavior.

## Task Map and Dependencies

| Order | Child | Ownership |
|---|---|---|
| 1 | `../09-14-bulk-account-concurrency/` | R3 and minimal shared draft-preserving render/hydration correction |
| 2 | `../09-14-raw-scheduling-config/` | R2, reusing the preceding child's shared behavior/tests |
| 3 | `../09-14-detailed-request-logging/` | R1, functionally independent but serialized to avoid shared console/server/test writers |
| 4 | `../09-14-account-quota-statistics/` | R4, quota/statistics visibility with shared source-aware refresh ownership |

The R4 requirements have converged. It follows the existing R1–R3 sequence so quota navigation/refresh can be verified against completed draft and logging behaviors. This is a shared-file integration order, not a runtime dependency on detailed logging.

The raw child explicitly depends on the bulk child's verified common draft behavior. The logging child waits for both UI children as an implementation-order constraint, not a runtime dependency. This parent owns source requirements and final integration acceptance, not a separate direct implementation slice. Do not start the parent merely because it has children.

## Acceptance Criteria

- **AC1 / R1:** Child DC1–DC8 prove mode persistence, agreed route coverage/correlation, credential handling, per-body cap, independent retention/browsing/clear, honest incomplete states and unchanged traffic behavior.
- **AC2 / R2:** Child SC1–SC6 prove live raw projection with names, atomic local validation/application, explicit-save round trip, preservation, stale/cancel safety and accessibility.
- **AC3 / R1 + R2 + R3 + R4:** Integrate all four: pending account/bulk/raw drafts survive logging and statistics navigation/refresh; raw and bulk edits coexist through search/redraw and explicit save; quota display does not silently enable quota routing or enter chat logs/statistics. Ordinary logs and non-target configuration remain unchanged.
- **AC4 / R3:** Child BC1–BC5 prove exact target-only assignment, filter/select-all/active independence, strict numeric boundaries, no implicit persistence and identity-safe edge cases.
- **AC5 / R4:** Child QC1–QC8 prove per-window used/remaining/reset values, page-driven refresh independent of routing, disabled/unconfigured display, truthful freshness, global concurrency/deduplication/backoff, account/source invalidation and existing behavior preservation.

## Out of Scope

Unrelated routing/proxy changes, new protocol support, bulk fields other than concurrency, whole-config editing, credential editing through raw scheduling JSON, external telemetry services, new database/frontend dependencies, and general refactoring. Preserve unrelated untracked `.pi/plan/` and all operator-owned configuration/data.

All four feature scopes and planning artifacts are approved for implementation, and ten context manifests have been validated. The bulk-concurrency child is the first activated implementation target; later children require their predecessor's verified handoff. No commit or push has been approved.
