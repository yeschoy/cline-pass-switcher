# Architecture analysis: error presets, usage/health statistics, account pipeline, and quota refresh

## 0. Scope and current boundaries

This document is a design-research artifact only. It is based on:

- `.trellis/tasks/09-14-error-presets-usage-health-pipeline/prd.md`
- `.trellis/tasks/09-14-error-presets-usage-health-pipeline/research/clinepass-usage-limits.md`
- `server.js`
- `public/index.html`
- `test/integration.test.js`, `test/ui-contract.test.js`, `test/jsonl-log-store.test.js`
- `.trellis/spec/backend/{database-guidelines,quality-guidelines,logging-guidelines}.md`
- `.trellis/spec/frontend/{state-management,quality-guidelines}.md`
- `README.md`

The repository is a zero-framework, zero-database Node 18 service. Static configuration is atomically persisted in `config.json`; dynamic state is in `metadata.json`; bounded request/error diagnostics use `lib/jsonl-log-store.js`. The safest implementation is therefore an extension of these mechanisms, not a database, framework, or new dependency.

The most important current functions are:

- configuration/migration: `normalizeConfigAndMeta()`, `normalizeAccount()`, `validateAccountErrorRulesInput()`, `atomicWriteJson()`;
- eligibility and capacity: `enabledAccounts()`, `accountHasCapacity()`, `tryLease()`, `waitForCapacity()`, `waitForLease()`;
- selection: `hrwRank()`, `rrRank()`, `strategyRank()`, `acquireAccountLease()`;
- provider execution: `runChatChain()`, `attemptOnce()`, `handleChat()`;
- response normalization: `unwrap()`, `normalizeStatus()`, `parseRouting()`;
- final diagnostics: `record()` and the idempotent streaming `finalize()` closure;
- administration: `GET/POST /api/accounts`, `POST /api/accounts/recover`, and the static UI’s `renderAccounts()`, `collectAccounts()`, `saveAccounts()`, `previewPreset()` and `switchSection()`.

## 1. Usage extraction and exactly-once accounting

### 1.1 Current reliable extraction points

#### Non-streaming

`attemptOnce()` parses the complete JSON response and passes it through `unwrap()`. `unwrap()` calls `parseRouting(d)`, where `d` is either the top-level OpenAI-compatible payload or the inner `data` payload when `data.choices` exists. `parseRouting()` currently exposes `d.usage || null`.

The reliable usage point is therefore **the final successful `chain.routing.usage` returned by `runChatChain()`**, after all provider attempts and any one permitted account replacement have finished. Do not add usage at `attemptOnce()` or inside the provider loop: an earlier failed/fallback attempt can otherwise be counted in addition to the final response.

`handleChat()` already has one normal non-streaming terminal path immediately before `record()`. That is the correct commit point.

#### Streaming

The current stream path only inspects the first complete SSE event before exposing the stream, then buffers the rest in `buf` and reparses the complete text inside `finalize()`. It scans provider metadata and late error envelopes, but does not extract usage.

Usage can legitimately arrive only in a late/final SSE event, often immediately before `[DONE]`. The reliable point is therefore the existing idempotent `finalize()` closure, after all received SSE events have been parsed and after any late stream error has updated the terminal trace.

However, the existing `buf.push(Buffer.from(c))` retains the entire streamed response. Extending this full-buffer approach would increase an existing unbounded-memory risk. Recommended replacement: an incremental SSE observation parser in the `Transform` path that:

- keeps only an incomplete-event buffer with an explicit maximum (the first-event path already uses 64 KiB as a useful bound);
- parses every complete `data:` event without changing the bytes passed downstream;
- remembers only the last valid normalized usage projection, last safe provider/canonical projection, and first terminal error projection;
- treats multiple usage-bearing events as cumulative snapshots and keeps the **last**, never sums them;
- ignores `[DONE]` and malformed/non-object events;
- commits only from the idempotent finalizer.

If replacing full buffering is outside the immediate code slice, usage extraction may initially reuse the finalizer, but a hard stream-observation byte bound is still required to avoid turning statistics into a memory-exhaustion vector.

### 1.2 Strict normalized usage projection

Use one pure function, for example:

```js
normalizeUsage(raw) -> {
  inputTokens: number | null,
  outputTokens: number | null,
  totalTokens: number | null,
  cachedTokens: number | null,
  cacheFieldPresent: boolean
} | null
```

Only accept finite, non-negative integers. Presence must be tested with `hasOwnProperty`; explicit zero is known data, not missing data. Reject a malformed individual field as unknown rather than coercing strings, negatives, fractions, `NaN`, or infinity. Do not calculate a missing total from input plus output: the PRD forbids inferred token data.

Recommended precedence, based on the currently OpenAI-compatible endpoint plus known equivalent envelopes:

| Normalized field | Accepted explicit source fields, in precedence order |
|---|---|
| input | `prompt_tokens`, `input_tokens`, `inputTokens` |
| output | `completion_tokens`, `output_tokens`, `outputTokens` |
| total | `total_tokens`, `totalTokens` |
| cached | `prompt_tokens_details.cached_tokens`, `input_tokens_details.cached_tokens`, `cache_read_input_tokens`, `cached_input_tokens`, `cachedInputTokens` |

Notes:

- `README.md` explicitly names `usage.prompt_tokens_details.cached_tokens` as the verified cache signal.
- Anthropic-style `cache_read_input_tokens` is a real cache-read signal. `cache_creation_input_tokens` is **not** a cache hit and must not be added to cached tokens.
- A field named `cache_creation_*`, session affinity, stable HRW routing, repeated prompts, provider identity, or response timing is never evidence of a cache hit.
- Accept aliases only within the selected raw `usage` object. Do not recursively scan arbitrary upstream JSON, because unrelated nested counters can be misclassified.
- If two aliases are present and disagree, use the documented precedence and optionally expose an internal safe schema-conflict counter; never add both.

The raw usage candidates should be limited to `payload.usage` and the already-recognized `payload.data.usage` wrapper. For SSE, apply the same candidate rule to each parsed event.

### 1.3 Missing-field semantics and truthful ratios

A request can have a usage object with only some known fields. Persist separate coverage counters; a zero sum alone cannot distinguish “all responses reported zero” from “no response reported this field.” Minimum aggregate fields are:

```text
requests
usageRequests
inputKnownRequests, inputTokens
outputKnownRequests, outputTokens
totalKnownRequests, totalTokens
cacheKnownRequests, cacheHitRequests, cachedTokens
cacheInputKnownRequests, cacheInputTokens, cacheInputCachedTokens
```

For cache metrics:

- cache-token share = `cacheInputCachedTokens / cacheInputTokens`; both paired counters include values **only for requests that explicitly reported a cache field and an input-token field**. `cachedTokens` remains the independent total across every request with an explicit cache field and is not the ratio numerator;
- cache-hit request rate = `cacheHitRequests / cacheKnownRequests`, where a hit means explicit `cachedTokens > 0` and an eligible request means an explicit cache field, including explicit zero;
- missing cache fields enter neither denominator;
- if a denominator is zero, API/UI returns `null` and displays “无数据/未知”, not `0%`;
- if field coverage is partial, show the sum together with coverage (for example “1.2M（87/100 请求有数据）”) instead of implying a complete total.

Do not synthesize `totalTokens`, or clamp cached tokens to input tokens silently. If an upstream reports `cachedTokens > inputTokens`, preserve valid individual counters but make the ratio unavailable/schema-invalid rather than publish a ratio over 100%.

### 1.4 Exactly once per downstream chat request

Introduce one request-scoped observation owner in `handleChat()`, for example:

```js
const observation = createChatObservation({ requestId, requestedModel, resolvedModel });
observation.commitOnce(finalFacts);
```

All aggregate mutation—one global request, account segments, final usage, and health—must happen in `commitOnce()`. Its closure-local boolean is the primary idempotency guard. This mirrors the current stream `finalized` guard and protects flush/error/close races without an unbounded global request-ID set.

Rules:

1. One accepted chat invocation produces at most one global request observation, including capacity rejection (with no account usage/health segment).
2. Provider retry attempts do not increment global or per-account request totals individually.
3. Each distinct account used by the request contributes one account segment/request count at most once.
4. Final successful usage belongs only to the account that returned that response. A failed first account does not receive the replacement account’s token usage.
5. A non-streaming final success uses `chain.routing.usage`; a final failure has no usage unless the contract explicitly delivered a valid final usage (recommended first release: do not count error-envelope usage).
6. A stream uses the last valid usage event seen before finalization. Repeated cumulative chunks are not summed.
7. `/api/test`, probes, upstream validation, official-model fetches, and quota-refresh traffic must not enter downstream chat statistics or health. Current `/api/test` calls `record()` and therefore increments legacy `META.stats`; diagnostics and chat accounting need separate boundaries.
8. JSONL diagnostic append retries/deduplication must not drive aggregate mutation. Statistics commit occurs once in memory; diagnostic persistence remains best-effort and independent.

Rejected approach: increment counters in `parseRouting()`, `attemptOnce()`, `runChatChain()` attempt iterations, or the stream transform callback. Each location observes retries or repeated chunks and will double count.

## 2. Minimal bounded persistence for lifetime and recent 24 hours

### 2.1 Recommended schema

Keep the model in dynamic metadata, versioned and keyed by stable account ID:

```js
META.statistics = {
  version: 1,
  lifetime: {
    global: Aggregate,
    accounts: { [accountId]: Aggregate }
  },
  minuteBuckets: [
    {
      minute: Math.floor(timestamp / 60000),
      global: AggregateDelta,
      accounts: { [accountId]: AggregateDelta },
      health: { [accountId]: HealthDelta }
    }
  ],
  recentCoverage: {
    droppedAccountMinuteCells,
    accountIncompleteAt: { [accountId]: minute }
  },
  migration: {
    legacyStatsMigratedAt,
    legacyRequests,
    accountLegacyRequests: { [accountId]: number },
    ambiguousNames?,
    unmappedNames?
  }
}

HealthDelta = {
  results,
  penaltyUnits,
  errors,
  byClass: { auth, rateLimit, networkProxy, server, other }
}
```

Keep at most 1,440 distinct minute keys: the current minute plus the preceding 1,439. One account-minute cell is the union key `(minute, accountId)` across that bucket's `accounts[id]` and `health[id]` maps. Global minute deltas are retained. Hard-cap cells at 50,000; eviction removes both maps for the oldest complete cell, preserves global deltas, and stores the newest omitted minute in `accountIncompleteAt[id]`. That account remains coverage-incomplete and health-insufficient until the omitted minute ages out. This produces an explicit `1440 buckets + 50,000 account cells + current-account lifetime` bound instead of unbounded `O(accounts × buckets)` growth.

Aggregate counters are non-negative safe integers or `null` with a matching bounded `overflowFields` enum. An addition beyond `Number.MAX_SAFE_INTEGER` changes that field to null permanently and dependent ratios remain null. Health weights use integer tenths (`10/7/6/4/5`) in `penaltyUnits`; display converts them to the approved decimal weights.

### 2.2 Lifetime and account semantics

- `lifetime.global.requests`: one per finalized downstream chat request.
- `lifetime.accounts[id].requests`: one per request/account segment, so a single request that changes A→B increments both once. The API must name this clearly (for example `handledRequests`) because account sums may exceed global requests.
- Account token counters: only final successful usage attributed to the response account.
- Account error counters: one terminal failed account segment, even if that segment contains multiple failed provider attempts.
- Global token counters: final successful usage once.
- Global error count: based on the final downstream chat result, not every account/provider attempt; per-account errors retain the segmented operational view.

This distinction prevents both duplicate usage and the misleading expectation that global request count equals the sum of account-handled segments.

### 2.3 Persistence and restart

Reuse `atomicWriteJson()`/`saveMeta()`; malformed `metadata.json` must continue to fail startup rather than be overwritten. Mutate statistics synchronously in the single Node event loop and perform one metadata save per final observation, not one save per provider attempt or SSE chunk.

Because minute buckets enlarge `metadata.json`, whole-file synchronous atomic rewrites may become expensive at high account counts. The minimum implementation can retain current behavior because `record()` already calls `saveMeta()` once per request. Measure file size/write latency. If it becomes a bottleneck, the next step is a dedicated append/compact statistics journal using the existing `JsonlLogStore` durability pattern—not an unbounded event log and not a timer-only in-memory buffer. A debounce-only writer risks losing recent statistics on process termination and does not satisfy a strong restart boundary.

Startup must validate the versioned statistics projection without accepting secrets or arbitrary nested raw objects. A missing subtree is initialized/migrated. Existing version 1 structural/counter/bucket corruption and unknown newer versions fail startup before any save, preserving the original metadata bytes; they are never silently reset. `loadJson()` parse/read failures remain fatal.

### 2.4 Migration from legacy `META.stats` names

Current `record()` stores:

```js
META.stats[info.account] = { requests, lastUsed, lastError }
```

The key is editable account name, and `/api/test` is mixed in. Migration cannot reconstruct tokens, cache, per-request events, exact 24-hour history, or whether a request was a test. Do not invent them.

Recommended one-time migration in `normalizeConfigAndMeta()` after stable account IDs exist:

1. Build exact account-name → IDs groups from normalized current accounts.
2. For a legacy name with exactly one matching ID, copy only valid non-negative integer `requests` into independent `migration.accountLegacyRequests[id]`, never into the exact lifetime chat aggregate. Treat token/cache/24-hour/health as unknown. Never carry raw `lastError`.
3. Add each legacy map entry once to `migration.legacyRequests`. This historical baseline may include management tests and is displayed separately; it must not be summed into exact chat `requests` without an explicit legacy label.
4. If zero IDs match (account renamed/removed) or multiple IDs share the same name, do not arbitrarily assign it. Record only bounded migration counts such as `{ ambiguousNames: 1, unmappedNames: 2 }`, and retain its request baseline as `legacyUnattributedRequests` if historical global continuity is desired.
5. Set a migration version/timestamp and delete or stop reading the old `META.stats` map so restart cannot migrate twice.

Rejected approaches: use the first same-name account, divide counts across duplicates, map by key, or infer an ID from current array position. Each creates false account history or crosses the key boundary.

### 2.5 Account deletion and churn

On a successful full account save:

- increment an in-memory quota generation for deleted or credential/proxy-changed IDs; an in-flight refresh may commit only if the account still exists and its captured generation/key/proxy still match;
- delete deleted IDs from account lifetime aggregates, minute-bucket account deltas, health/coverage deltas, quota snapshots/status, and current `accountStates` (the last behavior already exists);
- an in-flight chat completed after deletion keeps its global observation but may not recreate that account's lifetime/recent/health state;
- retain global aggregates, which describe service history and therefore will no longer equal the visible current-account sum;
- a later id-less account receives a fresh ID and starts with no account history;
- renaming with the same ID preserves account history;
- key rotation with the same ID preserves local statistics/health but must invalidate or immediately refresh the external quota snapshot because it may represent a different subscription.

Pruning deleted IDs avoids unbounded account churn. If deleted-account historical reporting is later required, it needs an explicitly bounded tombstone design; retaining arbitrary names forever is rejected.

### 2.6 High-volume and precision risks

- Per-request 24-hour arrays grow without bound; reject.
- Computing 24 hours by scanning request logs is not reliable: logs cap at 50,000 records/30 days and can lose an entire 24-hour interval under high traffic.
- Reusing request-log timestamps but token data in metadata creates cross-store consistency ambiguity; use one statistics owner.
- Persisting percentages causes rounding drift; persist numerator/denominator counters.
- Showing zero when coverage is zero creates false precision; return `null` plus coverage.
- Repeated `saveMeta()` inside provider/account loops amplifies I/O and partial logical updates; commit one complete observation.

## 3. Per-account health results from trace/account path/action

### 3.1 Segment construction

Current `handleChat()` runs at most two account chains. `completedTrace` concatenates provider attempts and each trace entry already has `accountId`, account name, statuses, network sentinel (`upstreamStatus === 0`) and rule `action`. `accountPath` currently contains names only; for robust joins add/use an internal ID path, or derive ordered IDs from trace plus `chain.acc.id`.

Construct account segments at finalization by ordered account ID, not account name:

```text
segment(accountId) = all contiguous provider trace entries for that account
terminal result     = the segment’s final meaningful attempt/lifecycle outcome
```

Deduplicate by account ID in the request-scoped observation, so even accidental repeated use of the same account produces one result. The current two-account loop makes segments naturally bounded to two, while provider retry count can be up to 21.

Do not average all trace entries. Examples:

- A: 500 then 200 ⇒ one success result, weight 0.
- A: 500 then 502 final ⇒ one final 5xx result, weight 0.4 (or network 0.6 if the final attempt is network/proxy).
- A: 429 cooldown, B: 200 ⇒ A gets 0.7; B gets 0.
- A: 429 cooldown, B: 429 cooldown ⇒ A and B each get 0.7, but no C is selected.

`accountAction` helps identify why an account chain stopped/replaced, but health classification must use normalized status/error origin, not the configured action. An operator can configure 500 as `ignore`; the final 500 still reflects service health if the chain ends there. Conversely, `ignore` on a parameter 400 must not punish the account.

### 3.2 Classification

Recommended pure function:

```js
classifyAccountHealthResult(segment, terminalLifecycle) ->
  { include: boolean, success: boolean, weight, class, normalizedStatus }
```

Precedence:

1. successful terminal response/clean completed stream: include, weight 0;
2. 401 or 403: include, weight 1.0, class `auth`;
3. 429: include, weight 0.7, class `rateLimit`;
4. explicit proxy/network/timeout/upstream transport failure: include, weight 0.6, class `networkProxy`;
5. 500–599 response envelope: include, weight 0.4, class `server`;
6. 400–499 other than 401/403/429: **exclude from the health denominator**, class `requestParameter`;
7. another account-attributable non-parameter terminal error: include, weight 0.5, class `other`.

Excluding parameter 4xx rather than recording a zero-weight success prevents invalid-client spam from artificially improving an account’s score. It may still increment the account’s operational error counter, but not `HealthDelta.results` or weighted denominator.

Health score over minute buckets is:

```text
100 - ((penaltyUnits / 10) / includedResults) * 100
```

Keep an unrounded numeric score for ordering; round only for display. Fewer than five included results is `insufficient_data`, regardless of the provisional score. Operational state overlays scoring in this order: disabled → banned → cooling → insufficient/scored state. “No key” is an eligibility/configuration state and should be shown separately.

### 3.3 Results that must not punish an account

- provider attempts that failed before a later attempt on the same account succeeded;
- downstream capacity rejection/no selected account;
- malformed/downstream-invalid chat input rejected before upstream selection;
- 4xx request/parameter errors other than 401/403/429;
- downstream client disconnect/cancel. Current stream finalizer calls `finalize('client disconnected')`; this must carry an explicit `client_disconnect` origin and be excluded rather than inferred as network failure;
- service shutdown or local observation/log persistence failure;
- quota endpoint refresh failure (quota state becomes unknown only);
- probe/test/validation/official catalog traffic;
- an error caused exclusively by local configuration validation before sending upstream.

A stream that emits a genuine upstream error after output starts is account-attributable and may be penalized according to its normalized status, but it must not be replayed. An upstream stream transport failure not caused by downstream close is network weight 0.6.

The current `proxyError` heuristic (`account has proxy && any trace upstreamStatus === 0`) is suitable for display classification but too coarse for health. Carry explicit terminal origin (`proxy`, `network`, `timeout`, `upstream_http`, `upstream_envelope`, `client_disconnect`) from transport/lifecycle.

## 4. Account pipeline and exact legacy compatibility

### 4.1 Configuration shape and validation

Recommended minimal shape:

```js
accountPipeline: {
  quotaPool: false,
  excludeUnhealthy: false,
  healthSort: false,
  sticky: false
}
```

- Missing field and all-false normalize to all false.
- Management API accepts only an object with these four boolean fields; reject arrays, non-booleans, and unknown keys.
- Startup normalization is permissive for a missing legacy field but removes/turns off invalid legacy values safely.
- `POST /api/accounts` should carry the complete snapshot. To protect older clients from silently disabling an already-enabled pipeline, a missing `accountPipeline` in the API payload should preserve the current value; the updated UI must always include it.
- New installations keep every switch false.

### 4.2 Non-negotiable legacy fast path

Extract the present `acquireAccountLease()` body unchanged into `acquireLegacyAccountLease()` (or retain it as a branch) and invoke it when `quotaPool`, `excludeUnhealthy`, `healthSort`, and `sticky` are all false. This includes existing `accountMode === 'sticky'`: that mode must retain its exact HRW wait/overflow branch and counts as the implicit affinity behavior without running a second sticky step.

This early branch is the strongest compatibility guarantee. Trying to emulate all old behavior through a new generic sort is risky because current semantics differ materially:

| mode | behavior that must remain exact when pipeline is off |
|---|---|
| `single` | configured active account if statically available, otherwise first current config-order candidate; waits only for it; no capacity overflow |
| `roundrobin` | filters full accounts, advances `RR_COUNTER` on ranking/selection, waits only when all candidates full |
| `sticky` | HRW by stable ID; waits preferred for full `waitMs`, then immediate lower-ranked overflow; no identity means RR |
| `least-connections` | minimum active count among capacity-eligible accounts; RR tie break |
| `weighted-roundrobin` | virtual slots only from capacity-eligible accounts; `strategyCounters` advances once per selection ranking |
| `priority-failover` | lowest numeric priority among capacity-eligible accounts, so a full primary immediately falls to a lower priority tier; RR within priority |

Do not sort legacy candidates by account ID, change when RR counters advance, or rebuild weighted slots from full accounts. Those changes would be observable regressions.

### 4.3 Recommended function boundaries

```js
normalizeAccountPipeline(value, { strict })
getMandatoryEligibleAccounts({ excludeIds, now })
getHealthSnapshot(accountId, now)
getQuotaSnapshot(accountId, now)
buildPipelinePlan(accounts, identity, pipeline, now)
// -> ordered groups + diagnostics; no lease mutation
rankModeCandidates(mode, candidates, context)
acquireFromPipelinePlan(plan, identity, options)
// only owner of tryLease/wait loop
acquireLegacyAccountLease(identity, options)
selectionResult(..., pipelineDiagnostics)
```

`buildPipelinePlan()` should be pure for one acquisition iteration. `acquireFromPipelinePlan()` synchronously calls `tryLease()` and recomputes the plan after capacity wakeups because account states, health window boundaries, quota freshness, and capacity can change while waiting.

Never call account selection inside `runChatChain()`. `handleChat()` remains the only owner of the two-iteration account replacement loop. A replacement calls the same pipeline with `excludeIds` containing the first account; the provider chain restarts on the replacement account. A second removal action terminates without a third account. `chain.started` continues to forbid replay.

### 4.4 Fixed pipeline order

Recommended fixed order:

1. **mandatory eligibility:** remove no-key, disabled, excluded-by-current-request, banned, and unexpired cooldown accounts;
2. **optional unhealthy filter:** remove only scored `unhealthy`; insufficient/available/degraded remain. If all mandatory candidates were removed, fall back to the highest-scoring unhealthy candidate(s) and record `health-filter-fallback`;
3. **optional quota pool:** a fresh, last-attempt-successful, complete three-window snapshot is classified by worst (maximum) `percentUsed` into hot `<80`, warm `80–<95`, unknown, reserve `>=95`;
4. **optional health layers:** available and insufficient together, then degraded, then unhealthy (unless filtered); within a tier retain deterministic mode handling;
5. **optional/implicit affinity:** when configured or `accountMode === 'sticky'` and an identity fingerprint exists, HRW promotes one candidate within the current best quota/health group; no identity does not create affinity;
6. **existing account mode:** it may not overwrite an available HRW primary; it owns fallback ranking/capacity according to the approved matrix below.

Health filtering precedes quota so a known-unhealthy hot account cannot hide a healthy warm account. Quota still precedes health sorting within the remaining candidates. All-quota-unknown is a no-op that preserves ordinary candidates and mode ordering.

### 4.5 Capacity, waiting, and starvation avoidance

A naive “pick first static quota/health tier and wait only there forever” can starve lower tiers while they have free capacity. Preserve the existing principle that non-single modes wait only when all usable candidates are full:

- evaluate ordered pipeline groups against capacity at each iteration;
- select the highest-ranked group that currently has capacity;
- if a better quota/health group exists but is full and a lower allowed group is leaseable, use the lower group immediately and record a bounded reason such as `quota-capacity-fallback` or `health-capacity-fallback`;
- only wait when no allowed group has capacity; after notification, recompute all groups;
- mandatory-excluded accounts are never capacity fallbacks;
- a health-filter fallback is permitted only when there are no non-unhealthy mandatory candidates, not merely because healthy accounts are currently full.

This interprets “first non-empty pool” as the first non-empty **leaseable** pool at the actual selection point and preserves capacity use. If product design instead requires reserve conservation even while all hot/warm accounts are busy, that must be explicit because it intentionally returns 429 despite idle accounts; it is rejected as the default due to candidate starvation.

Apply HRW exactly once. With no identity, skip optional affinity; sticky mode keeps its existing no-identity round-robin behavior. With identity and `accountMode=sticky`, wait for the HRW primary up to `concurrencyWaitMs`, then overflow by remaining HRW/group order. With identity and optional sticky on `single`, the HRW primary overrides active and single waits only for that account. With optional sticky on round-robin, least-connections, weighted, or priority modes, an available HRW primary wins; if full, those modes immediately choose among remaining same/lower groups. The final mode never overwrites a leaseable HRW primary.

Without optional affinity, `single` prefers active only if it survives the highest allowed pipeline group; otherwise it selects the first config-order candidate in that group and waits only for it.

### 4.6 Determinism and reasons

- HRW uses the existing persisted `META.routingSecret` and stable account ID; never account name or array position.
- Health ordering uses the approved status layers; normal within-layer order stays owned by affinity/mode. The unrounded numeric score is used only for display and choosing the highest-scoring unhealthy fallback after the filter removes every mandatory candidate.
- Quota compares categorical pool, not tiny percentage differences within a pool.
- Existing mode decides within an equal pipeline layer. Where that mode has a true tie and no RR/weight semantics, stable account ID is the last tie-breaker.
- Do not insert ID sorting ahead of current RR/weighted behavior; that changes distributions.
- Diagnostics should include only enumerated flags/reasons and account IDs/names already allowed: mandatory candidate count, selected quota/health tier, filter fallback, affinity primary/overflow, mode reason, and account path. Never log raw session/fingerprint, quota response, keys, proxy URL, or custom header values.

Recommended reason vocabulary includes `quota-hot`, `quota-warm`, `quota-unknown`, `quota-reserve`, `quota-all-unknown`, `quota-capacity-fallback`, `health-filtered`, `health-filter-fallback`, `health-available-or-insufficient`, `health-degraded`, `health-unhealthy`, `pipeline-sticky-primary`, `pipeline-sticky-overflow`, followed by the existing mode reason.

### 4.7 Rejected pipeline designs

- Arbitrary drag/drop stage ordering: violates fixed safety order and makes behavior untestable.
- Mutating the account array globally: can alter legacy mode order and concurrent request behavior.
- Treating insufficient data as unhealthy: causes new-account starvation and prevents sampling.
- Falling back to disabled/banned/cooled/no-key accounts: violates the mandatory boundary.
- Using health score as a new account mode that replaces existing mode: breaks compatibility and capacity semantics.
- Re-selecting between provider retries: violates account-bound authorization and can multiply account changes.
- Applying both sticky mode and sticky pipeline separately: causes double HRW/ranking and unexpected remapping.

## 5. Cline usage-limit background refresh

### 5.1 External contract and strict projection

The researched endpoint is:

```text
GET {upstreamBase}/users/me/plan/usage-limits
Authorization: Bearer <account key>
Accept: application/json
```

For the default base this resolves to `https://api.cline.bot/api/v1/users/me/plan/usage-limits`. It is semi-documented and must fail open.

Project only:

```js
META.quota = {
  [accountId]: {
    snapshot: {
      limits: {
        five_hour?: { percentUsed, resetsAt },
        weekly?: { percentUsed, resetsAt },
        monthly?: { percentUsed, resetsAt }
      },
      fetchedAt
    },
    lastAttemptAt,
    lastSuccessAt,
    errorCategory: null | enum
  }
}
```

Validation:

- require `success === true`, `data` object, and `limits` array;
- ignore unknown `type` values;
- reject duplicate known types;
- for every known row present, require finite numeric `percentUsed`; safest strict behavior is range 0–100 (do not coerce strings). `resetsAt` may be absent/null; otherwise require a parseable ISO timestamp and store a canonical ISO string;
- require at least one valid known type to retain a diagnostic snapshot, but routing classification requires all three known types from a successful attempt;
- if any known row is malformed, reject the whole new projection and retain the last-known-good snapshot for UI diagnostics only;
- never persist the raw payload, response headers, request URL with credentials, key, or exception object.

The prior research mentions clamping finite values after validation. For routing safety, rejecting out-of-range values is preferable to silently converting a provider-contract break into confident quota ordering. Either choice must be covered by a contract test; coercing non-numbers is rejected.

### 5.2 Scheduler

Recommended conservative first-release defaults (constants, not user configuration):

- request timeout: 15 seconds, matching the researched independent client behavior;
- maximum concurrent refreshes: 2 (or at most 4 for large pools); use a tiny internal worker queue, no dependency;
- success refresh interval: 5 minutes;
- failure retry: exponential/backoff classes bounded between 1 and 15 minutes, with jitter;
- snapshot stale-after: 15 minutes (three normal intervals);
- startup: schedule enabled/keyed accounts with stable per-ID jitter rather than issuing all requests at once;
- timer handles call `.unref()` so they do not prevent shutdown;
- never overlap two refreshes for the same account;
- disable/remove account: stop scheduling and delete its quota state on account deletion;
- key/proxy change: mark snapshot unknown immediately and schedule a near-term refresh.

The refresh loop is entirely independent of `handleChat()` and `acquireAccountLease()`. Selection reads only an in-memory projected snapshot and timestamp. It never awaits refresh, starts refresh, or blocks on quota I/O.

Each refresh captures an in-memory per-account generation plus the current key/proxy values. Delete, key/proxy mutation, or quotaPool disable increments the generation; completion commits only if the account still exists and every captured value still matches. This prevents stale in-flight refreshes from resurrecting deleted/rotated state. Similarly, an in-flight chat may retain its global observation after account deletion but may not recreate account-level statistics.

Production timings remain constants. A `NODE_ENV=test`-only timing/zero-jitter seam lets child-process integration tests verify concurrency, timeout, retry, stale, and non-overlap without real minutes or real Cline calls. Production ignores those test variables.

A simpler interval that refreshes every account simultaneously is rejected: it creates thundering herds and unbounded concurrency. Refresh-on-chat is rejected because it adds a semi-documented network dependency to the critical path.

### 5.3 Account proxy and transport boundary

Quota is account-bound Cline traffic and should use that account’s configured HTTP/HTTPS/SOCKS agent through existing `clineRequest()`/`proxyAgentFor()`. A configured proxy failure must not retry directly. Send only endpoint-required headers (`Accept` and account `Authorization`); do not forward downstream headers or account custom chat headers to the quota endpoint.

The refresh closure may hold the key in memory because it already exists in `config`, but it must never put it in META, logs, error responses, timer labels, or diagnostic reasons. Use `safeReason()` only as defense in depth; persist an enum, not message text.

### 5.4 Safe failure classes and routing behavior

Persist only an enum such as:

```text
auth       401/403
rate_limit 429
server     5xx
http       other HTTP
proxy      configured proxy connection/auth/TLS failure
network    DNS/socket failure without configured proxy
timeout    local timeout/abort
json       invalid JSON
schema     invalid projected shape
```

On any failure:

- retain the last valid snapshot for diagnostics;
- immediately set current routing quota to unknown, even when last-good is younger than `staleAfter`; a successful complete snapshot also becomes unknown after `staleAfter`;
- do not change ban/cooldown or health;
- do not infer quota from local token totals;
- do not make chat fail.

For pool classification use the maximum `percentUsed` only when all three known windows are present in a successful, fresh snapshot. Missing/partial, failed, or stale data is unknown; UI may display last-good/partial data with that status. All snapshots unknown makes quota layering a complete no-op.

## 6. Management API, validation, UI, presets, and tests

### 6.1 API recommendation

Add authenticated `GET /api/statistics` (or `/api/stats`, choose one consistently) returning a strict projection:

```js
{
  generatedAt,
  window: { kind: 'last-1440-minutes', from, to },
  lifetime: { global, accounts: [...] },
  recent24h: { global, accounts: [...] },
  accounts: [{
    id, name, enabled, operationalState,
    lifetime, recent24h,
    health: { status, score, results, penaltyUnits, reason, coverageComplete },
    quota: { status, pool, fetchedAt, staleAt, limits, errorCategory }
  }]
}
```

Return derived ratios as number-or-null plus numerator/denominator/coverage. Return no raw bucket map unless needed by the UI. Join names from current `config.accounts`; persisted statistics remain ID-keyed.

`GET /api/accounts` should change account request lookup to stable ID and may retain a small compatibility summary, but the new statistics panel should use the dedicated endpoint. Never expose `META` wholesale.

`POST /api/accounts` must validate `accountPipeline` before mutating config and continue its current validate-all-then-save pattern. Invalid pipeline, rules, or account payload returns 400 and preserves previous file bytes. On success, reset selection counters only as currently done and clean dynamic state for deleted IDs.

### 6.2 Top-level statistics UI

Extend the current mutually exclusive native-button navigation with `navStatistics` and a dedicated `statisticsPanel` alongside `consolePanel` and shared `logPanel`. Update `switchSection()` so exactly one panel is visible and each button has correct `aria-pressed`. Use a statistics query generation counter (or the existing generation carefully) so stale fetches cannot render after navigation.

The panel should contain:

- range summaries for lifetime and last 24 hours;
- request count; input/output/total token sums with field coverage;
- cached tokens, cache-token share, and cache-hit request rate with explicit denominators;
- account rows keyed by ID with handled requests, tokens, errors, health score/status/result count, operational override, and quota snapshot/pool/freshness;
- “未知/无数据” for null values, never zero by fallback;
- a clear explanation that per-account handled-request sums can exceed global downstream requests after account replacement;
- no seven-day chart and no reset button.

Use `textContent` where possible and `escapeHtml()` for any server value in `innerHTML`. Keep `.table-wrap`, native controls, `aria-live` loading/error status, and keyboard operation. Statistics must not render account key, proxy, header values, note, raw session, raw traces, or raw quota/provider response.

### 6.3 Error presets

The current six `PRESETS` are broad scheduling presets and already merge rule fragments while also changing mode/capacity. R1’s five rule presets should be a **separate error-rule preset control**, not overloaded into those strategy presets:

```text
standard: 429 cooldown 30m
fast:     429 cooldown 5m; 500/502/503/504 cooldown 1m
safe:     429 cooldown 60m; 500/502/503/504 cooldown 5m
observe:  429/500/502/503/504 ignore
clear:    {} and replace-only
```

Keep definitions in one frontend constant because presets are UI shortcuts; server `validateAccountErrorRulesInput()` remains the authoritative boundary. Do not duplicate preset semantics in a special backend endpoint.

Preview must parse the **current textarea draft**, not `ACCS.accountErrorRules`, because the operator may have unsaved manual edits. Offer merge (default) and replace:

- merge: `{ ...currentDraft, ...presetRules }`;
- replace: exactly `presetRules`;
- clear preset disables merge and allows replace only.

Compute a status-code-sorted diff with four explicit groups:

- preserved: identical existing entries and custom entries untouched by merge;
- added: absent → preset value;
- modified: existing value → preset value;
- deleted: existing entry absent from replacement (none for merge).

Cancel mutates nothing. Confirm writes the resulting object back to the advanced JSON textarea and submits through the existing complete `saveAccounts()` path, preserving IDs, keys, proxy/header/note/enablement and `perModel`. Manual JSON remains fully editable before and after preset use. Server rejection must leave config unchanged and report the safe error.

The existing broad scheduling presets must also read the live textarea if they continue to merge rules; otherwise they can overwrite a manual unsaved rule draft. Its current `safe` preset must drop automatic 401/403 bans so every automatic preset's 4xx behavior is limited to 429; advanced JSON remains the only path for custom 401/403 actions.

### 6.4 Pipeline UI

Place four fixed-order checkboxes under account scheduling. Explain that order cannot be rearranged and that sticky mode implicitly supplies affinity. `collectAccounts()` must include the complete `accountPipeline` snapshot. Presets must not mutate it unless a preset explicitly previews that field; silent changes are forbidden.

Show concise selection semantics and fallback warnings:

- unhealthy filter removes only scored unhealthy accounts and can fall back only when it removed every mandatory candidate;
- insufficient data remains sampleable;
- stale quota is unknown and never blocks chat;
- reserve quota can still be used when higher pools cannot supply capacity, if adopting the starvation-avoidance recommendation above.

### 6.5 Test matrix

#### Usage and exactly-once integration

- non-streaming top-level and `{data: ...}` usage envelopes;
- snake-case OpenAI, input/output aliases, camel-case equivalents, Anthropic cache-read equivalent;
- explicit zero versus missing; malformed/negative/fraction/string fields ignored;
- conflicting aliases follow precedence without addition;
- partial usage coverage and null ratios;
- cache field missing excluded from both denominators; explicit zero included in hit-rate denominator;
- multiple SSE chunks with cumulative usage count only the last snapshot;
- fragmented SSE events, usage immediately before `[DONE]`, and a `streamHead` chunk containing multiple complete events/usage that is observed exactly once;
- stream flush/error/downstream-close race commits at most once;
- provider 500→200 on same account counts one request and only final usage;
- cooldown A→success B counts one global request, one segment for A and B, and usage only for B;
- second cooldown does not select C and does not duplicate observations;
- `/api/test`, probe, validation, and quota refresh do not change chat statistics;
- restart preserves lifetime and recent buckets.

#### Persistence/migration

- legacy unique name migrates requests to stable ID once across repeated restarts;
- renamed/unmatched and duplicate names are not arbitrarily assigned;
- no token/cache/24h data is fabricated from legacy requests;
- account rename with same ID retains stats; deletion prunes account/health/quota bucket data while global totals remain;
- key rotation invalidates quota but retains local statistics;
- 1,440-minute bucket boundary, 50,000 account-cell cap, incomplete coverage forcing health insufficient, and expiry restoring complete coverage;
- safe-integer overflow produces valid null/overflowFields state and never wraps;
- malformed existing JSON remains untouched and startup fails as required;
- serialized metadata contains no keys, messages, session values, proxy credentials, headers, or raw responses.

#### Health

- 500→200 same account yields one successful result, no retry penalty;
- 401/403, 429, network/proxy, 5xx, and other account errors use exact weights;
- ordinary 4xx is excluded from denominator and cannot improve/damage score;
- downstream disconnect and capacity failure do not punish an account;
- late genuine SSE error punishes once but is not replayed;
- fewer than 5 results is insufficient; thresholds at 50 and 80 are exact;
- 24-hour expiry naturally restores score;
- disabled/cooling/banned overrides score display and eligibility.

#### Pipeline compatibility and capacity

For each of six modes, capture a baseline with missing pipeline and all-false pipeline and assert identical account sequence, wait/429 behavior, selection reason, RR/weighted proportions, capacity overflow, and active counts.

With switches enabled, cover:

- mandatory exclusions never return through any fallback;
- insufficient + available first health tier; degraded later; unhealthy filtered only when requested;
- health-filter fallback highest score and stable tie behavior;
- all quota unknown exactly matches ordinary dispatch;
- hot/warm/unknown/reserve boundaries at 80 and 95 and maximum-of-windows;
- stale/error quota becomes unknown;
- full top tier uses deterministic lower-capacity fallback without starvation, then returns to top tier after release;
- pipeline affinity stable under account input reorder and minimal remapping after removal;
- sticky mode is not applied twice;
- provider retries retain one account authorization;
- cooldown/ban permits exactly one replacement and no replay after output starts;
- capacity notifications recompute candidates and every lease returns active count to zero.

#### Quota refresh

- exact endpoint/path and Bearer key are visible only to mock transport, never persisted/logged/returned;
- account HTTP/HTTPS/SOCKS proxy is used and proxy failure never falls back direct;
- concurrency never exceeds the production constant; timeout aborts; timers do not overlap same account;
- jitter/interval/backoff/stale transitions use an explicit `NODE_ENV=test` timing seam and local mock, never real waiting/Cline;
- 401/403, 429, 5xx, other HTTP, timeout, proxy, network, JSON, schema categories;
- unknown types ignored; duplicate/malformed known rows reject replacement; last good snapshot retained for diagnostics while routing immediately becomes unknown;
- refresh never delays a simultaneous chat request;
- per-account generation prevents deletion/key/proxy change from accepting stale in-flight results, and in-flight chat cannot recreate deleted account statistics.

#### API/UI contract and browser review

- authenticated stats API strict projection and sensitive-field absence;
- invalid/unknown pipeline fields and invalid error rules return 400 without changing config bytes;
- fourth top navigation button, mutually exclusive panels, stale-read invalidation, `aria-pressed`, `aria-live`, horizontal tables;
- null/coverage rendering does not show false zero/percent;
- error preset merge/replace/clear diff categorizes preserve/add/modify/delete exactly;
- preview uses live JSON draft; invalid JSON makes no request; cancel is no-op; confirm uses ordinary full save;
- advanced JSON remains present and arbitrary valid rules round-trip;
- full account snapshot still preserves `id`, `perModel`, note, proxy, headers, key, weight, priority;
- manual browser review for narrow width, keyboard/focus, readable diff, status announcements, and unknown/override states.

## 7. Consolidated risks and recommendation

### Highest-risk failure modes

1. **Duplicate usage:** updating inside provider/SSE loops instead of one request finalizer.
2. **False precision:** treating missing token/cache fields as zero or deriving total/cache from unrelated behavior.
3. **Health over-penalty:** counting every provider retry rather than one terminal result per account segment.
4. **Health score gaming:** counting request-parameter 4xx as zero-weight successful denominator entries.
5. **Candidate starvation:** selecting a static top quota/health tier and waiting while lower allowed tiers are idle.
6. **Legacy regression:** routing all-false pipeline through a new generic sorter and altering RR counters, config order, sticky wait/overflow, weighted proportions, or priority capacity fallback.
7. **Critical-path quota dependency:** fetching semi-documented quota while selecting an account.
8. **Unbounded state:** storing per-request 24-hour events or full SSE bodies.
9. **Identity corruption:** migrating name-keyed stats to the first duplicate-name account.
10. **Secret leakage:** persisting raw quota payload/errors, request headers, account keys, stream events, sessions, or messages.

### Recommended minimal architecture

- Keep current transport, lease, trace, stable IDs, atomic JSON, and UI save path.
- Add a request-scoped idempotent chat observation commit.
- Normalize only explicit upstream usage fields and persist coverage-aware aggregate counters.
- Store lifetime aggregates plus bounded minute buckets keyed by stable account ID.
- Derive one health result per request/account segment from its terminal outcome.
- Preserve the current selector as an exact all-switches-off fast path; build optional pipeline groups around the same lease primitives.
- Run quota refresh in a bounded, jittered background queue and route only from fresh projected snapshots.
- Add one authenticated statistics API and one top-level statistics panel.
- Add separate error-rule presets that preview the live advanced JSON and submit through existing `/api/accounts` validation.

This approach adds no dependency, does not move selection into provider retries, and keeps the irreversible trust/lease/stream boundaries intact.