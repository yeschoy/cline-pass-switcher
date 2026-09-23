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
- Canonical `retryRules` is a separate ordered request-level stop policy evaluated by `matchRetryRule()` against the same normalized status and bounded/redacted failure text. Every entry requires both `when.statuses` and `when.body_contains`; status and body are ANDed, a body array is ANY, and matching is case-insensitive plain text with no regular expressions or Header conditions. The first matching rule returns `decision: "stop"`, which sets `chain.retryStop` after attempt settlement: `runChatChain()` stops the remaining same-account Provider attempts and the outer account-replacement branch is skipped, while the original terminal status/body is preserved. A stop applies to a pre-stream SSE error event as well; it is never derived from a successful response, from a request whose SSE output already started, from client cancellation, or from an exhausted candidate set, and it adds no replay.
- Retry classification and rule health action stay independent: `retryRules` only decides whether to continue, while the matching `errorRules` entry (or the default classification) decides the sample/disposition. The default `retryRules: []` leaves the existing retry behavior unchanged.
- Distinguish local empty-input validation from an upstream `empty response content` failure. The latter means the request reached the model path but no visible completion was produced; for reasoning/tool-continuation requests, inspect the caller's `max_tokens` first (values such as 16 can be exhausted before content appears). Preserve the upstream status/error instead of relabeling it as a Switcher input error, and do not silently raise the token limit or replay the request because that changes cost and latency semantics.
- A configured proxy failure never falls back to direct transport. Draft `/api/accounts/proxy-test` agents are disposable and destroyed on response end/close, request failure or abort; a stale persisted proxy agent is destroyed when the saved account URL disappears. Neither case converts the attempt into a direct request.
- A local account RPM cap is not an upstream failure. When a native chat attempt cannot claim a permit, the response is a local `429` with `Retry-After` derived from the earliest rolling-window recovery and `errorCategory: 'rpm'` plus the bounded `blockedBy: 'rpm'|'mixed'` enum. No upstream attempt, error rule, account replacement or health sample is created, and a previously real failed attempt keeps its original `upstreamStatus`/error row as history; the local block must never be recorded as a fabricated upstream `429`. Retry classification stays independent: a local block is evaluated by neither `retryRules` nor `errorRules`.
- An RPM permit is committed exactly when the native transport reaches `req.end()`. A synchronous failure before that point releases the reservation and notifies waiters; any later DNS/connect/proxy/TLS failure, HTTP error, timeout or client cancellation does not refund it.
- Stream first-data admission has a 120-second absolute attempt deadline (including response headers); prelude comments, empty events and `event:`/`id:`/`retry:` fields do not extend it. Up to 64 KiB of valid prelude is retained but not exposed until the first complete `data:` event. A recognized first-data error still goes through existing pre-stream error/retry rules. A rejected/comment-only oversized head destroys the response immediately instead of reading or waiting for an unbounded tail. After admission the native request/socket timeout is actually switched to the 360-second upstream idle limit; emitted downstream comments do not reset it. Non-stream attempts keep their bounded attempt timer.
- Only after a valid first-data event is submitted and an SSE event boundary is complete may a quiet stream write `: PING\n\n` (default 25 seconds, `0` disables it). Upstream bytes restart this downstream heartbeat, including partial events where injection must wait for a safe boundary. Generated comments are not provider responses or failures and cannot mask upstream timeout. `res.write() === false` means backpressure: pause extra comments and wait for `drain` before continuing. A throw or socket error/close, not `false`, drives downstream termination; do not manufacture a `499` for a draining client.
- Client cancellation aborts upstream work, stops replay/failover after output starts, releases leases once, and does not create health penalties or error attempts. A final client cancelling through New API before it receives upstream response headers may leave its New API → Switcher request open; Switcher cannot immediately infer that cancellation and bounds it with the first-event deadline.
- Stream finalization is idempotent. A complete `[DONE]` followed by close is success; close before completion is `499 / client_cancelled`; observed stream/transport errors remain failures.
- Detailed diagnostic omission/rejection goes through `DetailedLogStore.recordDrop(reason)` exactly once per existing event: one fixed primary reason per drop (one root-level event even when multiple bodies are resource-limited). Its process-local `dropReasons` sum equals `dropped`; both freeze together at the safe-integer ceiling. I/O/publication failures still use the independent `failures` counter (corruption uses `corrupt`), not an invented drop reason. Diagnostic failures release reservations where applicable and remain fail-open: model status/body, retries, RPM, lease completion, statistics and shutdown stay under their existing owners. Error-only capture distinguishes `no-response` from `stream-transport-failed`, and never turns client cancellation into a failed attempt. The fixed cause mapping and authenticated health projection are specified in `logging-guidelines.md`.

## Filesystem and Resource Failures

Detailed storage validates path identities and file types, refuses symlinks, serializes mutations, and maps unavailable operations to safe 503 responses. Missing/cleared/expired bodies are ordinary safe 404s. Corrupt or unknown operator-owned entries are preserved rather than deleted or repaired into apparent success.

Bound every error-prone input and diagnostic operation: request bodies, detail bodies, SSE events, filters, cursors, account fields, queues, work scans, timeouts, and retained bytes all have explicit limits in the quality/logging specs. Ordinary error reasons are redacted before their 16 KiB UTF-8 cap; serialized rows, pending record count and pending bytes have independent admission fences.

SIGTERM/SIGINT shutdown is idempotent and deadline-bound: stop listening/new quota work first, keep diagnostic stores open while active response finalizers run, then fence and drain ordinary/detailed stores. The existing `destroyRuntimeConnections()` destroys inbound sockets and pooled direct/proxy agents after normal drain or on deadline expiry; only the deadline path forcibly interrupts active responses. `DetailedLogStore.close()` drains admitted work and rejects later publication while releasing its reservation.

## Common Mistakes

- Catching every JSON read error and writing defaults, which destroys operator data.
- Returning `error.message`, upstream JSON, paths, credentials, request bodies, or proxy URLs without redaction.
- Treating cancellation or SSE downstream `write(false)` backpressure as network failure and applying cooldown/ban/backoff; accepting comments as a reason to extend first-data admission.
- Synthesizing an early stream error on `aborted` before Node reports the native terminal error.
- Updating runtime configuration before its atomic write succeeds.
- Swallowing a cleanup failure while claiming clear succeeded.
- Closing log stores before active chat/stream finalizers can enqueue their terminal records, or awaiting a blocked writer without a shutdown deadline.
- Treating `resource-limited` or `dropped` as a failed chat/absent manifest, counting every limited body separately, or relabelling a disk error/corrupt entry as a resource drop; these are independent diagnostic signals.
- Retrying through direct transport after a configured proxy fails.
- Matching scoped rules against successful output, raw unbounded bodies, or pre-redaction diagnostics; or allowing unmatched defaults to create cooldown/quarantine.
- Letting a matched retry rule mutate provider/account health by itself, or replaying the request after a `retryStop` decision.
- Faking an upstream `429` (or an error rule, account switch, or health sample) for a local RPM block, or refunding an RPM permit after `req.end()`.

## Required Tests

Use temporary `DATA_DIR` and local endpoints. Relevant changes must assert:

- malformed persisted JSON fails startup and preserves exact bytes;
- invalid management payloads return 400 before writes/upstream work;
- authentication and unknown-resource statuses keep stable safe shapes;
- write/rename/read/cleanup failures preserve prior durable state and expose no raw error;
- proxy/network/timeout/upstream statuses remain correctly classified and redacted;
- local SSE mocks distinguish an admitted stream's upstream idle timeout from first-data wall timeout and downstream heartbeat; comment-only wait and oversized prelude produce bounded pre-response errors, an initial data error after a prelude still retries without exposing that response, and post-start error/cancel does not replay;
- a real `res.write(false)` under a paused client drains to `[DONE]` with one successful request row, no fake `499`, and one lease release; upstream error, timeout and cancellation clear heartbeat/drain listeners;
- client/stream cancellation releases resources exactly once and does not mutate health/backoff incorrectly;
- logging enabled/disabled returns byte-equivalent model traffic despite capture/storage failures; detailed-store/capture fixtures additionally assert one fixed drop bucket per existing rejection (one per root with multiple limited bodies), `sum(dropReasons) === dropped` including saturation, and independent `failures`/`corrupt` across publication errors, while local stream/cancellation fixtures preserve the original status, RPM and lease lifecycle;
- response-complete shutdown drains terminal ordinary/error-detail records, while a permanently blocked writer converges at the configured deadline;
- canonical rule scope/action/applicability/status/body-ANY/Header/reset/first-match/default behavior and non-stream/pre-stream/post-start/cancellation boundaries leak no matched sensitive text;
- a `retryRules` stop blocks remaining Provider attempts and account replacement before the first byte while preserving the terminal status/body, applies to HTTP-200 error envelopes and pre-stream SSE, performs no replay after SSE start, adds no cancellation side effect, and leaves the previous continue behavior intact when `retryRules` is empty;
- strict `retryRules` validation rejects unknown/missing fields, a non-`stop` decision, duplicate IDs, invalid status/body conditions and oversize arrays without rewriting config bytes, while a client that omits the field preserves the stored value;
- a same-account Provider retry that cannot claim an RPM permit returns a local `429` with window-derived `Retry-After`, creates no upstream attempt/error rule/account switch, and preserves the earlier real failure's `upstreamStatus`/error row; a pre-`req.end()` failure releases the reservation and wakes waiters, while a post-`req.end()` failure/timeout/cancellation never refunds it (`test/integration.test.js`: `provider retries commit one permit per real req.end and stop locally with a truthful local 429`, `a pre-send failure releases the RPM reservation while a post-send failure never refunds`, `a client cancellation after the attempt started never refunds RPM`).

Run focused tests, then `npm test`, syntax checks, and `git diff --check`.
