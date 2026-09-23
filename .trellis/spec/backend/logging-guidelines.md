# Logging Guidelines

> Executable contracts for durable request/error diagnostics in the Cline Pass switcher.

---

## Scenario: Bounded JSONL request and error logs

### 1. Scope / Trigger

Use this contract when changing request finalization, provider/proxy error recording, log retention, log query APIs, or fields rendered by the console.

Ordinary request/error logs are diagnostic projections, not raw request dumps. A proxy response must not fail because diagnostic persistence fails, and these logs must never become a second storage location for credentials, prompts, sessions, proxy URLs, account notes, or upstream response bodies. The separately authenticated, opt-in detailed store below is the only approved body/header exception; it does not change this ordinary-log projection or metadata exclusions.

### 2. Signatures

```js
new JsonlLogGroup({ dir, streams, maxAgeMs, segmentBytes, maxTotalBytes })
group.stream(prefix)
stream.append(projectedRecord)
await stream.query({ limit, cursor, filters })
await stream.clear()
await group.maintain()
record(resolvedModel, diagnosticInfo)
safeReason(value, extraSecrets)
```

Files and APIs:

```text
DATA_DIR/logs/requests-*.jsonl
DATA_DIR/logs/errors-*.jsonl
GET    /api/logs/requests
GET    /api/logs/errors
DELETE /api/logs/requests
DELETE /api/logs/errors
```

All log APIs use the existing admin/proxy-key authentication boundary. Query `limit` is 1-200 and pagination uses the opaque `nextCursor` returned by the previous page.

### 3. Contracts

#### Storage and retention

- Request and error records are separate JSONL streams under one directory-level `JsonlLogGroup`. The production limits are 50,000 request records, 10,000 error records, 30 days, 5 MiB per segment, and 100 MiB combined.
- Construction creates the protected directory and starts asynchronous recovery but never reads, parses, stats, or rewrites the historical corpus before `server.listen()`. Model traffic and new-generation appends remain available during recovery. Ordinary log query/clear returns a safe `503 ordinary logs initializing` until one complete catalog is published; it never exposes a partial historical view. Recovery failure keeps model traffic fail-open and the log API safely unavailable.
- The group owns one bounded in-memory segment catalog and the combined budget. It stores segment names, stream, bytes, record count and timestamp bounds, never request bodies or a second corpus-sized record index. The catalog is capped at 10,000 segments / 16 MiB projected metadata, and one recovery pass is capped at 120,000 parsed records / 128 MiB input. Crossing a fence preserves disk data, drops further diagnostic admission as needed and keeps the log API safely unavailable instead of growing without bound.
- Appends use serialized asynchronous writes to one tracked active segment per stream. After recovery, an append performs no historical directory enumeration, stat, read or full rewrite. Segment size/count/timestamp facts update only after a successful write; rolling closes the active handle and creates a new segment. One serialized record is capped at 64 KiB, and the shared queue admits at most 10,000 pending records / 16 MiB. Admission reserves both counters before queueing and releases them on success or failure; excess diagnostics are dropped fail-open with bounded health facts.
- Age, per-stream record and combined-byte maintenance uses the catalog. It deletes fully obsolete immutable segments and reads/atomically rewrites only a boundary segment when a threshold falls inside it. Replacement segments are written with mode `0600` and renamed before superseded segments are deleted. Maintenance is threshold/roll/minute driven, never a fixed every-100-record corpus compaction or per-request directory scan.
- Combined-size enforcement orders both streams globally by `ts` and removes the oldest records first. It must not apply two independent 100 MiB limits.
- Recovery reads each historical segment once, tolerates a truncated final line and malformed complete lines, enforces retention, and deduplicates record identity (`requestId` for requests and `(requestId, attemptIndex)` for errors). Interrupted old/new replacement overlap therefore does not duplicate diagnostics.
- Queries are asynchronous and scan catalogued segments newest first, stopping after `limit + 1` matches. Rare filters may inspect the complete bounded corpus but yield to the event loop periodically; ordinary first-page reads do not eagerly parse every segment or retain every record in memory.
- `metadata.history` is compatibility-only. New chat requests write JSONL and update model/account aggregates, but do not grow the legacy history array.
- A log append or background-maintenance error may produce a redacted service-level `console.error`; it does not change the client response.

#### Request projection

A request record may contain only:

```js
{
  ts, requestId, requestedModel, resolvedModel, stream,
  strategy, sessionSource,
  affinityKeyType, affinityConfidence,
  upstreamPromptCacheKeySource, upstreamPromptCacheKeyApplied,
  providerOrderOverridesSticky, cacheHit,
  preferredAccountId, preferredAccountName,
  accountId, accountName, selectionReason, overflow, switched,
  pipelineSteps, selectedQuotaPool, selectedHealthLayer, capacityFallback,
  cachePoolSize, cachePoolMaxSize, cachePoolLowQuotaSize, cachePoolTargetSize,
  cachePoolActual, selectedQuotaRole, cachePoolTier, cachePoolFallback,
  bindingSource, bindingResult,
  providerPlanSource, providerMode,
  targetProviders, actualProvider, attempts,
  status, result, upstreamStatus, durationMs,
  accountActions, appliedHeaderNames, errorCategory
}
```

`result` is exactly `success`, `client_cancelled`, or `failed`. `status` remains the final request status; client cancellation is `499`, has `errorCategory: null`, and suppresses all error-log attempt projection even when abort plumbing produced an internal transport trace. Older JSONL rows without `result` remain readable and are never migrated. A downstream `: PING\n\n` SSE comment is not a second request, upstream Provider attempt, RPM commit, usage sample, error, health event or ordinary log row. The upstream-only SSE observer counts actual upstream data/DONE/usage; the stream-local writer injects heartbeat downstream only after an accepted data event and safe event boundary. This preserves one terminal request record and real-attempt-only error rows even over many pings.

`attempts` is a projection of provider/status/timing/account/action facts. Canonical rule diagnostics are limited to validated `ruleId`, `ruleScope`, `ruleAction`, and `matchedBy` condition-kind enums; they never contain needles, Header values, matched body text, or response bodies. Optional circuit/classification/media/byte facts remain bounded. These fields describe switcher-visible HTTP attempts; target lists and gateway-internal behavior are never promoted into an actual provider path.

Strategy evidence is a bounded server projection, not a delivery promise. `providerPlanSource` is exactly `configured`, `discovered`, or `auto`; `providerMode` is exactly `strict` or `preferred`; and `attempts[].providerSelection` (also present on error rows) is exactly `strict-first`, `health`, or `compat-auto`. `compat-auto` belongs only to an unattributed `auto` attempt from a completely empty candidate source. A capacity rejection before any lease or provider plan reports `null` for both fields with no attempt selections; a routing rejection raised from `runChatChain()` still reports its `configured`/`discovered`/`auto` source and mode with an empty `attempts` array. These enums are the only provider-order evidence: the candidate rate map and success-rate numbers are never projected, `targetProviders` remains a bounded plan (provider slugs from the source order), and the static configuration list never claims to be the real runtime order.

Retry evidence uses the same bounded allowlist on request rows and error rows: `retryRuleId` is a validated `ERROR_RULE_ID` or null, `retryDecision` is exactly `stop` or `continue` (default `continue`), and `retryMatchedBy` is at most `status`, `body`. Retry needles, matched body fragments, raw rule conditions, and provider success-rate values are never persisted; an older row without these fields is read as unknown and is never migrated.

Affinity fields are bounded server enums/booleans only: `affinityKeyType` names the winning kind, `affinityConfidence` is `explicit`/`fallback`/`none`, `upstreamPromptCacheKeySource` is caller/derived/none/invalid, and `upstreamPromptCacheKeyApplied` means a valid field was sent, not that a remote router used it. `cacheHit` is true only for explicit cached tokens above zero, false only for explicit zero, and null when unknown. Pipeline fields are server-owned bounded values: `pipelineSteps` contains at most eight `quota-all-unknown` facts; `selectedQuotaPool` is `ordinary`, `hot`, `warm`, `unknown`, or `reserve`; `selectedHealthLayer` is `rated` or `unknown` when the success-rate step or cache-pool projection owns a health grouping, otherwise null; `capacityFallback` is boolean; `cachePoolSize` is the configured minimum and `cachePoolMaxSize` the configured maximum (both bounded integers), `cachePoolTargetSize` is the current effective grow-only target, `cachePoolTier` is `active` or null, and `cachePoolFallback` is a boolean that is now always `false`. The standby tier and `cache-pool-standby-overflow` reason no longer exist; a saturated miss returns `capacity-unavailable` or grows one member, and a saturated *bound* session temporarily overflows within the active set. `cachePoolLowQuotaSize` is a bounded integer 0-100000; `cachePoolActual` is either null (no pool lease/admission, including pre-admission capacity failure) or `{ high, low, unknown }` bounded nonnegative counts from the selected pool membership, never a fabricated zero composition. `selectedQuotaRole` is `low`/`high`/`unknown` only for role-aware selected leases and null with low=0/no lease. Role fallback is represented by the existing bounded `capacityFallback`/selection reason and may be a temporary high overflow, not a persisted role or candidate list. An attempt/error row's independent `quotaRemovalAction` is only `waiting-refresh` or null and does not override canonical `accountAction`. API quota disposition (`waiting-refresh`/`quota-exhausted`) and safe future `quotaRetryAt` are management projections, not raw quota snapshots in ordinary rows. `bindingSource` is exactly `explicit`, `fallback`, or `none`; `bindingResult` is exactly `hit`, `miss`, `invalidated`, `temporary-overflow`, `provisional`, or `not-applicable`. Selection reasons may additionally be `cache-pool-active`, `cache-pool-active-overflow`, `pipeline-sticky-primary`, or `pipeline-capacity-fallback`. `errorCategory` distinguishes bounded request outcomes such as `capacity`, `routing`, `proxy`, and `upstream`; in particular a local capacity 429 has no upstream attempt and must never be labelled as an upstream 429. Raw candidate lists, health buckets, quota payloads, percentages, identities, bindings, fingerprints, credentials, proxy data, and messages remain forbidden.

An error record may contain only:

```js
{
  ts, requestId, requestedModel, resolvedModel,
  accountId, accountName, attemptIndex,
  targetProvider, providerPath,
  status, upstreamStatus, category, reason, reasonTruncated, accountAction,
  ruleId, ruleScope, ruleAction, matchedBy,
  retryRuleId, retryDecision, retryMatchedBy,
  errorScope, scopeEvidence, failureClass, healthAction, quotaRemovalAction,
  retryAfterMs, responseContentType, responseBytes,
  detailProfile?, detailCallId?
}
```

Each real failed provider/proxy attempt gets one error record. `reason` is redacted first and then truncated at a valid UTF-8 boundary to 16 KiB; `reasonTruncated` states whether bytes were omitted. When a full or error-only detail collector actually admitted the corresponding native call, the row also carries validated `detailProfile: "full" | "error"` and UUID-v4 `detailCallId`; legacy, disabled and capture-overflow rows omit both fields. A request and all its error attempts share the same internal UUID, which is also returned as `X-Cline-Request-Id`. The request-local native transport owner assigns monotonically increasing `attemptIndex` plus `callId` only after `req.end()` hands a real request to Node, and the same pair flows through trace, detail manifest and ordinary error row across provider retry and account replacement. `X-Cline-Target-Upstream` is a plan, `X-Cline-Attempts` is the real HTTP-attempt count, and `X-Cline-Actual-Upstream` is only a parsed terminal provider; the JSONL attempt rows are authoritative for the full account/provider path.

#### Sensitive-data boundary

Before persistence, redaction covers configured account keys, proxy/admin keys, proxy URL/user/password components, every configured custom Header value, and request message text. Bearer-looking values are redacted generically. Reasons are flattened and credential-redacted, but the ordinary projection retains at most 16 KiB. Complete bounded sanitized response diagnostics belong to the opt-in detailed owner. This does not permit persisting a raw response body: non-JSON/invalid error responses use a generic diagnostic instead.

Never persist:

- account Key, proxy URL or proxy authentication;
- any Header value, Authorization, Cookie, or request body;
- account note;
- raw session/thread/conversation value or HMAC fingerprint;
- message text, reasoning/content, or upstream response body;
- a retry-rule needle, matched body fragment, raw retry condition, candidate rate map, or provider success-rate value;
- raw quota response, percent-used/remaining values, reset payload, member/candidate ID lists or per-session quota state. Selected/preferred account IDs in the bounded request record remain allowed.

Only bounded identity-source/type/confidence enums, upstream-key source/applied booleans, cache-hit tri-state, bounded cache-pool min/max/low/target integers, actual role counts and selected-role/tier enums, `bindingSource`/`bindingResult` enums, fixed binding hit/miss/invalidated/overflow/provisional counters, provider circuit actions, `providerPlanSource`/`providerMode`/`providerSelection` enums, retry `retryRuleId`/`retryDecision`/`retryMatchedBy` fields, and applied safe Header names may be recorded. The actual caller/derived key and every raw/HMAC identity remain forbidden, including truncated/hash-prefix correlation tags. The session-binding map itself is never projected: no fingerprint, bound account ID map, entry list, expiry or `ownerRequestId` may appear in a request/error row, a management response body, or a service log line.

#### Query and cursor

Filters are endpoint-specific allowlists. Shared aliases `model`, `account`, and `provider` search the documented projected fields. Request logs additionally allow `result`; historical rows without the field simply do not match a non-empty result filter. Numeric and boolean filters are parsed strictly; unknown parameters return `400` instead of being ignored.

The cursor encodes `ts`, `requestId`, `attemptIndex`, segment name, and line number. Segment/line disambiguation is required because one request may have multiple error attempts with equal timestamps.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Ordinary log recovery is still running or failed | `503` with a bounded safe message; model traffic and new diagnostic appends remain fail-open |
| Unknown query parameter | `400`; do not scan logs |
| `limit` outside 1-200 or non-integer | `400` |
| `from`, `to`, `status`, or `upstreamStatus` is not a finite integer | `400` |
| Boolean filter is not exactly `true` or `false` | `400` |
| Cursor is malformed at the HTTP boundary | `400` |
| Cursor is structurally valid but stale after retention | safely restart from the newest matching records; never crash |
| One complete JSONL line is malformed | skip the line and continue |
| Last line is truncated | ignore it until compaction |
| Append/compact filesystem error | redacted service error; proxy response path remains usable |
| Clear requests | delete request segments only |
| Clear errors | delete error segments only |
| Candidate reason contains a known Key/Header value/message | persisted form contains `[REDACTED]`, never the source value |
| Upstream returns a long structured error | persist a valid UTF-8 reason of at most 16 KiB with `reasonTruncated=true`; when error detail capture is enabled, retain the bounded sanitized response there |
| Upstream returns a non-JSON/invalid error body | persist a generic diagnostic plus normalized media type/byte count, never the raw response body |
| Switcher local capacity 429 | request row has `errorCategory=capacity`, `upstreamStatus=null`, safe `selectionReason`, and no attempts |
| A saturated bound session overflows to another active account | request row records `bindingResult=temporary-overflow`, `overflow=true`, and still names the bound account as `preferredAccountId`; the binding itself is unchanged |
| A cache-pool request is projected | persist bounded `cachePoolSize`/`cachePoolMaxSize`/`cachePoolLowQuotaSize`/`cachePoolTargetSize` integers, actual high/low/unknown counts only after a lease, `selectedQuotaRole` only for a positive low target, `cachePoolTier=active` (or null) and `cachePoolFallback=false`; never a member list or binding entry |
| Capacity is rejected before any pool lease | `cachePoolActual=null` and `selectedQuotaRole=null`, never an invented `{ high: 0, low: 0, unknown: 0 }`; retain safe `blockedBy`/`retryAfter` |
| Low-role account/degrade removes an account | real attempt/error row may contain `quotaRemovalAction: 'waiting-refresh'`; no raw percentage/reset/reason text from quota response |
| Ambiguous HTML 429 without a matching rule | persist `errorScope=unknown`, bounded evidence and default ignore, with no account action/body or implicit cooldown |
| Pipeline diagnostics contain a non-owned/raw value | omit it; persist only the bounded enum/boolean projection |
| `providerPlanSource`/`providerMode`/`providerSelection`/`retryDecision` is not a documented enum | omit the field (`null`/`continue`) instead of persisting the raw value |
| A retry needle, matched body fragment, raw rule condition, candidate rate map, or success-rate number would be projected | never persist it; keep only validated `retryRuleId` plus `retryMatchedBy` condition kinds |
| A historical JSONL row lacks strategy/retry fields | read them as unknown; never migrate, backfill, or infer them from adjacent rows |
| An accepted SSE stream emits repeated downstream comments during upstream silence | no new ordinary request/error rows, attempt indices, RPM commits, usage or health samples; terminal completion still writes its one request row |
| `res.write()` returns `false` while sending data or a heartbeat | wait for `drain`; do not log `499`/error or release the lease for backpressure alone |
| Diagnostic JSONL or metadata persistence fails | report only a redacted service error; do not change the chat response |

### 5. Good / Base / Bad Cases

- **Good:** a request returns `X-Cline-Request-Id`; filtering errors by that ID returns each failed attempt once and the request page shows the final account/provider path.
- **Good:** two stores exceed the combined limit; global cleanup keeps the newest records regardless of type.
- **Good:** a capacity fallback records its bounded pipeline groups/reason without recording quota percentages or health buckets.
- **Good:** an SSE stream survives a quiet segment by sending comments without adding attempts or usage; a later upstream idle failure updates the real attempt only once despite the pings.
- **Base:** a successful request creates one `200 / success` request record and no error record.
- **Base:** a client cancellation creates one `499 / client_cancelled` request record and no error record.
- **Base:** a capacity rejection has no account but still records strategy, status, request ID, and safe reason category; pre-admission `cachePoolActual` is null, not zero.
- **Bad:** `JSON.stringify(req)`, `JSON.stringify(account)`, or persisting a raw upstream error object. These cross the trust boundary.
- **Bad:** log a quota window percentage, reset payload or active member list, or fill absent composition with zeros before admission.
- **Bad:** unlinking old segments before replacement segments are durable; a rename failure would lose diagnostics.
- **Bad:** synchronously compacting the corpus before listening, enumerating/statting files per append, or running combined retention after every request.
- **Bad:** returning a partial historical list while background recovery is incomplete.
- **Bad:** paginating errors by request ID alone; multiple attempts for one request will repeat or disappear.

### 6. Tests Required

`test/jsonl-log-store.test.js` must cover asynchronous startup truthfulness, recovery-time appends, zero historical filesystem calls on ready-state append/below-threshold maintenance, rolling, restart replay, filtering, cursor pagination, expiry, independent clear, malformed/truncated lines, recovery dedupe, segment size, boundary-only retention and combined global byte enforcement with small injectable limits. A same-machine synthetic benchmark records startup/query/maintenance/heap/event-loop facts and must improve the frozen 5,000-record append baseline by at least 10×; absolute timing is not a cross-machine CI assertion.

`test/integration.test.js` must assert:

- request response ID equals the logged request ID;
- a combined sticky+healthSort session logs `bindingSource` `explicit`/`fallback` and `bindingResult` `miss` then `hit`, a saturated bound session logs `temporary-overflow` with `overflow=true`, sticky-only/healthSort-only logs `not-applicable`, and no raw session, fingerprint, binding account map or entry list appears in any JSONL row, API payload or metadata file;
- cache-pool rows carry bounded `cachePoolSize`/`cachePoolMaxSize`/`cachePoolTargetSize`, `cachePoolTier` is never `standby`, and `cachePoolFallback` is always `false`; `test/low-quota-pool.test.js` (`pre-admission capacity rows do not fabricate zero pool composition`, `low account degradation holds and replaces before output; failed refresh retains hold, successful refresh restores`) checks the null-versus-actual counts, bounded role/removal action and absence of raw quota/member details;
- caller/derived/message-fallback affinity produces the exact bounded source/type/confidence/applied facts, final explicit usage produces true/false/null cache hit, and no raw caller key, derived key, session or fingerprint occurs in JSONL/API/UI;
- requested/resolved models, strategy, selection reason, overflow and account path are present where applicable;
- one request with multiple failures paginates every error exactly once;
- unknown/invalid filters return `400`;
- account keys, proxy credentials, custom Header values, account notes, raw sessions, messages, Authorization/Cookie, and upstream sensitive bodies do not occur in serialized log API results or files;
- long structured SSE/JSON errors are credential-redacted, UTF-8 bounded with truthful truncation in ordinary rows, and retain bounded complete detail bodies when the relevant profile is enabled; short message redaction does not corrupt unrelated words containing the same substring;
- SSE, account replacement, proxy failure, capacity failure, and normal JSON responses finalize no more than one request record; an accepted quiet stream generates downstream ping bytes without changing attempt count (one per `req.end()`), RPM used, explicit usage count or ordinary row count; New API-equivalent scanner ignores comment lines as model events;
- an actual `write(false)` followed by drain/DONE produces one `200 / success` row, not a fake `499` or error attempt; post-start upstream timeout, DONE-close, early cancellation and shutdown each preserve the terminal idempotent projection;
- a downstream close after observed `[DONE]` records one `200 / success`, while pre-DONE streaming and non-streaming cancellations each record one `499 / client_cancelled`, no error attempt, and no error/usage/health effect;
- request `result` filtering returns only explicit new records, while historical rows without `result` remain readable and unmodified;
- pipeline diagnostics, provider circuit actions, and provider health actions accept only the documented enum/boolean projection and contain no quota percentages, raw health data, or secrets;
- scoped-rule rows expose only bounded ID/scope/action/condition kinds; unknown/provider/account defaults expose correct attribution while needles, Header values, raw bodies and request content remain absent;
- strategy evidence persists only the bounded `providerPlanSource`/`providerMode`/`providerSelection` enums (with `compat-auto` limited to a truly empty `auto` source), and retry evidence persists only `retryRuleId`/`retryDecision`/`retryMatchedBy`; a candidate rate map, needle, matched fragment, or provider success-rate value never appears in a JSONL row, API payload, or metadata file;
- simulated log/metadata write failures do not alter the already-determined chat status or body.

Run `node --check lib/jsonl-log-store.js`, `node --test test/jsonl-log-store.test.js`, `npm test`, and `git diff --check` after changes.

### 7. Wrong vs Correct

#### Wrong

```js
await requestLogs.append({ request: req, account, upstreamResponse });
```

#### Correct

```js
await requestLogs.append({
  ts: Date.now(),
  requestId,
  requestedModel,
  resolvedModel,
  accountId: account?.id || null,
  status: normalizedStatus,
  pipelineSteps: safePipelineSteps.slice(0, 8),
  selectedQuotaPool: safeQuotaPool,
  selectedHealthLayer: safeHealthLayer,
  capacityFallback: Boolean(capacityFallback),
  cachePoolSize: boundedCachePoolSize,
  cachePoolLowQuotaSize: boundedLowSize,
  cachePoolActual: safeActualComposition ?? null, // null before pool admission; each count validated
  selectedQuotaRole: safeSelectedRole,
  cachePoolTier: safeCachePoolTier,
  cachePoolFallback: Boolean(cachePoolFallback),
  appliedHeaderNames: Object.keys(account?.headers || {})
});
```

Build a strict projection first; redaction is defense in depth, not permission to serialize arbitrary objects.

---

## Scenario: Opt-in detailed model traffic capture

### 1. Scope / Trigger

Apply when changing `lib/detailed-log-capture.js`, `lib/detailed-log-store.js`, detailed API routes or their transport hooks. Only this default-off store may retain ordinary headers, sessions and prompt/response content after credential sanitization. Never copy its bodies into ordinary JSONL, metadata, service errors or diagnostic headers.

### 2. Signatures

```js
new DetailRoot(req, res, store, secrets, { profile: "full" | "error", requestId? })
detailContext.run(root, dispatch) // native AsyncLocalStorage
root.attempt({ token, headers, body, account, proxyUrl, method, url, model, provider })
root.settleAttempt(attempt, { failed, httpStatus, outcomeStatus, responseHeaders, responseBody, responseComplete, captureState })
root.finalize()
new BodyCapture({ budget, limit }) // production 5 MiB per body
new DetailRedactor(secrets)
observeStream(source, capture)
new DetailedLogStore({ dir, maxAgeMs, maxTotalBytes, now, io })
store.recordDrop(reason) // DETAIL_DROP_REASONS only; unrecognized internal reason -> other
store.query(parseDetailQuery(url.searchParams))
store.detail(requestId)
store.body(requestId, bodyId)
store.clear()
```

```text
GET  /api/logs/settings
  -> { detailedLogging, errorDetailLogging, authRequired, maxBodyBytes, maxAgeMs, maxTotalBytes, health: { failures, dropped, corrupt, lastFailure, dropReasons } }
POST /api/logs/settings
  <- a non-empty exact subset of { detailedLogging: boolean, errorDetailLogging: boolean }
  -> { ok: true, detailedLogging, errorDetailLogging }
GET  /api/logs/details?limit=&cursor=&requestId=&from=&to=&model=&account=&status=&result=
  -> { items: <metadata-only roots>, nextCursor, health: <same aggregate health projection as settings> }
GET  /api/logs/details/<requestId>
  -> { request, attempts, bodies: <descriptors> }
GET  /api/logs/details/<requestId>/bodies/<bodyId>
  -> sanitized UTF-8 text/plain
DELETE /api/logs/details
  -> { ok: true }
```

### 3. Contracts

#### Capture scope and lifecycle

- Included roots: POST three chat aliases, `/api/test`, `/api/probe`, `/api/validate-upstreams`, `/api/accounts/test`, `/api/accounts/proxy-test`, existing `/v1/responses` rejection; GET `/models`, `/v1/models`, `/api/v1/models`.
- Rejections on these routes are included without additional body consumption. GET bodies with nonzero Content-Length or Transfer-Encoding remain `unread` when the route never reads them; unframed/zero-length GET input is complete empty. Authentication and Responses 501 remain immediate.
- Every actual native POST to configured `/chat/completions` has its own UUID call ID, including setup/network failures, provider retries, account replacement, harvest and concurrent validation. For ordinary chat, the capture-independent request-local transport owner also assigns the stable monotonic attempt index after `req.end()`; `DetailRoot` consumes that token rather than owning chat ordering. Only an included GET root's actual model-list cache-miss fetch is captured. Do not instrument enrichment, public discovery, quota, arbitrary fetches or hidden gateway retries.
- Capture profiles are snapshotted at request start. `full` keeps the existing included-route request/attempt/downstream capture. `error` applies only to chat aliases and does not open an identity manifest, wrap the downstream response, copy ingress/outbound request bodies, or retain successful response/SSE bytes. It publishes at most one group containing all real failed attempts, including failures followed by eventual success. If both switches are true, `full` wins and no duplicate group/body is created.
- Error-only non-stream attempts reuse the response text already consumed by the model path. Recognized SSE failures retain only the complete triggering event; a failure before response Headers is `no-response`, while a break after stream start retains sanitized Headers and `stream-transport-failed` without copying earlier successful chunks. Error-only request material is used only as bounded credential-discovery input after failure and is never projected as a body.
- The root UUID is reused for ordinary chat request IDs. Original ingress, rewritten upstream and final downstream bodies remain separate. Attempt fields include actual account, model/provider target, public Node-visible headers, HTTP status and transport completeness; they are not inferred from trace length.
- Capture is bounded observation only: one backpressured upstream Transform before SSE-head consumption, input observation inside the existing reader, and overload-preserving response write/writeHead/end wrappers. Diagnostic truncation never truncates forwarding. Response bytes mean submitted bytes, not proven peer receipt. The `full` downstream wrapper can observe *actual submitted* Switcher-generated `: PING\n\n` bytes when enabled; the upstream response capture observes only upstream bytes. Error-only does not wrap downstream. Neither profile permits copying pings into ordinary JSONL or treating them as a native attempt/usage event.
- Request-start mode and clear generation are snapshots. Root finalization is idempotent and asynchronous publication is never awaited by model completion. `status` is the submitted HTTP status or null before headers; `result`, when present, comes from the existing chat finalizer, including DONE-close success and early client cancellation. Manifest attempts expose validated, unique `(attemptIndex, callId)` identities plus HTTP/outcome status and capture state. Existing leases, retry policy and statistics remain authoritative.

#### Sanitization and resource limits

- Each body copies at most 5 × 1024 × 1024 bytes, including streaming and every attempt. Also cap encoded sanitized output at a valid UTF-8 boundary. Descriptors are `{ bodyId, observedBytes, capturedBytes, truncated, complete, state, omittedTailBytes, redacted }`; `complete` describes observed transport completion, not absence of truncation/omission. States are `complete`, `truncated`, `interrupted`, `unread`, `omitted-for-safety` and `resource-limited`.
- Snapshot configured keys/proxy credentials and learn ephemeral test/actual request credentials. Recognize credential header/JSON names (Authorization, Cookie/Set-Cookie, API/admin/access keys, password/passwd, tokens, secrets), Basic/Bearer forms, credential-bearing URL userinfo/query values and known-value echoes. Keep ordinary model token limits/usage counters, headers and message text.
- **Learn before projecting:** scan all request/attempt/downstream header maps and bodies for recognized credentials before materializing any body or metadata. Discover original URL/Bearer/assignment syntax before known-value replacement: a known `https`, `Bearer` or `api_key` must not destroy the parser's discovery input. Ordinary Referer/Location/custom headers may contain credential URLs or prose assignments; their credentials must scrub earlier header/body echoes regardless of field order. Generic Basic/Bearer values also join the group secret snapshot. Recognized credential headers run the same bounded original-token discovery on the scheme-stripped credential, learning URL and assignment components as well as the whole value. For example, `X-Credential: Bearer api_key=secret` must teach the bare `secret`; storing only the wrapped and `api_key=secret` forms leaves cross-body echoes exposed. Suppress recursive wrapped discovery for the outer scheme, then resume at the inner credential start under the existing match/work limits.
- Structured credential leaves reuse header component discovery: learn Bearer tokens, Basic encoded values/decoded username/password components, and individual Cookie values, including nested leaves and normalized field-name variants. Valid RFC 6265 quoted Cookie/Set-Cookie values contribute both raw quoted and dequoted secrets, so bare echoes are scrubbed. Set-Cookie attributes such as Path, Domain, Max-Age and SameSite are not secrets by themselves; ordinary prompt text and token counters must remain intact.
- Treat URLs as whole tokens before interpreting prose assignments. Learn every credential query occurrence from a snapshot of `URLSearchParams` before `.set()` collapses duplicate keys. Repeated `api_key` values and adjacent credential parameters must scrub earlier/cross-body echoes; ordinary URL query parameters remain inspectable.
- Valid JSON is parsed and sanitized; complete SSE events retain order and DONE; safe prose uses conservative textual sanitization. Partial JSON may be reconstructed as a labelled diagnostic prefix; partial SSE keeps complete events only. Remove known-secret suffix fragments at a capture boundary. Invalid encoding, ambiguous malformed/escaped text, or exceeded sanitizer work limits are omitted explicitly, never dumped raw to temporary disk.
- Inspect partial JSON credential scopes and unfinished SSE tails before projection. Failed discovery, partial literal `\\uNNNN` / `\\xNN`, and nested literal-escape layers fence the whole group as `omitted-for-safety`; never publish a reconstructable credential suffix.
- Complete JSON/SSE strings and ordinary headers may contain one literal escape layer in source code. After original-token discovery, scan one bounded decoded view. Preserve ordinary text; credential names/values and URL keys learn raw/decoded forms to scrub cross-body echoes. If only the decoded view reveals a credential, replace that string with `[OMITTED: ambiguous escaped credential]`, not unrelated bodies/Headers. Never use `eval` or weaken partial/truncated/invalid-input omission.
- `text()` iterates original URL/Bearer/assignment tokens, merging overlapping redaction spans and assembling output once. An outer Bearer/Basic match keeps its output span but resumes discovery at the inner credential start. Inner URLs keep their full grammar; an outer delimiter cannot turn a full credential into a known prefix. Reuse the 5 MiB input/output and 16,384-match bounds, including inner/assignment tokens. Bound cumulative assignment-value lengths to 5 MiB before learning each value. The one decoded view costs at most one additional input transformation/scan; nested escapes fail closed. Do not build match arrays or reconstruct the whole string per match. `known()` retains its separate pass budget.
- Retained raw/encoded payload reservations are bounded at 64 MiB through serialized publication; this is not an exact RSS bound. Activity/queue/attempt and sanitizer work limits drop diagnostics with safe health counters, not traffic. `known()` uses a cached, escaped literal matcher over original input only, invalidated when a new secret is learned. Match whole `[REDACTED]` markers to preserve them on subsequent passes; generated output is never fed back into that replacement pass. Small short-secret inputs remain readable with single markers. Bound input/output to 5 × 1024 × 1024 UTF-16 code units and each pass to 16,384 matches, checking projected output/match count before retaining slices and the tail before joining. Exceeding either bound triggers `resource-limited` group omission, separately from the final encoded 5 MiB body cap. Do not build an unbounded split/replace match array or rely only on post-allocation truncation. Unknown secrets outside recognized locations/current-root knowledge cannot be universally detected.

#### Store, retention and APIs

- `DATA_DIR/detailed-logs/` uses 0700 directories, 0600 sanitized body/manifest files and UUID-v4 generated identities. Publication writes sanitized temporary files and atomically renames the manifest last. Body files are immutable and never loaded into the metadata inventory; direct body reads remain on demand.
- Startup performs one full reconciliation of bounded manifests and file sizes, never body content, and atomically publishes an in-memory inventory only after that pass completes. The inventory contains approved listing summaries, root byte counts and unknown/corrupt accounting; it is rebuilt from disk after restart and is not persisted as a second source of truth. Normal publication, listing and minute-level age maintenance update/use this inventory without walking the corpus. A low-frequency full reconciliation runs at most hourly and detects process-external file changes; direct detail/body reads still validate their paths immediately. The inventory itself is fixed at 100,000 entries and 64 MiB of projected summary/accounting bytes. Exceeding either limit preserves every disk root, refuses new detailed publications and returns safe storage-unavailable responses until explicit clear or a later reconciliation fits again; this safety fence is not a record-count retention/eviction rule.
- Seven days and 1 GiB are independent fixed limits, not operator knobs. Temporary/metadata/body bytes count toward admission. Indexed admission evicts oldest timestamp/UUID root groups together; no additional record-count retention rule. Late pre-clear, expired or evicted roots cannot recreate groups; a clear generation advances before queued deletion and allows new-generation requests afterward. Unknown/corrupt indexed storage blocks an otherwise unprovable over-budget admission instead of being deleted.
- Startup/full reconciliation, tracked-failure maintenance and clear remove abandoned store-owned `.tmp-<UUID-v4>` publication directories only when their entries are regular `manifest.json` or `<UUID-v4>.txt` files. No active publication owns a temporary group at these serial boundaries. A failed runtime publication tracks its exact temporary name so normal query/publication retries only that path, not the corpus. Preserve unknown entries and symlinks rather than following or deleting them; unsafe temporary contents increment corrupt health and are accounted conservatively. Failed deletion rejects clear/query with a safe 503 and cannot claim clear success; clear still advances its generation. Startup marks persisted `open` identity as `interrupted`, and cleans unreferenced temporary/body files. Open identity publication does not persist partial raw bodies. Pre-publication process exit can lose identity; atomic rename is not an fsync/power-loss guarantee. Corrupt/unreadable groups are preserved and excluded rather than repaired into apparent success.
- All APIs use existing admin authentication, including its deliberately unprotected empty-key mode; UI must warn about that mode. Settings/detail responses use `Cache-Control: no-store`; bodies additionally use `X-Content-Type-Options: nosniff`. IDs must be validated and body IDs must belong to the selected manifest; reject traversal/symlink paths. Read-versus-clear/eviction is a safe missing response.
- List filters are allowlisted, nonduplicated and bounded. `limit` is 1–200; times are nonnegative safe integers with from ≤ to; status is 100–599; IDs are UUID-v4. Cursor is canonical base64url `{ ts, requestId }`, never a path; an explicitly empty `cursor=` is invalid, unlike an absent cursor. It continues below that ordering position even if the previous row was evicted. Listings contain no headers or body text.
- Store health exposes safe aggregate counters (`failures`, `dropped`, `corrupt`, `lastFailure`, `dropReasons`); settings additionally expose capture drops/retained payload bytes. `DetailedLogStore.recordDrop(reason)` is the **only owner** for detailed `health.dropped`: every former increment is exactly one omission/rejection event in one fixed primary bucket, with `sum(Object.values(dropReasons)) === dropped` at every point. Both total and breakdown start at zero on process start, are not persisted or backfilled from older manifests, and freeze together when `dropped` reaches `Number.MAX_SAFE_INTEGER`; ordinary success and health reads do not count. `failure()` and `corrupt` are independent, not alternative drop reasons. Persistence failure can prevent a record itself from being written, so health is authoritative for that loss, but a drop is neither necessarily a failed model request nor necessarily an absent detail manifest.
- The complete fixed `DETAIL_DROP_REASONS` key set (all nonnegative safe integers, including zero buckets) in declaration order is:

  | Key | Single primary cause |
  |---|---|
  | `activeLimit` | At least 128 active `DetailRoot` captures before dispatch |
  | `attemptLimit` | More than 256 attempts in one root |
  | `attemptCaptureFailure` | Root attempt-capture setup throws after the real native attempt starts |
  | `captureBudget` | Shared 64 MiB retained raw or expanded sanitized/encoded payload reservation fails |
  | `redactionSecretLimit` | More than 256 distinct secrets or 64 KiB of secret bytes |
  | `redactionWorkLimit` | Bounded discovery depth/visited nodes/token or replacement match/assignment work |
  | `redactionOutputLimit` | 5 MiB input/projected text or output-work bound |
  | `redactionOther` | Another redactor resource failure, e.g. literal matcher construction |
  | `storeQueue` | Store closed/not accepting or 128 pending publications |
  | `storeStale` | Generation mismatch, expired timestamp or invalid ID at publication gates (including late post-write checks) |
  | `storeOpenRoot` | Required full-profile open identity/manifest/directory is absent, no longer open or evicted |
  | `storeSize` | Manifest exceeds 1 MiB or publication group exceeds store byte limit |
  | `storeCapacity` | Inventory or storage admission refuses the group |
  | `other` | Unknown internal reason; never a request-derived/dynamic label |

- `BodyCapture` passes only an internal fixed `limitReason` for raw/encoded capture pressure; `DetailRedactor` retains its first fixed secret/work/output/other limit reason. In `DetailRoot.finalize()` **both** full and error profiles count one root-level resource omission when any relevant body is `resource-limited`, even if several bodies fail. `rootLimitReason()` picks `captureBudget > redactionSecretLimit > redactionWorkLimit > redactionOutputLimit > redactionOther > other` deterministically across redactor and bodies (with conservative `redactionOther` fallback); store rejection gates use their own fixed keys. A `resource-limited` root may still publish a manifest and other sanitized bodies. Ordinary 5 MiB per-body `truncated` without resource pressure is not a drop; `omitted-for-safety` from ambiguous/unsafe input is not silently relabelled `resource-limited`. Do not add a second scan, change the safety fences, or put the internal reason on a descriptor.
- Authenticated `GET /api/logs/settings` and `GET /api/logs/details` expose the same additive aggregate `health.dropReasons` object; older clients may ignore it. No per-request reasons or new reason field belongs in ordinary request/error JSONL, `metadata.json`, detailed manifests/descriptors, error responses or service logs; no body, Header value, credential, raw session or request identity may enter the counters or labels. Clear still advances its publication generation, not a persisted reason history. The existing default-off modes, capture timing, 5 MiB body and 64 MiB retention budgets, store retention, and fail-open traffic behavior remain unchanged. Do not expose raw errors, paths, bodies or credentials in service output.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Missing/invalid truthy persisted switch | That profile is off; only literal true enables capture |
| Settings POST empty, extra, or containing a nonboolean field | 400; no persistence or runtime change; legacy one-field `{ detailedLogging }` remains valid |
| Settings atomic write fails | Safe 500; previous runtime/file retained |
| Invalid/duplicate filter, malformed cursor or ID | 400 |
| Expired/cleared/missing/corrupt selected record/body | Safe 404 |
| List storage operation unavailable | Safe 503/health; never raw filesystem error |
| Header/body URL has repeated credential query keys, known syntax collisions, or an outer Bearer token encloses URL/assignment syntax | Discover the full original inner syntax before substitution; redact every earlier/cross-body echo, including comma/semicolon URL suffixes, and preserve ordinary query parameters |
| A recognized credential header contains `Bearer api_key=<secret>` or equivalent wrapped assignment | Run bounded discovery on the scheme-stripped credential and redact the bare secret from all group metadata, APIs and files without changing forwarded bytes |
| Structured Authorization/Basic/Cookie fields occur after a component echo | Component echo, including dequoted Cookie values, is redacted across JSON/SSE events, headers and all group bodies before publication |
| Cap/interruption falls inside a credential in JSON, nested leaves, prose or a non-JSON SSE tail | Group-wide omission; never publish a credential-prefix substitution plus its reconstructable suffix |
| Complete ordinary text contains one literal `\\uNNNN` / `\\xNN` layer | Preserve the original text when its bounded decoded view reveals no credential; decoded credential forms scrub cross-group echoes, and only an affected ambiguous string is omitted |
| Literal escapes are partial or remain nested after one bounded decode | Group-wide omission; never guess through an incomplete or arbitrarily nested representation |
| Short known secrets match characters in `[REDACTED]` | Single original-input replacement; complete markers stay unchanged on repeated passes and ordinary small bodies remain complete |
| Replacement output or match work would exceed its bound | Stop before retaining an oversized slice/match array; empty `resource-limited` body descriptors and exactly one fixed root-level drop reason, with traffic/completeness unchanged |
| Ordinary 5 MiB body cap, interruption or unsafe syntax without a resource fence | Explicit `truncated`/`interrupted`/`omitted-for-safety` descriptor; no resource drop inferred, forwarding unchanged |
| Raw/encoded capture budget or redaction secret/work/output fence | Fixed root-level reason, priority as above if simultaneous; multiple bodies within one root still count once and a sanitized manifest may exist |
| Active-root or attempt-capture admission fails | `activeLimit`, `attemptLimit` or `attemptCaptureFailure` at the existing entry point; model response unchanged |
| Queue/close, stale/expired/invalid publication, lost open root, oversized group or inventory/space refusal | Respectively `storeQueue`, `storeStale`, `storeOpenRoot`, `storeSize`, `storeCapacity`; one drop per existing rejection; release reservations |
| Detailed counter reaches `Number.MAX_SAFE_INTEGER` | Freeze total and all reason buckets together, preserving a safe exact sum; failures/corrupt remain independent |
| Older detailed health lacks `dropReasons` | Old clients ignore the additive field; new UI displays reason unavailable, never guesses from `dropped` |
| Disk/rename failure or blocked writer | Model response/lease completion unaffected; release reservations |
| Publication and temporary cleanup both fail | Recover abandoned owned groups at the next safe serial maintenance/clear; persistent deletion failure returns safe 503, never false clear success |
| Active or queued capture predates clear | Cannot republish; post-clear roots remain eligible |
| Store close begins | Already-admitted publication drains; later open/publication drops immediately and releases capture reservations |
| Error row has intent but detail root is missing | UI says the detail is unavailable because it may have expired, been cleared/capacity-dropped, or failed publication; never invent a per-record cause |

### 5. Good / Base / Bad Cases

- **Good:** alias input, rewritten provider requests, rejected SSE head and final client response remain correlated but distinct.
- **Good:** a Location URL password scrubs an earlier JSON echo and ordinary header echo before temporary files are written.
- **Good:** two limited bodies in one published root increment `dropped` once, classified by the fixed priority; a separate store queue rejection increments `storeQueue` once without a manifest.
- **Base:** a fresh default-off store reports `dropped: 0` and all 14 reason buckets zero; a plain 5 MiB truncation alone remains `truncated` without a drop.
- **Base:** both modes off create no captures and leave model traffic plus ordinary row fields unchanged; enabling error-only still creates no group for a successful request. Full mode may capture submitted downstream SSE comments, but error-only and ordinary diagnostics never add a heartbeat record.
- **Bad:** adding bodies to `JsonlLogGroup`, consuming a second flowing response stream, or claiming an unread GET body is complete empty.
- **Bad:** sanitizing headers only after serializing bodies; field-order-dependent credential leaks result.
- **Bad:** increment `health.dropped` without `recordDrop`, count every limited body instead of its root, infer a missing root from `dropped`, or persist a per-request limit reason in a manifest/ordinary log.

### 6. Tests Required

`test/detailed-log-capture.test.js` covers byte boundaries, split UTF-8/SSE/escaped credentials, known-secret suffixes, malformed/unread bodies, header-URL/prose credential discovery across the group, structured/quoted Cookie component echoes without Set-Cookie attribute over-redaction, repeated URL query credentials/ordinary query preservation, ordinary content, budget release, native backpressure/destruction/error identity and downstream overloads. Every-cut JSON/nested-credential/prose/non-JSON SSE tail tests must assert group-wide omission, including earlier headers/bodies, while safe ordinary prefixes remain visible. Complete ordinary one-layer literal escapes must remain readable across root/attempt bodies and Headers. Escaped credential values, names and URL keys must remove original/decoded forms and cross-group echoes without blanking unrelated complete content; partial or nested escaped representations must retain group-wide omission. Short-secret tests must prove nonrecursive markers across repeated passes, literal metacharacter handling and matcher invalidation after new secrets. Large-prefix exact/excess output, 16,383/16,384/16,385 assignment matches and exact/excess cumulative overlapping value-span tests must prove bounded discovery/assembly, ordinary-tail preservation, group-wide omission under pressure and reservation release. Production-root and authenticated API/file regressions cover known syntax collisions, raw credential-header URLs and Bearer-wrapped URL/assignment syntax with JSON/SSE traffic equality. They must include recognized request and upstream-response credential headers containing `Bearer api_key=<secret>`, earlier ordinary header/body echoes, and absence from metadata, on-demand body APIs, files and service output. Outer-token overlap tests observe actual production matcher indexes to prove strictly increasing starts, 8,192 outer plus 8,192 inner matches at the exact budget, and rejection of match 16,385 before learning. Preserve ordinary tails/markers, omit partial inner credentials even beyond an outer delimiter, and release reservations on group-wide work-limit omission. `test/detailed-log-store.test.js` covers metadata-only reads, retention/order/restart, failures, corrupt preservation, identity/symlink rejection and clear/eviction races. Small injectable limits must prove initial zero buckets, queue/closed rejection, stale generation/expired/invalid identity (including late clear), missing open-root association, size and inventory/capacity admission, release, exact per-gate counts and sum invariance. Test `recordDrop`'s unknown-to-`other` mapping, restart reset, failure/corrupt independence, and paired total/distribution saturation at `Number.MAX_SAFE_INTEGER`. `test/detailed-log-capture.test.js` additionally uses small capture budgets and bounded fixture secret/work/output inputs to prove raw and encoded budget pressure, redaction secret/work/output attribution, stable multi-limit priority, multi-body one-root counting in both full and error profiles, independent attempt cap, absence of internal reason from descriptors, and no drop for plain per-body truncation or safety-only omission. It must instrument a seeded corpus and prove that normal publication, query and minute expiry perform no corpus directory walk, stored-manifest reread or body read after startup, while explicit reconciliation discovers external safe state. Failed publication plus failed temporary cleanup must recover on clear/maintenance/publication, preserve older successful records and unknown/symlink data, reject persistent deletion failure and never delete a blocked active publication's temporary group. Detailed integration suites use temporary DATA_DIR and local mocks for every route class, actual-call counts, off/on traffic equivalence, stream outcome/lease regressions, setting persistence/failure, process interruption and blocked writes. When adding heartbeat capture coverage, assert a quiet full-profile downstream body contains only submitted ping bytes plus original model events, while its upstream capture and ordinary rows contain no generated ping; do not infer a captured ping from merely enabling detailed logging. Error-only coverage must include provider retry, account replacement, HTTP errors, HTTP-200 envelopes, recognized SSE errors, no-response transport failures, post-start stream failures, full-profile precedence, disabled-row field omission, exact `(attemptIndex, callId)` matching and successful 50 MiB input with no body-capture reservation. Ordinary sensitive-data tests must still pass with details enabled. `test/integration.test.js` must compare both authenticated health projections (including default-off zero, fixed key set, safe numerics, process restart reset and sensitive-value absence) without adding reasons to manifests, ordinary JSONL, metadata, errors or unauthenticated responses; active-root refusal and the native attempt-capture boundary must remain fail-open. Local streaming/cancellation fixtures verify byte-identical client/upstream traffic, one real-attempt/RPM/lease lifecycle, unchanged outcome and drop health independent from request errors. `test/detailed-log-ui.test.js` and `test/ui-contract.test.js` cover fixed labels, old-response/malformed-number/extra-key safety, stale navigation, ARIA/text-only rendering and account-draft isolation; VM/static assertions are not real-browser focus or narrow-screen evidence.

Run module/server syntax checks, embedded browser-script compilation and `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test`. Small injectable retention tests do not establish full-1-GiB performance or exact RSS, and VM/static UI tests are not browser proof.

### 7. Wrong vs Correct

```js
// Wrong: later header sanitization learns credentials after the echo escaped.
const body = capture.materialize(redactor);
const headers = redactor.headers(responseHeaders);

// Correct: discover credentials across the group before any projection.
for (const headers of headerMaps) redactor.learnHeaders(headers);
for (const capture of captures) capture.learn(redactor);
const bodies = captures.map(capture => capture.materialize(redactor));
```

```js
// Wrong: set() deletes later duplicate values before the iterator learns them.
for (const [key, value] of url.searchParams) learnAndReplace(key, value);
// Correct: snapshot every original pair before rewriting the URL.
for (const [key, value] of [...url.searchParams]) learnAndReplace(key, value);
```

```js
// Wrong: a partial SSE data field may contain an unfinished prose credential.
redactor.body(partialData);
// Correct: discovery retains partial semantics even when the tail is not JSON.
redactor.prefix(partialData);
```

```js
// Wrong: a body's omission increments an unclassified total, then every other
// limited body increments it again (and leaks its internal reason in a manifest).
store.health.dropped++;
manifest.request.limitReason = body.limitReason;

// Correct: choose one fixed primary cause for the root, in memory only.
if (resourceLimited) store.recordDrop(rootLimitReason(redactor, bodies));
```

Local-mock integration verifies JSON/SSE component and repeated-query echoes are absent from detail metadata/body/list APIs, detailed/ordinary files, metadata and service output while actual client/upstream traffic remains unchanged. Ten cap/interruption cases cover JSON/SSE API-key/quoted-Cookie fields plus non-JSON SSE Bearer tails with exact off/on client bytes/status/completeness and upstream input equality; short-secret fixtures verify readable single markers for small inputs and resource-limited omission only after the match budget is exceeded, without changing HTTP output or retaining leases. Store and API tests reject explicit empty cursors with 400. These checks apply to new publications; they do not migrate previously persisted content.
