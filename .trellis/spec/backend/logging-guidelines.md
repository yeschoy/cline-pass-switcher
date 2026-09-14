# Logging Guidelines

> Executable contracts for durable request/error diagnostics in the Cline Pass switcher.

---

## Scenario: Bounded JSONL request and error logs

### 1. Scope / Trigger

Use this contract when changing request finalization, provider/proxy error recording, log retention, log query APIs, or fields rendered by the console.

Logs are diagnostic projections, not raw request dumps. A proxy response must not fail because diagnostic persistence fails, and a log must never become a second storage location for credentials, prompts, sessions, proxy URLs, account notes, or upstream response bodies.

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
  targetProviders, actualProvider, attempts,
  status, upstreamStatus, durationMs,
  accountActions, appliedHeaderNames, errorCategory
}
```

`attempts` is a projection of provider/status/timing/account/action facts. It is not the raw upstream object. Pipeline fields are server-owned bounded values: `pipelineSteps` contains at most eight of `health-filtered`, `health-filter-fallback`, and `quota-all-unknown`; `selectedQuotaPool` is `ordinary`, `hot`, `warm`, `unknown`, or `reserve`; `selectedHealthLayer` is `ordinary`, `available-or-insufficient`, `degraded`, or `unhealthy`; and `capacityFallback` is boolean. Raw health buckets, quota payloads, percentages, identities, credentials, proxy data, and messages remain forbidden.

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

Filters are endpoint-specific allowlists. Shared aliases `model`, `account`, and `provider` search the documented projected fields. Numeric and boolean filters are parsed strictly; unknown parameters return `400` instead of being ignored.

The cursor encodes `ts`, `requestId`, `attemptIndex`, segment name, and line number. Segment/line disambiguation is required because one request may have multiple error attempts with equal timestamps.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Unknown query parameter | `400`; do not scan logs |
| `limit` outside 1-200 or non-integer | `400` |
| `from`, `to`, `status`, or `upstreamStatus` is not a finite integer | `400` |
| Boolean filter is not exactly `true` or `false` | `400` |
| Cursor is malformed or stale after retention | safely restart from the newest matching records; never crash |
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
- **Base:** a successful request creates one request record and no error record.
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
  appliedHeaderNames: Object.keys(account?.headers || {})
});
```

Build a strict projection first; redaction is defense in depth, not permission to serialize arbitrary objects.
