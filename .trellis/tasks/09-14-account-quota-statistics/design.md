# Statistics Quota Design

## 1. Boundary, Order and Reuse

Implement fourth, after bulk concurrency, raw scheduling JSON and detailed logging pass their gates. Re-check the resulting `switchSection`, API helper, transport/body-reader and account-save paths before writing code. Source research: `research/quota-refresh-ownership.md`; parent independently checked the scheduler/publication/account-save guards.

Reuse `META.accountQuotas`, `parseQuotaPayload`, `quotaProjection`, `clineRequestJSON`, current quota timing constants and the existing statistics table. Keep new runtime refresh ownership in `server.js`; no new dependency, persistent subscription system, quota configuration switch, or separate data source.

The existing cap is only two per scheduler callback, not global admission across overlapping callbacks. The new shared admission path solves this root issue as well as supporting page requests. Account disablement must also invalidate held work; simply removing the `quotaPool` guard is incorrect.

## 2. Statistics Projection and Presentation

Keep `GET /api/statistics` free of new quota fetch initiation; its existing statistics pruning is unchanged. Preserve `quotaProjection()`'s routing `status`, pool thresholds and fresh predicate exactly. Check all consumers: account selection, GET accounts and GET statistics.

Add only safe view metadata beside the existing quota projection in each statistics row:

```js
quota: {
  ...quotaProjection(account.id),
  lastAttemptAt: numberOrNull,
  lastSuccessAt: numberOrNull,
  refresh: {
    eligible: boolean,
    reason: null | 'disabled' | 'unconfigured',
    state: 'idle' | 'queued' | 'fetching',
    nextAttemptAt: numberOrNull
  }
}
```

Derive these fields from current server config, existing quota metadata and the shared job owner. Quota eligibility is enabled + keyed, not the chat eligibility helper's additional ban/cooldown filtering; preserve that existing distinction. Do not return the key, proxy URL, raw quota payload, internal source tokens or AbortControllers. Eligibility is missing key -> unconfigured, otherwise disabled -> disabled, otherwise eligible; names/IDs and all other statistics fields stay unchanged. Do not add per-account config lookups inside the routing hot path merely for UI metadata.

Statistics lists persisted accounts, not `ACCS` drafts. Startup/save already removes blank-key accounts; missing-key rendering is a defensive projection case, not a new persistence feature. Unsaved accounts and unsaved enable/key/proxy edits do not affect server-side quota queries.

Within the existing columns, label every window explicitly, e.g. `5 小时：已用 30.0% · 剩余 70.0%`, plus an available reset timestamp or `未提供`. Validate finite numeric 0–100 usage before computing `100 - percentUsed`; do not coerce null/missing/string data into zero. Format both percentages consistently and preserve known zero/full usage. Never reset usage to zero because a reset timestamp has passed.

Display state on independent axes rather than using routing `fresh/unknown` as the only UI label:

| Condition | Display |
|---|---|
| No key | 未配置; no query/zero quota |
| Disabled with snapshot | 已禁用 · 上次额度, timestamp and retained windows; no query |
| Disabled/no snapshot | 已禁用 · 未知 |
| No snapshot | 未知/尚未获取 |
| Partial successful snapshot | 部分可用; missing windows stay unknown |
| Latest fetch failed | 刷新失败 + safe category; explicitly last-success values/time if present |
| Snapshot older than 15 minutes or invalid time ordering | 过期/上次快照, never presented as current |
| Successful 5-minute cache expired but not routing-stale | Show age/last success and 待刷新 or 刷新中 as appropriate |
| Queue/network active | Separate refresh-state label, not proof of successful new data |

Use server `generatedAt` for consistent initial age display. Explain that quota visibility does not enable quota-pool routing. Preserve full account names, safe text escaping, wide-table scrolling and `aria-live` feedback.

## 3. Explicit Finite Refresh API

```text
POST /api/statistics/quota-refresh
  <- { force: boolean }
  -> { ok: true, refreshed, cached, deferred, skipped, failed, cancelled }
```

Use the existing management authentication boundary. Accept exactly one boolean field in a non-array object; reject missing/unknown fields, non-booleans and query parameters before quota work. Account IDs, keys, proxies and upstream URLs are never client inputs. Derive a finite sweep from the current persisted account list.

Entry/automatic refresh uses `force:false`. Manual refresh uses `force:true`, bypassing only the five-minute success cache; it never bypasses failure backoff, account eligibility, same-account deduplication or the global cap. A current in-flight request is joined, not replayed. If a refresh has already succeeded since this batch started while it was waiting, reuse that result even for a forced batch; overlapping manual requests must not serialize into redundant calls.

Keep the response open until the one sweep settles; return safe counts and then let the browser call the existing GET projection. Do not add an asynchronous job API, heartbeat or duplicate statistics serializer. A sweep does not automatically retry deferred/failed accounts; normal page ticks or the existing routing scheduler decide future demand.

Register response-close cancellation before awaiting input parsing/work and check already-closed state before admitting owners. A normal request-body `close` is not page departure. Normal response finish only cleans up its listener after publication; an early response/socket close withdraws that batch. Ensure body-read/disconnect and upstream headers/early-body-close paths settle (reuse earlier logging fixes where present) rather than leaving promises/listeners hanging.

## 4. One Shared Admission Owner

Evolve the existing in-flight tracking into a small per-account job map and one FIFO admission pump in the quota section of `server.js`. Every network call, whether requested by the routing scheduler or statistics, passes this owner.

A job needs account ID/generation and captured transport identity, one promise/controller, queue/running state, page-batch owner tokens and an optional routing epoch. Do not build a class/interface hierarchy for these few runtime fields.

- Reserve a global slot synchronously before starting transport; retain it until the actual request/body settles, including aborting work. Maximum is two across all sources and scheduler callbacks.
- Keep one current job/ID lock. A duplicate valid demand joins its promise. A cancelled/invalidated job cannot be revived; new demand waits for settlement, then rechecks eligibility/cache/backoff before new admission. An old finalizer must not delete a replacement job or release capacity twice.
- Queue only IDs/current-generation work, not arbitrary account payloads. Prune cancelled/removed jobs, retain FIFO fairness, and re-read current config/identity/due status at dequeue time.
- Use successful snapshot time (`lastSuccessAt`, matching `snapshot.fetchedAt`, not in the future) for five-minute cache reuse. A partial valid success is cacheable but not routing-fresh. Latest failure overrides success-cache reuse and uses the existing exponential backoff calculation from `lastAttemptAt`.
- Preserve native account proxy, no direct fallback, Accept + account Authorization only, 256 KiB response cap and existing schema validation. Do not forward chat-only custom headers.
- Add a cleared absolute deadline using the existing `QUOTA_TIMEOUT_MS` and AbortController for each quota fetch. The current socket timeout is only inactivity-based and cannot bound a slow-drip response. No new timeout setting is required.

Bound HTTP owner growth separately: allow at most 16 active statistics batches as an internal safety constant (not an operator setting); excess requests get a safe 429/Retry-After without creating jobs. Queue size remains bounded by configured account IDs, owner references by this batch limit plus the routing owner. Each batch is one finite sweep and has a cleared safety deadline derived from its finite account count, two slots and the per-fetch timeout, with one extra fetch interval for pre-existing work. Expiry withdraws only that page owner and reports incomplete refresh; it does not clear backoff or fail model traffic.

## 5. Separate Identity and Source Fences

Keep account generation distinct from a new runtime routing epoch:

| Event | Invalidate/retain |
|---|---|
| Key/proxy change or account deletion | Advance account generation, cancel every owner/job for old identity, clear old snapshot as today, clear obsolete failure counters |
| Enabled -> disabled | Advance account generation and cancel all refresh owners, but retain last-good quota/time for display |
| Disabled -> enabled | Generation remains distinct from pre-disable work; new requests may reuse valid retained cache or fetch when due |
| Quota routing off | Advance routing epoch, clear routing timer and withdraw only routing ownership; do not blanket-advance all account generations |
| Quota routing off -> on | New epoch/scheduler; old callbacks cannot adopt work, clear or rearm the new timer |
| One page leaves | Remove only that page token; other pages/routing may keep a shared job alive |
| No valid owner remains | Drop queued job or abort running job; discard both success and failure without metadata/backoff mutation |

Immediately before network admission and publication, check account existence, enabled/non-empty key, matching key/proxy and account generation. Publication additionally requires at least one live page owner or a still-enabled matching routing epoch. This prevents key A->B->A and disable/re-enable resurrection.

A cancellation due solely to source withdrawal or invalidation is not a quota failure: do not modify lastAttempt/lastSuccess/error/backoff. Actual timeout/HTTP/schema failure with a valid owner retains the last snapshot and records the existing safe category/backoff. A successful partial payload replaces the whole snapshot; never fill its missing windows from older success data.

Preserve routing-only disable behavior tested at `test/integration.test.js:1026`: its held completion still cannot publish. A shared page-owned fetch may finish while routing is off because an independent consumer still requested it; that does not enable routing or change fresh-data criteria.

## 6. Browser Visit Lifetime

Reuse the existing statistics panel and `STATISTICS_QUERY_ID` for reads. Add a statistics visit generation, one five-minute timer and one active refresh controller/promise; these are separate from account drafts and the existing log/detail query owners.

- On entry, GET/render current statistics promptly, then start/join one automatic cache-aware sweep and GET again when it settles.
- Timer ticks/manual clicks coalesce while a sweep is active; disable/label the manual refresh control while busy. Never overlap new sweeps from one page or queue missed timer ticks for replay.
- Leaving statistics or pagehide clears the timer, aborts the POST and invalidates the visit/read generations. Backend withdrawal stops work once it observes connection cancellation; a proxy/intermediary can delay that signal. Already completed cache writes are not rolled back.
- Guard success, catch and finally with visit/query/controller identity. An old failure must not replace current or hidden statistics status, and an old finally must not clear a new visit's controller.
- After failures, keep last rendered values labelled with their time/error rather than replacing them with zero. Backoff/deferred counts should explain why manual refresh did not perform a new upstream query.

Extend the existing `api()` helper only with an optional AbortSignal argument/options value; inspect its callers and preserve the existing three-argument behavior and 401 login handling. Do not duplicate authentication/fetch logic. Quota navigation/refresh never calls `loadAll()` or mutates `ACCS`/raw/bulk drafts.

There is no permanent page-refresh scheduler in the server: only the page timer creates future page demand. Routing background refresh retains its own bounded timer/cursor, but old async callbacks are fenced before rearming. Closing a page cannot stop routing-owned work.

## 7. Validation and Rollback

Extend local-mock integration for both old and new quota contracts, using existing `CLINE_PASS_TEST_QUOTA_*` timing hooks. Add a true upstream request/response-active counter and explicit barriers; the old held fixture decrements its synthetic counter before the held response ends, so it cannot prove cancellation overlap by itself.

Use the preceding children's production-script VM/DOM harness for timer/manual/coalescing/abort/stale-catch and draft-preservation tests; static UI markers remain separate. Manual browser review covers readable percentages/timestamps, disabled/unknown/error states, keyboard refresh and narrow scrolling. See `implement.md` for commands and QC1–QC8 mapping.

Statistics/refresh API and quota upstream calls remain excluded from ordinary/detailed chat diagnostics and usage/health statistics. No configuration write is performed to refresh quota. Existing fresh routing, parser validation and account persistence remain intact.

Rollback only the reviewed quota child diff, restoring the prior scheduler together with its source guards rather than partially removing fences. Keep earlier three features and operator config/metadata/logs. No task activation, application test success or implementation is claimed by this design.
