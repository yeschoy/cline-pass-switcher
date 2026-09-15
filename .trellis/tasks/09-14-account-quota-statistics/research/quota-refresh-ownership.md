# R4 quota refresh ownership: evidence and recommendation

## Scope

Planning-only source inspection against supplied HEAD `dd3cfc0`; active task resolved with `task.py current --source`. Read the active PRD, backend quality/persistence specs and frontend state spec. No application changes, real data/secret reads, external requests, or tests were performed.

## Current owners and important gaps

| Source anchor | Evidence |
|---|---|
| `server.js:305-330` | Parser accepts recognized 5h/week/month rows with finite numeric usage 0–100; duplicate recognized rows and invalid resets fail. Unknown rows are ignored; at least one recognized row suffices. Partial success replaces the entire snapshot, not a merge with older windows. |
| `server.js:566-572,574-591` | Routing freshness requires all three windows, no error, matching last-success/fetch time, no later attempt, and age <=15 minutes. Unknown routing retains last-good diagnostic values. Pool is maximum usage with 80/95 boundaries; quota grouping is conditional on routing flag. Do not change these semantics for display. |
| `server.js:1253-1288` | Per-ID in-flight Set deduplicates requests. Fetch uses native/proxy transport, only Accept and account Authorization, 256 KiB cap, 15-second timeout. Publication records attempt start, latest successful snapshot/time or safe failure category; failures retain old snapshot. Metadata save errors are safely logged. |
| `server.js:1289-1298,2050,2161` | Only scheduler calls `refreshQuota`; startup and account saves call scheduler. Scheduler filters enabled keyed accounts, HRW-ranks/rotates due accounts, selects two and awaits them before rescheduling. Success due time currently uses **attempt start**, not successful fetch time. Failure interval is min(15×base, base×2^failureCount), base 60 seconds; first recorded failure normally means 120 seconds. Counts are runtime-only. |
| `server.js:1264,1281,2041-2044` | Routing flag guards initiation/publication; switching routing off advances all retained account generations. Key/proxy changes or deletion advance generation and delete quota. **Individual account disablement does neither**, and publication does not check enabled. A held completion can therefore publish after disablement. |
| `server.js:1290-1296,2050` | **Global <=2 is not enforced at admission.** Clearing a timer cannot cancel an already-running async callback. An account save can start another scheduler run while the prior one awaits; disjoint IDs may exceed two. Existing normal-scheduler test is not proof against this overlap. |
| `server.js:1989-1998` | Statistics maps all configured accounts; it never starts quota requests. GET does prune in-memory statistics, so “pure projection” should mean no new quota work, not literally no mutation. GET accounts also projects quota. Statistics does not expose a key/configured flag or attempt timestamp. |
| `public/index.html:120,279-287,784-799` | Refresh button and navigation only GET statistics. API helper has no signal argument. Query generations guard successful rendering, not the catch branch; an old failure can overwrite current/hidden status. There is no statistics timer or cancellation owner. |

### Missing keys and drafts: actual behavior

`normalizeAccount()` trims keys (`server.js:206-215`). Startup filters blank keys (`364`); full account save filters them too and rejects an entirely empty result (`2034-2039`). Clearing a saved key removes that account and its account-level history/quota; this is not a supported persisted unconfigured row. Active selection is resolved by normalized ID before filtering.

New unsaved rows live only in `ACCS` (`public/index.html:759-763`); they do not appear in server statistics, even if their draft key is filled. Unsaved disable/key/proxy edits likewise do not affect server eligibility. Do not merge drafts into statistics or silently save them. With current storage semantics, unconfigured display is a defensive fallback for any future/projected missing-key row; adding persistent blank-key accounts is a separate destructive-save contract change, not necessary for “all accounts returned by statistics.” A safe server-derived `configured` boolean can support that fallback without sending credentials.

## Minimum correct source-aware design

**Recommend the candidate with a small in-memory shared job map and one admission pump, not a new persistent subscription system.** Reuse parser, transport, metadata schema and statistics table. Keep GET free of quota fetch initiation.

1. A strict authenticated `POST /api/statistics/quota-refresh` accepts an exact small object (e.g. `{force: boolean}`), rejects unknown fields/types/query options, and derives accounts from current server config. No credential, proxy, draft or arbitrary upstream input. Return only bounded safe per-account outcomes (cached/backoff/skipped/refreshed/failed/cancelled as needed), then reuse GET projection; do not duplicate statistics payload construction.
2. One batch is one finite sweep, not an automatic retry loop. Page entry and five-minute ticks use success cache; manual refresh may bypass **success cache only**, never failure backoff or same-account dedupe. Use last successful fetch time for five-minute cache, not routing `status` (partial successful snapshots are still successful cache entries). Recheck eligibility, generation and due status when dequeuing; concurrent waiting batches must not produce sequential redundant forced requests.
3. One shared per-account job stores captured account generation/transport identity, AbortController, promise, and owners: a Set of active page-batch tokens plus optional routing epoch. Reserve the global slot synchronously before transport; all sources pass through the same pump, with at most two running transports and one job per ID. Deduplicate by joining the promise, not returning immediately on an existing Set entry. Keep old invalidated/aborting transports counted and ID-locked until they actually settle; never let their finalizer delete a replacement job.
4. Scheduler retains its existing routing-only background behavior but submits through the pump. Routing disable increments a separate routing epoch, removes that source from pending/running jobs and fences old callbacks from scheduling/adopting work after off/on. Do not let an old callback clear/rearm a new timer. Do **not** keep the current blanket account-generation increment on routing disable: that would wrongly invalidate active page ownership. Routing-only completion after disable remains discarded, preserving `test/integration.test.js:1026`; a still-page-owned completion may publish without enabling routing.
5. Identity invalidation is independent of source: key/proxy/deletion invalidate every owner, clear old quota as today, and cancel jobs. Disable transition advances account generation and cancels every owner but **retains last-good quota/time**. Check current enabled/key/existence/identity/generation immediately before admission and publication. Advancing generation prevents disable/re-enable and key A→B→A resurrection. Reset obsolete failure counts on identity replacement/deletion; page withdrawal must not clear genuine backoff.
6. Publication requires valid account generation plus at least one live source (current routing epoch while enabled, or a live page token). No owners means discard success **and** failure; cancellation is not network/proxy failure and must not change timestamps/backoff. A joined page leaving must not abort routing-owned work or another page's work. Once a job has been cancelled, new owners must wait for settlement/new admission, not revive its controller.

## Page/request lifetime and simpler alternatives

- Browser owns one statistics visit generation, timer and refresh controller. Render current GET promptly, perform/join the POST sweep, GET again on completion. Leave/navigation/pagehide clears timer, aborts the POST, invalidates reads; abort is silent. Guard success, catch and finally with visit/request identity. Coalesce clicks/ticks while a sweep is active; do not let an older finally clear the new controller. Preserve existing auth handling and draft/log owners.
- Server registers response-close withdrawal **before awaiting body parsing/work**, checks already-closed state before attaching owners, and removes listeners idempotently on finish/close. A completed request-body `req.close` is not the page lifetime; the open response is. Normal response completion must not mark successful published jobs cancelled. Body-disconnect paths must settle rather than leave pending handlers.
- Keep POST open until that sweep settles; immediate `202` would destroy the proposed response-owned lifetime. Queued accounts must stop on page withdrawal; already completed snapshots need not be rolled back. Native abort support already exists (`server.js:1207-1235`), including response destruction. `streamToString` (`1237-1250`) lacks a standalone close handler: verify abort/early-close settlement, especially between response headers and body consumption.
- A simpler timer-only frontend plus bounded fire-and-forget POST is correct **only if** “leave stops refresh” means no future browser ticks, while accepted server batches may keep fetching. It does not meet strict page-owned withdrawal of queued/in-flight work. GET side effects, a second scheduler, or temporary routing enablement are not correct alternatives. No lease IDs, heartbeat endpoint, persisted source state, or new dependencies are needed for the strict candidate.

## Validation hooks and unresolved risks

Existing commands (not run):

```sh
node --test --test-name-pattern='quota scheduler|enabled quota layers|usage statistics|account HTTP proxy' test/integration.test.js
node --test test/ui-contract.test.js
node --check server.js
npm test
git diff --check
```

Integration helpers use local fixture servers and temporary DATA_DIR (`test/integration.test.js:11-25,75-85`); quota tests inject `NODE_ENV=test` and `CLINE_PASS_TEST_QUOTA_{SUCCESS,FAILURE,TIMEOUT,STALE}_MS` (`1012`). Existing cases cover proxies (`736`), statistics (`785`), pool ordering (`974`), and scheduler/parser/backoff/key/proxy/deletion/routing-disable fences (`1000-1028`). The held fixture decrements its synthetic active count before withholding the response (`1006`); add a true transport-active counter for cancellation/concurrency tests. UI contracts (`test/ui-contract.test.js:28-57,73-101`) are static regex checks, not browser lifecycle automation.

Required new runnable cases: routing off page refresh without config mutation; cache measured from success; forced/manual backoff; overlapping saves/routing/multiple pages globally <=2; same-ID joins; page departure before admission/during headers/body; one owner leaving while another remains; routing off/on fencing; disable/re-enable retaining last-good but discarding held results; credential/proxy rotations and deletion during queued/running jobs; partial/0/100/reset/missing/stale/error display; generation-guarded catches; timer/manual coalescing and navigation preserving drafts. Reject malformed/unauthenticated POST without upstream work or persistence changes.

Design risks to resolve explicitly: manual success-cache bypass policy; bounded batch/waiter lifetime under many authenticated tabs (concurrency alone does not bound queue memory); fairness under repeated forced batches; slow-drip upstream responses (`req.setTimeout` is inactivity, not an absolute deadline); disconnect delivery behind intermediaries (withdrawal can only be enforced once observed). If adding an absolute request/job deadline, use a cleared native timer/controller rather than configuration scaffolding. Surface stale/partial/error/disabled states independently of routing `fresh/unknown`; add safe projection reason/attempt time if necessary, but never reclassify retained data as routing-fresh.
