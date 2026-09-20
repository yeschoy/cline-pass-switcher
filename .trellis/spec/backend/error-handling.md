# Backend Error Handling

> Fail closed at trust and persistence boundaries, keep traffic semantics stable, and expose only bounded redacted diagnostics.

---

## Error Model

The project does not use a custom error-class hierarchy. It uses native `Error` objects plus small boundary-specific facts:

- `error.statusCode` carries an intended HTTP status for request/storage validation.
- Upstream failures keep separate HTTP, normalized, and terminal-origin facts rather than rewriting the original status in place.
- `safeReason()` / `errText()` flatten and redact messages before logs, metadata, headers, or API responses.
- Detailed-store helpers create stable 400/404/503 errors without exposing paths or raw filesystem failures.

Do not infer behavior from an error message when a status/code or explicit result field already exists.

## Trust-Boundary Pattern

New strict boundaries validate complete input before mutation or upstream work. Route handlers return a bounded JSON shape through `sendJSON()`:

```js
if (!isPlainObject(body) || typeof body.force !== 'boolean') {
  return sendJSON(res, 400, {
    error: { message: 'expected only boolean force' }
  });
}
```

Authentication runs before protected route logic. `unauthorized()` returns the stable `401` shape. Unknown routes return a safe `404`; the outer `dispatch()` catch uses `statusCode` when present and otherwise returns `500` with `safeReason()`.

Existing older management endpoints are not uniform: some return `{ error: 'message' }`, and `/api/security` currently coerces its accepted fields and ignores unknown fields. Newer strict boundaries use `{ error: { message, type? } }` and exact payload allowlists. Preserve an existing endpoint's compatibility contract unless the task explicitly includes validation/API migration; do not copy a permissive legacy pattern into a new route.

## Persistence and Startup

`loadJson()` falls back only on `ENOENT`. Malformed or unreadable operator JSON throws and stops startup; never catch it and overwrite the file with defaults.

`atomicWriteJson()` writes a same-directory temporary file and renames it over the destination, preserving an existing mode and using `0600` for a new file. Cleanup errors are not silently ignored unless the file is already absent.

For dynamic diagnostics/statistics where traffic must remain available:

```js
try { saveMeta(); }
catch (error) {
  console.error(`[统计] 持久化失败：${safeReason(error.message)}`);
}
```

Use this fail-open form only where the feature contract explicitly says diagnostic persistence must not fail model traffic. `POST /api/logs/settings` is the existing persist-first configuration path: it atomically writes a candidate and changes runtime mode only after success. Other management endpoints currently mutate the in-memory `config` object before `saveConfig()`; preserve that compatibility unless a task explicitly hardens their transaction boundary, and do not claim a failed write left runtime state unchanged without a focused test.

## Upstream, Cancellation, and Streams

- Preserve upstream HTTP status separately from normalized client status.
- Classify timeout, proxy, network, authentication, rate-limit, server, schema, and client-cancellation outcomes explicitly.
- Canonical `errorRules` run only after a real failure has normalized status, bounded/redacted error text, request-local bounded response Headers, resolved model, and named Provider attribution. Provider/model/status/body/Header conditions are ANDed, body arrays are ANY, and first rule wins. Never persist a needle, Header value, matched fragment, or raw body; logs may retain only bounded rule ID/scope/action/condition-kind facts.
- Distinguish local empty-input validation from an upstream `empty response content` failure. The latter means the request reached the model path but no visible completion was produced; for reasoning/tool-continuation requests, inspect the caller's `max_tokens` first (values such as 16 can be exhausted before content appears). Preserve the upstream status/error instead of relabeling it as a Switcher input error, and do not silently raise the token limit or replay the request because that changes cost and latency semantics.
- A configured proxy failure never falls back to direct transport.
- Client cancellation aborts upstream work, stops replay/failover after output starts, releases leases once, and does not create health penalties or error attempts.
- Stream finalization is idempotent. A complete `[DONE]` followed by close is success; close before completion is `499 / client_cancelled`; observed stream/transport errors remain failures.
- Diagnostic capture/storage failures increment safe health counters and release reservations but never change the response body/status or block lease completion.

## Filesystem and Resource Failures

Detailed storage validates path identities and file types, refuses symlinks, serializes mutations, and maps unavailable operations to safe 503 responses. Missing/cleared/expired bodies are ordinary safe 404s. Corrupt or unknown operator-owned entries are preserved rather than deleted or repaired into apparent success.

Bound every error-prone input and diagnostic operation: request bodies, detail bodies, SSE events, filters, cursors, account fields, queues, work scans, timeouts, and retained bytes all have explicit limits in the quality/logging specs.

## Common Mistakes

- Catching every JSON read error and writing defaults, which destroys operator data.
- Returning `error.message`, upstream JSON, paths, credentials, request bodies, or proxy URLs without redaction.
- Treating cancellation as network failure and applying cooldown/ban/backoff.
- Synthesizing an early stream error on `aborted` before Node reports the native terminal error.
- Updating runtime configuration before its atomic write succeeds.
- Swallowing a cleanup failure while claiming clear succeeded.
- Retrying through direct transport after a configured proxy fails.
- Matching scoped rules against successful output, raw unbounded bodies, or pre-redaction diagnostics; or allowing unmatched defaults to create cooldown/quarantine.

## Required Tests

Use temporary `DATA_DIR` and local endpoints. Relevant changes must assert:

- malformed persisted JSON fails startup and preserves exact bytes;
- invalid management payloads return 400 before writes/upstream work;
- authentication and unknown-resource statuses keep stable safe shapes;
- write/rename/read/cleanup failures preserve prior durable state and expose no raw error;
- proxy/network/timeout/upstream statuses remain correctly classified and redacted;
- client/stream cancellation releases resources exactly once and does not mutate health/backoff incorrectly;
- logging enabled/disabled returns byte-equivalent model traffic despite capture/storage failures;
- canonical rule scope/action/applicability/status/body-ANY/Header/reset/first-match/default behavior and non-stream/pre-stream/post-start/cancellation boundaries leak no matched sensitive text.

Run focused tests, then `npm test`, syntax checks, and `git diff --check`.
