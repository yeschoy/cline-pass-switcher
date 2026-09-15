# Per-Account Quota Visibility in Statistics

## Goal

Implement parent requirement **R4** in `../09-14-diagnostics-routing-config/prd.md`: show quota clearly for each account in the existing statistics panel, independently of quota-based routing.

## Background and Evidence

- The user requested “在统计面板上可以看到每个账号的额度” and approved the metric, page-driven refresh, and account-eligibility policies below. No monetary or token balance is requested.
- Existing statistics columns already contain quota windows and pool/fetch state (`public/index.html:123`). `loadStatistics()` consumes `accounts[].quota` from `/api/statistics` (`public/index.html:787`, `server.js:1989-1993`); reuse these owners instead of creating another panel or account list.
- `quotaLimit()` prints percentage/reset or unknown without used/remaining labels and without checking retained-value freshness (`public/index.html:784`).
- The parser keeps `five_hour`, `weekly`, `monthly`, each with finite 0–100 `percentUsed` and optional canonical `resetsAt` (`server.js:305-330`). This is evidence of integrated fields, not a claim that upstream can never provide other metrics.
- Fetch initiation/publication and scheduling all require `accountPipeline.quotaPool` today (`server.js:1263-1288`, especially `:1264,1281`, and `:1289-1298`). Merely opening statistics or clicking its current refresh button rereads projections without fetching quotas (`public/index.html:120,787`).
- The current quota path refreshes enabled/keyed accounts, bounds scheduler batches to two, uses a five-minute success interval and failure backoff (`server.js:1253-1298`). The cap is not global admission: an account save can schedule another run while an earlier run awaits (`server.js:1290-1296,2050`). Account credential/proxy/deletion invalidation and routing-disable fencing share generation state (`server.js:2043-2044`), while individual disablement does not invalidate an in-flight result or get rechecked at publication (`server.js:1281`). These shared-path gaps must be addressed before adding another refresh source.
- `quotaProjection()` retains last-good values while returning routing status unknown after errors/partial/stale data; fresh routing requires three current windows, no error and a snapshot within 15 minutes (`server.js:566-572`). It is also used by selection and `/api/accounts`, not just statistics.
- Existing quota tests prove isolation, canonical reset times, bounded scheduler/backoff, last-good retention and credential/proxy/deletion/routing-disable fencing (`test/integration.test.js:1000-1028`). Source-aware refresh must preserve these guarantees rather than deleting a routing guard.
- Statistics uses the persisted account list; existing startup/save normalization filters empty-key rows (`server.js:363-365,2035-2038`). Do not change account persistence or import unsaved account-editor rows into statistics solely to produce a missing-key placeholder.
- Verified ownership/cancellation findings are persisted in `research/quota-refresh-ownership.md` (research run `cc662c84-8f99-4024-b3ed-38f4dd4f5d0a`, workflow `862eb78e-be7b-4514-9eec-2fb49d8049a4`). No runtime tests were performed during that research.

## Confirmed Requirements

- **Q1 — Metrics:** For every listed account, label five-hour/weekly/monthly used and remaining percentages and available reset times. Remaining is `100 - percentUsed` only for validated known usage; missing windows remain unknown and missing reset times unavailable. Never fabricate money/token balances or treat unknown as zero.
- **Q2 — Refresh lifecycle:** Quota viewing is independent of the quota-pool routing switch. Update on statistics entry, reuse successful data within five minutes, repeat every five minutes while the page is active, and provide manual refresh. Leaving stops page-triggered refreshes without disabling routing-owned background refresh.
- **Q3 — Account eligibility:** All statistics accounts stay visible. Automatic and manual refresh query only enabled accounts with a non-empty key. Disabled accounts show last-known quota/time or unknown; a missing-key row is unconfigured and is never queried. The user accepted that disabled-account quota does not update.
- **Q4 — Truthful state:** Distinguish unknown, partial, failed, stale/last-known, and refreshing states from known 0%/100%. Show last-success/update time and safe failure category. Reading old diagnostic values must not make them fresh for routing.
- **Q5 — Shared resource ownership:** All refresh sources share a global upstream concurrency limit of two, same-account deduplication, success-cache and failure-backoff policy. Quota requests stay outside chat latency/statistics and use the existing account-bound native/proxy transport and response validation.
- **Q6 — Invalidation:** Account edits/deletion/disable and concurrent requests cannot publish results under the wrong credentials or account. Disabling quota routing cancels its refresh ownership, not an independent active statistics request. Routing-only stale completions remain fenced.
- **Q7 — Preservation:** Do not alter scheduling configuration merely to display quota, change selection policy, weaken strict fresh-routing criteria, expose raw quota/credentials, or include quota/statistics requests in detailed chat logs. Statistics navigation/refresh must preserve raw/bulk/account drafts.
- **Q8 — Accessibility:** Safe account/provider rendering, readable units and timestamps, keyboard-operable refresh controls and announced loading/error/last-known status.

## Acceptance Criteria

- **QC1 / Q1, Q4:** Each row/window has correctly associated used/remaining/reset labels. Known 0% and 100% remain valid; missing or invalid windows/reset values stay unknown/unavailable, with no money/token inference.
- **QC2 / Q2, Q7:** With quota routing off, entry/cache expiry/manual refresh can update quota without changing configuration. Automatic five-minute refresh runs only while statistics is active; navigating away stops its future work and stale UI updates, while routing-owned background refresh continues when enabled.
- **QC3 / Q3:** Disabled/missing-key rows cause no new quota calls; disabled snapshots retain last-known labels/time, absence of a snapshot renders as unknown, and an unconfigured projection is never converted to numeric zero. Existing keyless-row persistence behavior is not changed.
- **QC4 / Q4, Q7:** Partial/failure/stale snapshots remain diagnostically visible but never become fresh routing data through display. Expose refresh times and error states without raw payloads or credentials.
- **QC5 / Q5:** Simultaneous background, automatic, manual and multiple-page requests never exceed two upstream quota calls; duplicate requests coalesce and failure backoff is not bypassed. Model traffic continues while quotas are pending.
- **QC6 / Q6:** Credential/proxy/enablement/deletion changes, source cancellation, and routing off/on races cannot resurrect invalid results or attach them to another account. A shared fetch may publish only while its account identity and at least one requesting source remain valid.
- **QC7 / Q7:** Existing statistics, selection, presets, raw/bulk drafts and detailed-log exclusions remain intact with both quota routing and detailed logging enabled/disabled.
- **QC8 / Q8:** Loading/errors and incomplete quota are understandable without color alone; account text is safe, refresh works by keyboard, and wide/narrow layouts remain readable.

## Dependencies and Scope

Implement fourth, after bulk concurrency, raw scheduling JSON and detailed logging have passed their gates. This is a sequential shared-file integration constraint, not a runtime dependency on logging. Re-check changed navigation/transport code before implementation. The parent owns final four-feature acceptance.

No duplicate panel/account source, billing system, new database/dependency, monetary/token inference, quota-derived scheduling-policy change, or configuration-schema expansion is requested. Reuse current metadata/parser and bounded transport; runtime refresh ownership is not persistent account configuration.

The user approved this plan for implementation with “开始”. This child remains planning until preceding gates pass and the parent activates it.
