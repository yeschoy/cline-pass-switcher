# Logging Guidelines

> Executable contracts for durable request/error diagnostics in the Cline Pass switcher.

---

## Scenario: Bounded JSONL request and error logs

### 1. Scope / Trigger

Use this contract when changing request finalization, provider/proxy error recording, log retention, log query APIs, or fields rendered by the console.

Ordinary request/error logs are diagnostic projections, not raw request dumps. A proxy response must not fail because diagnostic persistence fails, and these logs must never become a second storage location for credentials, prompts, sessions, proxy URLs, account notes, or upstream response bodies. The separately authenticated, opt-in detailed store below is the only approved body/header exception; it does not change this ordinary-log projection or metadata exclusions.

### 2. Signatures

```js
new JsonlLogStore({ dir, prefix, maxRecords, maxAgeMs, segmentBytes, totalBytes })
store.append(projectedRecord)
store.query({ limit, cursor, filters })
store.clear()
store.compact()
enforceCombinedLimit(dir, maxBytes, segmentBytes)
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

- Request and error records are separate JSONL streams. The production limits are 50,000 request records, 10,000 error records, 30 days, 5 MiB per segment, and 100 MiB combined.
- Appends are serialized inside each store. Compaction writes replacement segments to temporary files and renames them before deleting superseded segments.
- Combined-size enforcement orders both streams globally by `ts` and removes the oldest records first. It must not apply two independent 100 MiB limits.
- Startup and every 100 appends enforce retention. A truncated final line and malformed individual lines are ignored rather than preventing startup.
- Record identity is `requestId` for requests and `(requestId, attemptIndex)` for errors. Compaction deduplicates these identities so an interrupted old/new segment overlap does not duplicate diagnostics.
- `metadata.history` is compatibility-only. New chat requests write JSONL and update model/account aggregates, but do not grow the legacy history array.
- A log append error may produce a redacted service-level `console.error`; it does not change the client response.

#### Request projection

A request record may contain only:

```js
{
  ts, requestId, requestedModel, resolvedModel, stream,
  strategy, sessionSource,
  preferredAccountId, preferredAccountName,
  accountId, accountName, selectionReason, overflow, switched,
  pipelineSteps, selectedQuotaPool, selectedHealthLayer, capacityFallback,
  cachePoolSize, cachePoolTier, cachePoolFallback,
  targetProviders, actualProvider, attempts,
  status, result, upstreamStatus, durationMs,
  accountActions, appliedHeaderNames, errorCategory
}
```

`result` is exactly `success`, `client_cancelled`, or `failed`. `status` remains the final request status; client cancellation is `499`, has `errorCategory: null`, and suppresses all error-log attempt projection even when abort plumbing produced an internal transport trace. Older JSONL rows without `result` remain readable and are never migrated.

`attempts` is a projection of provider/status/timing/account/action facts. It is not the raw upstream object. Pipeline fields are server-owned bounded values: `pipelineSteps` contains at most eight of `health-filtered`, `health-filter-fallback`, and `quota-all-unknown`; `selectedQuotaPool` is `ordinary`, `hot`, `warm`, `unknown`, or `reserve`; `selectedHealthLayer` is `ordinary`, `available-or-insufficient`, `degraded`, or `unhealthy`; `capacityFallback` is boolean; `cachePoolSize` is the configured bounded integer; `cachePoolTier` is `active`, `standby`, or null; and `cachePoolFallback` is boolean. Selection reasons may additionally be `cache-pool-active`, `cache-pool-active-overflow`, or `cache-pool-standby-overflow`. Raw candidate lists, health buckets, quota payloads, percentages, identities, credentials, proxy data, and messages remain forbidden.

An error record may contain only:

```js
{
  ts, requestId, requestedModel, resolvedModel,
  accountId, accountName, attemptIndex,
  targetProvider, providerPath,
  status, upstreamStatus, category, reason, accountAction
}
```

Each real failed provider/proxy attempt gets one error record. A request and all its error attempts share the same internal UUID, which is also returned as `X-Cline-Request-Id`.

#### Sensitive-data boundary

Before persistence, redaction covers configured account keys, proxy/admin keys, proxy URL/user/password components, every configured custom Header value, and request message text. Bearer-looking values are redacted generically. Reasons are flattened but retain the complete extracted upstream error so nested provider diagnostics are not lost. This does not permit persisting a raw response body: non-JSON/invalid error responses use a generic diagnostic instead.

Never persist:

- account Key, proxy URL or proxy authentication;
- any Header value, Authorization, Cookie, or request body;
- account note;
- raw session/thread/conversation value or HMAC fingerprint;
- message text, reasoning/content, or upstream response body.

Only `sessionSource` and applied safe Header names may be recorded.

#### Query and cursor

Filters are endpoint-specific allowlists. Shared aliases `model`, `account`, and `provider` search the documented projected fields. Request logs additionally allow `result`; historical rows without the field simply do not match a non-empty result filter. Numeric and boolean filters are parsed strictly; unknown parameters return `400` instead of being ignored.

The cursor encodes `ts`, `requestId`, `attemptIndex`, segment name, and line number. Segment/line disambiguation is required because one request may have multiple error attempts with equal timestamps.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
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
| Upstream returns a long structured error | persist the complete redacted error field, including its final nested provider cause |
| Upstream returns a non-JSON/invalid error body | persist a generic diagnostic, never the raw response body |
| Pipeline diagnostics contain a non-owned/raw value | omit it; persist only the bounded enum/boolean projection |
| Diagnostic JSONL or metadata persistence fails | report only a redacted service error; do not change the chat response |

### 5. Good / Base / Bad Cases

- **Good:** a request returns `X-Cline-Request-Id`; filtering errors by that ID returns each failed attempt once and the request page shows the final account/provider path.
- **Good:** two stores exceed the combined limit; global cleanup keeps the newest records regardless of type.
- **Good:** a capacity fallback records its bounded pipeline groups/reason without recording quota percentages or health buckets.
- **Base:** a successful request creates one `200 / success` request record and no error record.
- **Base:** a client cancellation creates one `499 / client_cancelled` request record and no error record.
- **Base:** a capacity rejection has no account but still records strategy, status, request ID, and safe reason category.
- **Bad:** `JSON.stringify(req)`, `JSON.stringify(account)`, or persisting a raw upstream error object. These cross the trust boundary.
- **Bad:** unlinking old segments before replacement segments are durable; a rename failure would lose diagnostics.
- **Bad:** paginating errors by request ID alone; multiple attempts for one request will repeat or disappear.

### 6. Tests Required

`test/jsonl-log-store.test.js` must cover rolling, restart replay, filtering, cursor pagination, expiry, independent clear, malformed/truncated lines, compaction dedupe, segment size, and combined global byte enforcement with small injectable limits.

`test/integration.test.js` must assert:

- request response ID equals the logged request ID;
- requested/resolved models, strategy, selection reason, overflow and account path are present where applicable;
- one request with multiple failures paginates every error exactly once;
- unknown/invalid filters return `400`;
- account keys, proxy credentials, custom Header values, account notes, raw sessions, messages, Authorization/Cookie, and upstream sensitive bodies do not occur in serialized log API results or files;
- long structured SSE/JSON errors retain their final diagnostic text, and short message redaction does not corrupt unrelated words containing the same substring;
- SSE, account replacement, proxy failure, capacity failure, and normal JSON responses finalize no more than one request record;
- a downstream close after observed `[DONE]` records one `200 / success`, while pre-DONE streaming and non-streaming cancellations each record one `499 / client_cancelled`, no error attempt, and no error/usage/health effect;
- request `result` filtering returns only explicit new records, while historical rows without `result` remain readable and unmodified;
- pipeline diagnostics accept only the documented enum/boolean projection and contain no quota percentages, raw health data, or secrets;
- simulated log/metadata write failures do not alter the already-determined chat status or body.

Run `node --check lib/jsonl-log-store.js`, `npm test`, and `git diff --check` after changes.

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
new DetailRoot(req, res, store, secrets)
detailContext.run(root, dispatch) // native AsyncLocalStorage
root.attempt({ headers, body, account, proxyUrl, method, url })
root.finalize()
new BodyCapture({ budget, limit }) // production 5 MiB per body
new DetailRedactor(secrets)
observeStream(source, capture)
new DetailedLogStore({ dir, maxAgeMs, maxTotalBytes, now, io })
store.query(parseDetailQuery(url.searchParams))
store.detail(requestId)
store.body(requestId, bodyId)
store.clear()
```

```text
GET  /api/logs/settings
  -> { detailedLogging, authRequired, maxBodyBytes, maxAgeMs, maxTotalBytes, health }
POST /api/logs/settings
  <- { detailedLogging: boolean }
  -> { ok: true, detailedLogging }
GET  /api/logs/details?limit=&cursor=&requestId=&from=&to=&model=&account=&status=
  -> { items: <metadata-only roots>, nextCursor, health }
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
- Every actual native POST to configured `/chat/completions` has its own UUID call ID, including setup/network failures, provider retries, account replacement, harvest and concurrent validation. Only an included GET root's actual model-list cache-miss fetch is captured. Do not instrument enrichment, public discovery, quota, arbitrary fetches or hidden gateway retries.
- The root UUID is reused for ordinary chat request IDs. Original ingress, rewritten upstream and final downstream bodies remain separate. Attempt fields include actual account, model/provider target, public Node-visible headers, HTTP status and transport completeness; they are not inferred from trace length.
- Capture is bounded observation only: one backpressured upstream Transform before SSE-head consumption, input observation inside the existing reader, and overload-preserving response write/writeHead/end wrappers. Diagnostic truncation never truncates forwarding. Response bytes mean submitted bytes, not proven peer receipt.
- Request-start mode and clear generation are snapshots. Root finalization is idempotent and asynchronous publication is never awaited by model completion. `status` is the submitted HTTP status or null before headers; `result`, when present, comes from the existing chat finalizer, including DONE-close success and early client cancellation. Existing leases, retry policy and statistics remain authoritative.

#### Sanitization and resource limits

- Each body copies at most 5 × 1024 × 1024 bytes, including streaming and every attempt. Also cap encoded sanitized output at a valid UTF-8 boundary. Descriptors are `{ bodyId, observedBytes, capturedBytes, truncated, complete, state, omittedTailBytes, redacted }`; `complete` describes observed transport completion, not absence of truncation/omission. States are `complete`, `truncated`, `interrupted`, `unread`, `omitted-for-safety` and `resource-limited`.
- Snapshot configured keys/proxy credentials and learn ephemeral test/actual request credentials. Recognize credential header/JSON names (Authorization, Cookie/Set-Cookie, API/admin/access keys, password/passwd, tokens, secrets), Basic/Bearer forms, credential-bearing URL userinfo/query values and known-value echoes. Keep ordinary model token limits/usage counters, headers and message text.
- **Learn before projecting:** scan all request/attempt/downstream header maps and bodies for recognized credentials before materializing any body or metadata. Discover original URL/Bearer/assignment syntax before known-value replacement: a known `https`, `Bearer` or `api_key` must not destroy the parser's discovery input. Ordinary Referer/Location/custom headers may contain credential URLs or prose assignments; their credentials must scrub earlier header/body echoes regardless of field order. Generic Basic/Bearer values also join the group secret snapshot. Recognized credential headers run the same bounded original-token discovery on the scheme-stripped credential, learning URL and assignment components as well as the whole value. For example, `X-Credential: Bearer api_key=secret` must teach the bare `secret`; storing only the wrapped and `api_key=secret` forms leaves cross-body echoes exposed. Suppress recursive wrapped discovery for the outer scheme, then resume at the inner credential start under the existing match/work limits.
- Structured credential leaves reuse header component discovery: learn Bearer tokens, Basic encoded values/decoded username/password components, and individual Cookie values, including nested leaves and normalized field-name variants. Valid RFC 6265 quoted Cookie/Set-Cookie values contribute both raw quoted and dequoted secrets, so bare echoes are scrubbed. Set-Cookie attributes such as Path, Domain, Max-Age and SameSite are not secrets by themselves; ordinary prompt text and token counters must remain intact.
- Treat URLs as whole tokens before interpreting prose assignments. Learn every credential query occurrence from a snapshot of `URLSearchParams` before `.set()` collapses duplicate keys. Repeated `api_key` values and adjacent credential parameters must scrub earlier/cross-body echoes; ordinary URL query parameters remain inspectable.
- Valid JSON is parsed and sanitized; complete SSE events retain order and DONE; safe prose uses conservative textual sanitization. Partial JSON may be reconstructed as a labelled diagnostic prefix; partial SSE keeps complete events only. Remove known-secret suffix fragments at a capture boundary. Invalid encoding, ambiguous malformed/escaped text, or exceeded sanitizer work limits are omitted explicitly, never dumped raw to temporary disk.
- An unfinished recognized credential is not a complete known value. Before projecting any body, inspect partial JSON credential scopes and the unfinished SSE tail, including non-JSON `data: Bearer ...`, prose assignments and URLs. Failed/ambiguous discovery fences the whole group: retained bodies become empty `omitted-for-safety`, and header/string metadata becomes omission markers. This includes literal `\\uNNNN` / `\\xNN` escapes inside decoded JSON/SSE strings or ordinary headers: omitting only that string would leave earlier decoded credential echoes exposed. This prevents replacing a short observed prefix while exposing reconstructable suffixes in earlier echoes. Safe ordinary prefixes/complete events remain inspectable; transport completeness and truncation are independent facts.
- `text()` iterates original URL/Bearer/assignment tokens, merging overlapping redaction spans and assembling output once. An outer Bearer/Basic match keeps its output span but resumes discovery at its credential's original start, strictly after the scheme's match start. This permits inner URL/assignment matches without revisiting the same outer token or recursively scanning the whole text. Inner URLs retain their own full grammar (including comma/semicolon query values); the outer scheme's terminator must not turn a full credential into a known prefix. Reuse the 5 MiB UTF-16 input/output and 16,384-match bounds; count inner matches and ordinary assignment tokens too. Check projected output before retaining slices and before the final join. Still discover nested assignments/URLs inside credential values, but bound cumulative assignment-value lengths to 5 MiB before learning/retaining each value. Matching the rejected candidate can scan at most one additional input length (at most 10 MiB cumulative value-span scan per call, not a measured latency bound). Do not expand all assignment matches or reconstruct the whole string per match. `known()` retains its separate pass budget below.
- Retained raw/encoded payload reservations are bounded at 64 MiB through serialized publication; this is not an exact RSS bound. Activity/queue/attempt and sanitizer work limits drop diagnostics with safe health counters, not traffic. `known()` uses a cached, escaped literal matcher over original input only, invalidated when a new secret is learned. Match whole `[REDACTED]` markers to preserve them on subsequent passes; generated output is never fed back into that replacement pass. Small short-secret inputs remain readable with single markers. Bound input/output to 5 × 1024 × 1024 UTF-16 code units and each pass to 16,384 matches, checking projected output/match count before retaining slices and the tail before joining. Exceeding either bound triggers `resource-limited` group omission, separately from the final encoded 5 MiB body cap. Do not build an unbounded split/replace match array or rely only on post-allocation truncation. Unknown secrets outside recognized locations/current-root knowledge cannot be universally detected.

#### Store, retention and APIs

- `DATA_DIR/detailed-logs/` uses 0700 directories, 0600 sanitized body/manifest files and UUID-v4 generated identities. Publication writes sanitized temporary files and atomically renames the manifest last. Body files are immutable; listing scans bounded manifests and file sizes, never body contents or a whole-body corpus.
- Seven days and 1 GiB are independent fixed limits, not operator knobs. Temporary/metadata/body bytes count toward admission. Evict oldest timestamp/UUID root groups together; no additional record-count retention rule. Startup, publication, query and periodic maintenance enforce retention. Late pre-clear, expired or evicted roots cannot recreate groups; a clear generation advances before queued deletion and allows new-generation requests afterward.
- Startup, serial maintenance (including query/publication) and clear remove abandoned store-owned `.tmp-<UUID-v4>` publication directories only when their entries are regular `manifest.json` or `<UUID-v4>.txt` files. No active publication owns a temporary group at these serial boundaries. Preserve unknown entries and symlinks rather than following or deleting them; unsafe temporary contents increment corrupt health. Failed deletion rejects clear/query with a safe 503 and cannot claim clear success; clear still advances its generation. Startup marks persisted `open` identity as `interrupted`, and cleans unreferenced temporary/body files. Open identity publication does not persist partial raw bodies. Pre-publication process exit can lose identity; atomic rename is not an fsync/power-loss guarantee. Corrupt/unreadable groups are preserved and excluded rather than repaired into apparent success.
- All APIs use existing admin authentication, including its deliberately unprotected empty-key mode; UI must warn about that mode. Settings/detail responses use `Cache-Control: no-store`; bodies additionally use `X-Content-Type-Options: nosniff`. IDs must be validated and body IDs must belong to the selected manifest; reject traversal/symlink paths. Read-versus-clear/eviction is a safe missing response.
- List filters are allowlisted, nonduplicated and bounded. `limit` is 1–200; times are nonnegative safe integers with from ≤ to; status is 100–599; IDs are UUID-v4. Cursor is canonical base64url `{ ts, requestId }`, never a path; an explicitly empty `cursor=` is invalid, unlike an absent cursor. It continues below that ordering position even if the previous row was evicted. Listings contain no headers or body text.
- Store health exposes bounded safe categories/counts (`failures`, `dropped`, `corrupt`, `lastFailure`); settings additionally expose capture drops/retained payload bytes. Persistence failure can prevent a record itself from being written, so health is authoritative for that loss. Do not expose raw errors, paths, bodies or credentials in service output.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Missing/invalid truthy persisted switch | Off; only literal true enables capture |
| Settings POST missing/extra/nonboolean field | 400; no persistence or runtime change |
| Settings atomic write fails | Safe 500; previous runtime/file retained |
| Invalid/duplicate filter, malformed cursor or ID | 400 |
| Expired/cleared/missing/corrupt selected record/body | Safe 404 |
| List storage operation unavailable | Safe 503/health; never raw filesystem error |
| Header/body URL has repeated credential query keys, known syntax collisions, or an outer Bearer token encloses URL/assignment syntax | Discover the full original inner syntax before substitution; redact every earlier/cross-body echo, including comma/semicolon URL suffixes, and preserve ordinary query parameters |
| A recognized credential header contains `Bearer api_key=<secret>` or equivalent wrapped assignment | Run bounded discovery on the scheme-stripped credential and redact the bare secret from all group metadata, APIs and files without changing forwarded bytes |
| Structured Authorization/Basic/Cookie fields occur after a component echo | Component echo, including dequoted Cookie values, is redacted across JSON/SSE events, headers and all group bodies before publication |
| Cap/interruption falls inside a credential in JSON, nested leaves, prose or a non-JSON SSE tail | Group-wide omission; never publish a credential-prefix substitution plus its reconstructable suffix |
| Short known secrets match characters in `[REDACTED]` | Single original-input replacement; complete markers stay unchanged on repeated passes and ordinary small bodies remain complete |
| Replacement output or match work would exceed its bound | Stop before retaining an oversized slice/match array; empty `resource-limited` body descriptors and safe drop health, with traffic/completeness unchanged |
| Body cap, interruption, unsafe syntax or memory pressure | Explicit descriptor/health; forwarding unchanged |
| Disk/rename failure or blocked writer | Model response/lease completion unaffected; release reservations |
| Publication and temporary cleanup both fail | Recover abandoned owned groups at the next safe serial maintenance/clear; persistent deletion failure returns safe 503, never false clear success |
| Active or queued capture predates clear | Cannot republish; post-clear roots remain eligible |

### 5. Good / Base / Bad Cases

- **Good:** alias input, rewritten provider requests, rejected SSE head and final client response remain correlated but distinct.
- **Good:** a Location URL password scrubs an earlier JSON echo and ordinary header echo before temporary files are written.
- **Base:** mode off creates no captures and leaves all ordinary behavior unchanged.
- **Bad:** adding bodies to `JsonlLogStore`, consuming a second flowing response stream, or claiming an unread GET body is complete empty.
- **Bad:** sanitizing headers only after serializing bodies; field-order-dependent credential leaks result.

### 6. Tests Required

`test/detailed-log-capture.test.js` covers byte boundaries, split UTF-8/SSE/escaped credentials, known-secret suffixes, malformed/unread bodies, header-URL/prose credential discovery across the group, structured/quoted Cookie component echoes without Set-Cookie attribute over-redaction, repeated URL query credentials/ordinary query preservation, ordinary content, budget release, native backpressure/destruction/error identity and downstream overloads. Every-cut JSON/nested-credential/prose/non-JSON SSE tail tests must assert group-wide omission, including earlier headers/bodies, while safe ordinary prefixes remain visible. Ambiguous escaped-string/header regressions must prove the same fence, including API/file absence and unchanged JSON/SSE traffic with transport completion still reported truthfully. Short-secret tests must prove nonrecursive markers across repeated passes, literal metacharacter handling and matcher invalidation after new secrets. Large-prefix exact/excess output, 16,383/16,384/16,385 assignment matches and exact/excess cumulative overlapping value-span tests must prove bounded discovery/assembly, ordinary-tail preservation, group-wide omission under pressure and reservation release. Production-root and authenticated API/file regressions cover known syntax collisions, raw credential-header URLs and Bearer-wrapped URL/assignment syntax with JSON/SSE traffic equality. They must include recognized request and upstream-response credential headers containing `Bearer api_key=<secret>`, earlier ordinary header/body echoes, and absence from metadata, on-demand body APIs, files and service output. Outer-token overlap tests observe actual production matcher indexes to prove strictly increasing starts, 8,192 outer plus 8,192 inner matches at the exact budget, and rejection of match 16,385 before learning. Preserve ordinary tails/markers, omit partial inner credentials even beyond an outer delimiter, and release reservations on group-wide work-limit omission. `test/detailed-log-store.test.js` covers metadata-only reads, retention/order/restart, failures, corrupt preservation, identity/symlink rejection and clear/eviction races. Failed publication plus failed temporary cleanup must recover on clear/maintenance/publication, preserve older successful records and unknown/symlink data, reject persistent deletion failure and never delete a blocked active publication's temporary group. Detailed integration suites use temporary DATA_DIR and local mocks for every route class, actual-call counts, off/on traffic equivalence, stream outcome/lease regressions, setting persistence/failure, process interruption and blocked writes. Ordinary sensitive-data tests must still pass with details enabled.

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

Local-mock integration verifies JSON/SSE component and repeated-query echoes are absent from detail metadata/body/list APIs, detailed/ordinary files, metadata and service output while actual client/upstream traffic remains unchanged. Ten cap/interruption cases cover JSON/SSE API-key/quoted-Cookie fields plus non-JSON SSE Bearer tails with exact off/on client bytes/status/completeness and upstream input equality; short-secret fixtures verify readable single markers for small inputs and resource-limited omission only after the match budget is exceeded, without changing HTTP output or retaining leases. Store and API tests reject explicit empty cursors with 400. These checks apply to new publications; they do not migrate previously persisted content.
