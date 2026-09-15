# Detailed Logging Design

## 1. Boundary and Reuse

Implement after bulk concurrency and the raw editor. Read `research/capture-boundaries.md`; the parent verified the native transport, single-fetch helper, redaction and test/probe routes against source. No external service behavior is assumed.

Keep ordinary `record()` projections, `JsonlLogStore`, metadata, statistics, account selection and retry policy intact. Reuse native HTTP/HTTPS, `Transform`, `crypto`, `fs`/`fs.promises`, `AsyncLocalStorage`, existing authentication and atomic configuration writing. No new dependency or generic logging framework.

Two focused modules are sufficient: `lib/detailed-log-capture.js` owns bounded capture/redaction/request context; `lib/detailed-log-store.js` owns detailed files, publication, query/retention/clear. They are concrete functions/store implementations, not an interface/factory hierarchy.

## 2. Reviewed Route Matrix

The root allowlist must be explicit, never all `/api/*`. This is the concrete interpretation to review before implementation:

| Initiating request | Client side | Locally observable upstream calls |
|---|---|---|
| POST three `CHAT_PATHS` aliases | Headers, body, final JSON/SSE/error; reuse `X-Cline-Request-Id` | Every actual chat invocation, including provider retries and account replacement |
| POST `/api/test` | Console input and returned summary, not an invented chat-shaped client body | Each generated `runChatChain` call |
| POST `/api/probe`, `/api/validate-upstreams` | Probe/validation input and summary | Every actual model inference/harvest call, including concurrent validations and intentionally failing probes |
| POST `/api/accounts/test`, `/api/accounts/proxy-test` | Test input/result with ephemeral key/proxy credentials removed | Each generated model test; include credentials supplied outside saved accounts in the secret snapshot |
| GET `/models`, `/v1/models`, `/api/v1/models` | Model-list request and final response | Only the upstream model-list call actually made for that root on a catalog cache miss |
| POST `/v1/responses` | Existing unsupported-API response; no new protocol behavior | None; preserve immediate authenticated 501 and do not read its body merely to log it |
| Rejection on an included route | Headers and existing rejection response; body is `unread` if existing code never consumes it | None unless a real call was already made |
| Configuration, log APIs, `/api/meta`, static/OPTIONS/other routes | Excluded | Excluded |
| Public documentation/catalog enrichment and background quota/discovery | Excluded, even if initiated while a probe context exists | Not model inference; do not instrument all fetches |

Authentication rejection must not trigger additional body consumption, upstream work, or delayed responses. Read-limit rejection remains prompt. Mark unread/interrupted body capture explicitly rather than inventing an empty complete body. The same applies when a connection terminates before enough data is available.

Provider-gateway internal fallback and network/proxy/TLS frames are not locally observable calls. Capture header values visible through Node's public HTTP APIs; do not promise packet-byte-identical header casing/framing or inspect private `_header` internals. For native fetch model-list calls, annotate redirected/final URL facts safely if exposed, without inventing invisible redirect-hop captures.

## 3. Toggle and Management APIs

Add `config.detailedLogging` as a boolean defaulting to `false`; include the default in `config.example.json`. Missing legacy values remain off; an invalid existing value must not turn capture on through truthiness.

Use a narrow dedicated management route rather than widening existing destructive account or security writes:

```text
GET    /api/logs/settings
  -> { detailedLogging, maxBodyBytes, maxAgeMs, maxTotalBytes, health }
POST   /api/logs/settings
  <- { detailedLogging: boolean }
  -> { ok: true, detailedLogging }
GET    /api/logs/details?limit=&cursor=&requestId=&from=&to=&model=&account=&status=
  -> { items: <metadata-only roots>, nextCursor, health }
GET    /api/logs/details/<requestId>
  -> { request: <root metadata>, attempts: <metadata/body descriptors> }
GET    /api/logs/details/<requestId>/bodies/<bodyId>
  -> sanitized text/plain UTF-8 body; no arbitrary file path parameter
DELETE /api/logs/details
  -> { ok: true }
```

All routes use the existing management `authOK` boundary. Preserve its configured/unconfigured behavior and visibly warn on the details page when proxy/admin authentication is disabled; do not claim protection when no key is configured. Return `Cache-Control: no-store` for detailed data/settings and `X-Content-Type-Options: nosniff` for body responses. Detail bodies are never injected into the static HTML or ordinary log APIs.

POST accepts only a non-array object with exactly one boolean field; reject unknown/missing/coerced values before persistence. Use `atomicWriteJson(CONFIG_PATH, { ...config, detailedLogging: next })`, then update runtime state only after success. Failed writes keep both the old runtime mode and old file. UI disables the toggle during its request, reports failure and restores the confirmed state; it must not call `loadAll()` or save account drafts.

Limits are fixed implementation constants, not new operator configuration knobs. Query limits follow existing 1–200 semantics; filters are allowlisted with strict numeric/time parsing. Cursors encode only validated metadata identity/order, never raw filesystem paths. Invalid IDs/filters return 400; expired/cleared/missing records return a safe 404. Listings return no bodies and perform no body reads.

## 4. Request Context and Capture Seams

Use one native `AsyncLocalStorage` context per included initiating request, avoiding mutable global current-request state and signature propagation through every probe helper. The context contains request UUID, request-start mode/clear generation, bounded metadata and snapshotted credential values. Optional metadata annotations at known call sites supply account/provider/model facts; do not infer actual-call count from final traces.

Enter the context at the HTTP dispatch boundary only when enabled and the route is included. In-flight requests keep their start-time mode; toggling affects new roots. Closed/cleared contexts cannot generate later background captures. Also check method/destination at transport hooks so inherited async context never captures quota or enrichment traffic.

- **Ingress:** Feed bounded capture inside `readBody()`'s existing `onData`/end/error paths. Do not introduce a competing flowing consumer or change the 50 MiB request limit, draining, validation, or rejection timing.
- **Native outbound:** Start a unique attempt before URL/agent/request setup can fail. Observe the exact body sent after alias/provider injection and the final application/header map using public APIs. In `clineRequest()`, place a bounded pass-through Transform before the SSE-head/nonstream consumers. It must preserve pause/backpressure and explicitly propagate original-stream errors, destruction, abort and cleanup; the diagnostic cap never destroys the real stream.
- **Model-list fetch:** The one `fetchJSON` call has no retry loop. Only for an included catalog root/target, record its request and already-read text/headers before JSON parsing; do not instrument public discovery.
- **Downstream:** One request-local wrapper around `res.writeHead`/`write`/`end` observes the response used by all existing send paths, including router catch. Preserve `this`, encodings, overloads, callbacks, return values, thrown errors and backpressure. Merge explicit `writeHead` headers with set headers; do not assume `getHeaders()` sees a writeHead-only map. Prevent double counting when `end(chunk)` internally writes. Record bytes submitted to the response, not a claim that the peer received them.
- **Finalization:** Root and each attempt finalize once on normal completion, abort/error or response close. Existing SSE result/statistics/lease logic remains authoritative; observing `[DONE]` then close stays success, early cancel stays cancellation. Propagate existing safe result facts into detail metadata without copying whole trace/account objects.

Captured bodies have descriptors such as `{bodyId, observedBytes, capturedBytes, truncated, complete, state, redacted}`. States distinguish complete, truncated, interrupted, unread, omitted-for-safety, resource-limited, and persistence-failed. Truncation and interruption can both be true. A failed call with no HTTP response is not a complete empty response body.

## 5. Credential Redaction and Byte Limits

The ordinary `safeReason`/`redactSecrets` implementations intentionally remove messages, custom Header values, ordinary URLs and formatting; leave them unchanged. Add a detail-only sanitizer.

- Snapshot configured account/admin keys and proxy credentials at root start; add actual request/attempt credentials before capture is published, including unsaved test keys and proxy overrides. Config rotation must not expose the old credential through a later response.
- Redact credential Header names case-insensitively: Authorization, Proxy-Authorization, Cookie, Set-Cookie, API-key/access-token/admin-key/secret/credential variants. Keep ordinary Header values. Include individual credential/cookie values in known-secret echo redaction.
- For valid JSON, traverse actual data, replace recognized credential fields and scrub string values for known credentials, Bearer/Basic credential forms and credential-bearing URLs. Retain message text and ordinary URLs otherwise. Displayed JSON may be reformatted after sanitization; it is a diagnostic body, not a replay file.
- For SSE, sanitize complete event payloads, retaining event order and `[DONE]`; never parse with the statistics observer's smaller 64 KiB event limit. For plain text/non-JSON errors, use a conservative textual credential scrubber. Do not assume MIME labels are trustworthy.
- Accumulate at most a copied 5 MiB prefix per body (never a tiny view retaining a huge backing Buffer). Sanitize across chunk boundaries, not independently per chunk. Deal with decoded/escaped credential forms and suffix fragments at truncation; incomplete credential fields are redacted through their boundary/end, not emitted partially.
- Invalid UTF-8/binary data or an ambiguous malformed/partial span that cannot be sanitized safely is omitted with an explicit reason. Never persist raw unsafe data to a temporary file for later redaction, and never fall back to dumping it because JSON parsing failed. Tests must prove the supported JSON/SSE/text boundary cases before this fallback is considered sufficient.
- Cap the final encoded sanitized body as well, since escaping or redaction can expand it. Trim at a valid UTF-8 boundary and mark additional truncation. Track observed versus retained byte counts honestly; unread tails are not counted as observed.

This guarantees handling of recognized credential locations and actual known secrets, not discovery of unknowable secrets embedded in arbitrary prose. Security tests include unknown header credential values, test overrides, JSON escaping and credential splits at the cap. If a required representation cannot be safely supported, stop at the security gate and report the exact limitation rather than silently weakening D4 or claiming complete capture.

## 6. Independent Bounded Storage

Do not put 5 MiB bodies into existing JSONL rows: the current query/compaction implementation loads all bodies synchronously and non-error dedupe would collapse attempts.

Use a dedicated `DATA_DIR/detailed-logs/` directory (0700). Each server-generated root owns a directory with a small metadata manifest and immutable sanitized body files (0600), uniquely named by generated root/call/body IDs. Keep the root timestamp/order separate from attempt completion order. Metadata references capture states/body sizes, not raw account objects or secret snapshots.

A single concrete store owns publication, retention and clear:

1. Write only sanitized bytes to a unique same-directory temporary file, atomically rename, then publish metadata. Use asynchronous file I/O for body work; no synchronous 1 GiB scan, giant JSON response, or whole-corpus rewrite.
2. Account for metadata, encoded bodies, active files and temporary-file reservations under the same 1 GiB budget. Evict oldest root groups before admitting more bytes. Removing a group removes its bodies and manifest together semantically, avoiding a surviving root that falsely claims all attempts are available.
3. An evicted/expired active root becomes capture-disabled and cannot recreate itself on a late completion. Requests keep flowing; safe status/capture metadata reports resource/retention loss where a record can still be represented. Never stall traffic to protect a log record.
4. Enforce seven-day expiry on startup, publication, periodic maintenance and query. Startup removes/ignores orphan temporary files and validates metadata filenames/descriptors without loading every body; open roots from a previous process become interrupted, not successful. Corrupt groups are reported/skipped safely, not converted into fabricated complete records.
5. Clear increments a generation before serialized deletion. Pre-clear roots and queued writes fail the generation check and cannot resurrect records. New-generation requests may create new records after clear; clear is not disabling the switch.
6. Body read racing with eviction/clear returns safe missing state. Only generated validated IDs select paths; refuse traversal/symlink escape. Failed publication cleans up reservations/temp files where possible and updates bounded safe in-memory store health even if the disk is unwritable.

Stream metadata scans or bounded metadata-only indexes; do not eagerly read body files to sort/filter. Pagination is stable by root timestamp and UUID, with stale-cursor behavior documented and tested. Read individual bodies only after explicit selection.

Bound aggregate pending capture/write bytes as well as individual bodies: start with an internal 64 MiB retained-payload budget and a serialized sanitize/publication queue, reserving space before accepting more copies. Count raw/encoded queued payloads and release reservations on every terminal path; JS object/string overhead is separate and must not be described as an exact RSS cap. Limit concurrent materialization, discard only diagnostics with explicit resource-limited status when exhausted, and expose dropped/failure counts. These are internal safety bounds, not new routing limits or user settings.

## 7. Console Integration

Add one mutually exclusive “详细日志” navigation entry and dedicated panel so existing request/error views retain their shared owner and strict projection. Reuse existing button/table/text styles, auth helper and clipboard capability; do not introduce a frontend framework.

The new panel has the persisted mode switch and persistent warnings: prompt/response content is stored, credentials are redacted, 5 MiB per-body cap, seven-day/1 GiB retention, and authentication status. The root list is metadata-only; select a row to load root/attempt descriptors, then load body text on demand. Copy only the sanitized text obtained from the API. No all-body expansion on a 50-row page.

Use independent generation counters for detail lists and selected bodies so navigation, selection, query and clear invalidate stale results. Toggling/reading/clearing must not reload account configuration or erase bulk/raw drafts. Clear requires explicit confirmation naming detailed logs; clipboard errors are announced and selectable text remains available. Use labels, keyboard-operable controls, `textContent`/escaped display, `aria-live`, bounded scrolling, and focus return for any dialog.

## 8. Verification, Rollout, and Rollback

Add focused capture/store unit tests using injectable small limits, clock and I/O failures; black-box integration uses temporary `DATA_DIR`, local upstream/proxy mocks, and cleared credential override environment variables. Compare enabled/off bytes, call order and finalization for all route-matrix rows.

Before considering the feature complete, prove safe partial-body redaction, full-corpus-free listing, aggregate budget behavior, clear/write races, disk failure and actual SSE backpressure/cancellation preservation. See `implement.md` for commands and acceptance mapping.

Rollout is opt-in/default-off and updates no existing log files. Disable the switch to stop new capture; manual clear removes details independently. Rollback removes only this child's application diff and leaves bulk/raw work and existing configuration/logs intact; do not silently delete captured diagnostics or operator configuration. Record the narrow detailed-store/view exception in relevant specs only after validation, retaining ordinary-log prohibitions.
