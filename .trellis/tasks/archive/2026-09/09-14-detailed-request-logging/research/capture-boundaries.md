# Detailed logging: capture boundaries and storage research

## Basis and scope

Planning research against the supplied checkout (source baseline: `dd3cfc0`). `task.py current --source` resolved `09-14-bulk-account-concurrency`; this artifact concerns sibling R1 only. Read the detailed-logging PRD and backend logging, quality, and persistence specs. No application/configuration changes, real configuration/metadata/credential reads, external requests, git mutations, or test execution were performed. References below are source evidence, not claims of runtime verification.

Approved constants: default-off persisted switch, request-start enablement snapshot, model traffic including console tests/probes, credential-redacted headers/bodies, 5 MiB per captured body, independent seven-day/1 GiB storage and clearing. Management/config/log/static traffic remains excluded.

## Source map: initiating requests and actual outbound calls

| Evidence | Capture consequence / recommendation |
|---|---|
| `server.js:1351,1706-1716,2142`: three POST chat aliases; request UUID allocated before `readBody`; JSON/model/message validation can return before `record()`. | Establish a scoped context before body reading and validation; reuse its UUID for ordinary chat logging. Capture errors from router catch (`2144-2145`) too. `record()` alone is not an ingress/response hook. |
| `server.js:1555-1568,1573-1667`: nonstream `runChatChain → attemptOnce → clineRequestJSON → clineRequest`; streaming chain calls `clineRequest` directly at `1597`. Provider attempts are explicit; account replacement loop at `1739-1767` permits one replacement. | Allocate an actual-call ID at transport invocation, not from final trace length. Preserve root ID, account/provider attempt facts, original and rewritten bodies separately. |
| `server.js:1910-1935`: `/api/test` builds a synthetic prompt and calls `runChatChain`, returns its own summary, and only records success ordinarily. | Capture console input/final summary and every generated model call; don't confuse console input with upstream prompt. Include validation, busy and failure responses. |
| `server.js:1904-1908,780-803,752-758`: `/api/probe → probeModel → accountFetchJSON`; may generate an additional deliberately failing provider-harvest chat call. `pickAccount()` runs again for harvesting. | Both actual chat calls belong to one root; record actual selected account per call rather than assuming one account throughout a probe. |
| `server.js:2101-2107,862-893`: `/api/validate-upstreams` executes model tests in batches of five via `accountFetchJSON`, swallowing network failures into summary categories. | Allocate call IDs before concurrent work; capture transport failure before it is reduced to `network error`. |
| `server.js:2060-2087`: `/api/accounts/test` accepts an unsaved key/proxy and generates a model call through `accountFetchJSON`. | This is a test exception to management exclusion, not permission to log account saves. Redactor must include supplied ephemeral credentials, not only saved accounts. |
| `server.js:1970-1986`: `/api/accounts/proxy-test` accepts a proxy override and directly calls `clineRequestJSON` with a minimal model request. | Include this model probe and sanitize override credentials even though no `account` is passed into the transport. |
| `server.js:2135-2140,1859-1864`: `/models`, `/v1/models`, `/api/v1/models` expose a catalog; optional cache miss calls `fetchJSON(upstreamBase + '/models')`. `/api/models` also calls `catalog()` (`1892-1902`) but returns routing/config metadata. | Distinguish model API responses from excluded configuration console responses. Do not globally instrument every `/api/*` response. Catalog inclusion needs an explicit design classification, not accidental global fetch capture. |
| `server.js:693-711,796-802,897-931,2109-2111`: probe enrichment uses OpenRouter catalog/endpoints; official discovery calls Cline recommended models, models.dev and documentation. `1253-1298` is independent quota refresh. | These are catalog/document/background calls, not model inference. Recommend excluding background quota and public discovery; document whether probe-triggered enrichment is part of “every actual upstream call” within the root rather than silently expanding scope. |

**Retry finding:** `fetchJSON` at `server.js:678-689` contains exactly one `fetch`, body read and timer cleanup—no hidden application retry loop. `accountFetchJSON` at `672-676` likewise performs one native request. Current inference retries are explicit provider/account loops. Native fetch may follow redirects, and provider gateway fallbacks are not locally observable HTTP calls; do not invent records for those as if directly captured. If catalog fetches are included, define whether redirected HTTP hops need representation; this source offers no per-hop capture hook. No external service investigation was performed.

## Capture and finalization seams

### Evidence

- `server.js:1207-1235`: native HTTP/HTTPS transport assembles final headers (including Content-Length), creates the proxy agent, invokes `lib.request`, then exposes upstream status, headers and `IncomingMessage`. This is the common account model-call seam; capture intent before URL/agent/request setup so synchronous setup failures are represented. Capture here occurs before JSON parsing/unwrapping discards raw upstream content (`1558-1565`). These are Node-visible headers, not guaranteed byte-identical wire headers added by Node/proxy internals.
- `server.js:1237-1250`: `streamToString` already fully buffers nonstream responses; its optional size limit destroys the real stream. **Do not reuse that limit as the diagnostic 5 MiB limit.**
- `server.js:1332-1346,1602-1631`: SSE head consumption precedes both error normalization and downstream delivery. Rejected SSE heads join the remaining response for fallback parsing; successful heads are returned separately. A tap only at `1811` misses heads and rejected attempts.
- `server.js:1777-1816`: successful SSE writes `streamHead`, then pipes through the existing observer Transform. Finalization is idempotent across flush/error/downstream-close, releases the lease, and classifies `[DONE]` versus cancellation with upstream errors taking precedence.
- `server.js:1831,1841-1846`: final nonstream response is `safeOut`, not raw upstream JSON. `sendJSON`/`sendBusy` (`1850-1856`) and router catch are additional final-response seams.
- `server.js:1354-1404`: input cap is 50 MiB; declared oversize can reject before reading body, otherwise reader drains promptly after crossing the cap. Existing reader has no separate `aborted` handler.

### Minimum recommended shape (Node-native)

1. Use explicit optional request context passed through these existing functions; no new framework/interface is needed. Snapshot mode at ingress so toggles do not split an in-flight request. Generate root/call IDs with existing `crypto.randomUUID()`.
2. Capture request bytes inside existing consumption; capture each native response before the SSE head/read/pipe split without creating a second flowing consumer. Reuse the existing Transform pattern, preserving pause/backpressure/error/abort behavior. Never use an unbounded parallel `data` listener or read the response twice. If an inserted Transform is used, explicitly retain destruction/error propagation to the original upstream stream.
3. Bound copied Buffers by bytes, not JS string length; avoid retaining a huge backing Buffer via a tiny `subarray`. Decode with Node `StringDecoder` or one bounded concatenation, accounting for UTF-8 boundary cuts. Keep forwarding every original chunk after the capture limit. Do not change SSE observer's independent 64 KiB event parsing limit.
4. Record downstream bytes submitted to response writes separately from upstream bytes observed; delivery is not proven by `write()` or `finish`. Observe response finish/close with one guarded detail finalizer and retain existing outcome semantics unchanged. Capture state should distinguish complete, truncated, interrupted, redaction-incomplete and persistence-failed. A declared-oversize rejection has an unread body, not a complete empty body.
5. Keep detailed finalization failures out of lease/statistics/response control flow. Bound aggregate capture/write queues as well as individual bodies: five concurrent validation calls alone can retain many 5 MiB captures. If resources prevent capture, expose incompleteness rather than delaying or truncating model traffic.

## Sensitive-data policy: separate projector required

**Evidence:** `logging-guidelines.md:13,87-99` forbids all header values, prompts, sessions and response bodies in ordinary logs. `quality-guidelines.md:118-120` and `database-guidelines.md:159` repeat the persistence prohibition. R1 approves a narrowly scoped detailed-store exception; it does not relax ordinary JSONL or metadata.

`server.js:1514-1523` redacts configured account/admin keys, complete proxy URLs/components, *all* custom Header values, all HTTP-like URLs and Bearer tokens. `safeReason` (`408-418`) also flattens newlines and removes message text supplied by `sensitiveMessageValues` (`420-426`). Reusing these functions unchanged for detail bodies would destroy approved ordinary headers, prompts, formatting and ordinary URLs. Conversely, they do not reliably cover arbitrary Cookie/API-key values or unsaved account-test credentials.

**Recommendations:**

- Add a detail-only credential sanitizer; leave ordinary `record()` projection and reason sanitization untouched (`1041-1070`). Document the detailed-store exception explicitly in the specs.
- Case-insensitive credential header redaction must cover Authorization, Proxy-Authorization, Cookie, Set-Cookie and API-key/token credential names. Sanitize credential-bearing URL userinfo/query fields and structured JSON credential fields, plus known credential values echoed anywhere in response bodies. Snapshot request/attempt credentials, including unsaved key/proxy overrides and incoming credential headers, so config rotation mid-request cannot defeat redaction.
- Redact before any file, queue exposed to APIs, or error reporting; do not spool raw plaintext to temporary disk for later cleanup. Preserve body formatting where safe. Do not pass raw parser/transport/storage errors to service logs.
- Chunk-local regex replacement is insufficient: credentials can cross chunks, JSON escapes, SSE fragments, or the 5 MiB truncation boundary. A bounded prefix may be invalid JSON or end halfway through a credential value. Design a conservative bounded sanitizer and explicit incomplete/omitted state when safe rendering cannot be guaranteed; test it before claiming credential-free capture.
- Ordinary session headers/messages are retained only under the approved detail exception; HMAC routing fingerprints and whole account objects are not capture content. Render arbitrary text with text nodes/`textContent`, not HTML; copy only sanitized content returned by the authenticated API.

**Unresolved security risk:** No existing helper proves universal credential recognition inside arbitrary free text/binary/escaped partial bodies. Specify supported representations and safe fallback; do not claim that a denylist identifies unknown secrets. Response bodies can legitimately contain credential-shaped fields, which still require redaction under R1.

## Is `JsonlLogStore` suitable for independent 1 GiB bodies?

**Conclusion: not unchanged.** Reuse its file modes, test techniques and simple serialized mutation idea, not its whole-store body algorithm.

| Source evidence (`lib/jsonl-log-store.js`) | Implication |
|---|---|
| `12-26,125-136`: synchronous read/parse of every file; queries sort all parsed records; compaction serializes them again. | A 1 GiB disk store can require several times that memory and block traffic on browsing/startup/cleanup. Query limit 200 limits output count, not memory or body-response size. |
| `30-37`: every prefix except literal `errors` deduplicates solely by requestId. | A `details` prefix with root/call/update records silently collapses distinct records on compaction. Identity must include kind/call ID or use separate immutable unique IDs; root correlation is not storage identity. |
| `73-88`: combined enforcement hardcodes requests/errors. | It cannot enforce an independent detailed budget; changing its existing budget/prefixes risks ordinary retention. |
| `115-123`: Promise queue holds records; sync append; errors caught and reported but append resolves. | Unbounded queued bodies; no caller-visible persisted/failed result. Not enough for visible capture failures. |
| `103,121,125-132`: age cleanup only startup/every 100 appends, not on query/timer; trims by read order. | Idle expired records remain visible; no strict seven-day guarantee. Completion/file order is not necessarily initiation timestamp order. |
| `40-69`: rewrite creates replacement files before deleting old ones. | Crash overlap is tolerated by dedupe, but temporary disk usage may exceed budget; this is not a transactional/fsync durability guarantee. A single JSON line may exceed segment target. |
| `176-178`: clear queues existing-file unlink only. | Single-process synchronous operations do not interleave mid-unlink, but a previously initiated request can append after clear and resurrect old-root details. Separate queues/cleanup operations lack one shared semantic fence. |

**Minimum recommended alternative:** one dedicated directory; small metadata-only listing/index with immutable bounded per-call/body files read on demand, using native `fs`/`fs.promises` and server-generated validated IDs. Keep bodies out of in-memory listing scans. Serialize append/publication/retention/clear through one owner; atomically publish sanitized complete files from mode-0600 temporary files in a mode-0700 directory. Account for encoded body sizes, metadata and temporary reservations under the combined 1 GiB budget. Evict oldest detail records before admitting more data, with startup recovery and periodic/query-time expiry. Mark evicted attempts explicitly if retaining their root group; never show an apparently complete group with missing children. Do not add a new database dependency merely for this feature.

Use a clear generation captured at request start: clearing advances it and prevents late writes from pre-clear roots. Scope filenames strictly to server-generated IDs and keep API cursors out of filesystem paths. Handle read-versus-eviction/clear as an intended missing record, not a leaked path or server crash. Report persistence failure through safe store health/status even when disk failure prevents writing an error record. Decide crash recovery for open roots and orphan temporary files before implementation.

For the toggle, reuse `atomicWriteJson` (`server.js:69-78`) but commit runtime state only after successful persistence, or restore it on error; existing mutate-then-save routes are not a sufficient failure contract. Existing-file permissions are preserved, not forcibly repaired (`database-guidelines.md:169-176`). No toggle should invoke account draft persistence.

## Executable validation anchors (existing support, not executed here)

- `node --check server.js` and `node --check lib/jsonl-log-store.js`: syntax-only, no server/config access.
- `node --test test/jsonl-log-store.test.js`: tests at lines 10, 33, 45 exercise temporary directories, small byte/age limits, restart, damaged tail, independent clear, combined oldest eviction, equal-root attempt pagination. These do **not** prove 1 GiB scalability, body identity, failure visibility, interrupted rewrite recovery or in-flight clear fencing.
- `test/integration.test.js:74-85` supplies isolated `DATA_DIR` and local server startup; `13-71` raw HTTP/paused oversize helpers; `90-103` disconnect helper. Environment is inherited, so future execution should clear credential override environment variables and retain only local mock upstreams.
- Focused command: `node --test --test-name-pattern='API compatibility|account routing, header boundary|new scheduling modes|all explicit usage' test/integration.test.js`. Anchors: `116` validation/unsupported Responses/DONE-close/cancel; `190` provider/account retries, SSE heads/errors, headers/redaction and prompt 413; `688` ordinary independent logs; `903` exactly-once usage across retries/streams. Local proxy regressions begin at `736,756,773`.
- `node --test test/ui-contract.test.js`: existing navigation/accessibility assertions (`7,26`) require updating for the independent details entry; source-regex tests alone do not prove safe DOM rendering, clipboard behavior or draft preservation.

Minimum additions in those harness styles: enabled/disabled and restart toggle matrix; every listed model-test route and actual-call count; 5 MiB−1/exact/+1 byte cases with split UTF-8, credentials and SSE boundaries; upstream raw versus final transformed JSON; failed/retried/cancelled partial captures; malformed/declared-oversize input; byte-for-byte forwarding equivalence; no capture for excluded routes; credentials absent from APIs, files and service errors; small injectable retention budgets and clock; clear during active stream/queued write; disk/rename failure; bounded listing memory and on-demand body reads. Existing suites are regression anchors, not evidence that detailed capture already works.

## Planning risks to close

1. Explicitly classify catalog/model-list and probe-enrichment calls, plus authentication rejection/unsupported-model API ingress, in the route matrix without expanding beyond approved model traffic.
2. Specify safe handling of partial/malformed/binary body redaction and cap-boundary secret fragments.
3. Specify group eviction/clear generation/crash recovery semantics and how an unwritable store exposes failure.
4. Budget aggregate memory, pending writes and temporary disk bytes; per-body 5 MiB alone bounds none of these.
