# Backend Quality Guidelines

> Executable contracts for account routing, upstream transport, and administrative APIs in the small ESM Node server.

---

## Scenario: Account-bound chat routing and trust boundaries

### 1. Scope / Trigger

Use this contract when changing `handleChat`, account selection, provider failover, session identity, the native Cline transport, account error actions, or any authenticated management endpoint in `server.js`.

The safety property is two-level routing: select and lease an account first, then run that account's provider chain. Provider failure must not implicitly select another account.

### 2. Signatures

```js
extractSessionIdentity(req, body)
prepareChatAffinity(body, identity)
forwardHeadersFor(req, body)
acquireAccountLease(identity, { excludeIds = new Set(), allowOverflow = true, ownerRequestId })
strategyRank(mode, accounts)
tryLeaseResult(a, now = Date.now())       // { lease, blockedBy, retryAt }
tryLease(a, now = Date.now())
createLease(account, firstPermit)         // lease.takeRpmPermit() / lease.release()
rpmLimit(account)
rpmProjection(account, now = Date.now())
rpmAvailable(account, now = Date.now())
rpmBlockedRetryAt(account, now = Date.now())
clearRpmState(accountId)
reserveRpmPermit(account, now = Date.now())
selectionBlockFacts(accounts, now = Date.now())
blockedByRetryAfter(blockedBy, retryAt, waitMs)
waitForLease(accounts, waitMs)
claimManagementPermit(lease)              // lease.takeRpmPermit(), or a no-op permit without a lease
resolveModelAlias(requestedModel)
resolveModelConfig(account, resolvedModel)
buildProviderPlan(modelId, cfg, account, now)
healthOrderedProviders(plan, providers)
selectProviderAttempt(modelId, plan, account, attempted, now)
injectPrefs(body, modelId, attempt)
classifyAttemptFailure(result, attempt, account, now)
updateProviderHealth(modelId, upstream, outcome, now)
responseHeadersFor(account, forwardedHeaders)
proxyAgentFor(proxyUrl, { ephemeral = false })
pruneProxyAgents()
readFirstSseEvent(stream, maxBytes = 64 * 1024)
runChatChain(req, body, modelId, cfg, account, forwardedHeaders,
  { stream = false, attemptTimeoutMs = 120000, sensitiveValues = [], attemptOwner = null })
clineRequest(url, { headers = {}, body, signal, timeoutMs = 120000,
  account = null, proxyUrl = "", ephemeralProxy = false })
// response: { status, headers, body, setIdleTimeout(ms), attemptToken, detailAttempt }
normalizeUsage(raw)
createSseObserver(maxBytes = 64 * 1024)
commitStatistics({ ts, modelId, globalError, usage, segments, clientDisconnect })
healthProjection(account, now)
quotaProjection(accountId, now)
statisticsQuotaProjection(account, now)
quotaDemandOutcome(account, source, now)
requestQuota(accountId, { routingEpoch } | { pageToken, force })
createQuotaPageToken()
cancelQuotaPageToken(token)
scheduleQuotaRefresh()
buildPipelineGroups(accounts)
acquirePipelineAccountLease(identity, options)
normalizeErrorRules(value, { strict = false })
normalizeRetryRules(value, { strict = false })
normalizeFailureForRules(errorValue, sensitiveValues)
matchErrorRule({ result, classification, modelId, provider, sensitiveValues })
matchRetryRule(result, sensitiveValues)
settleProviderCircuit(modelId, route, account, attempt, outcome)
```

Chat endpoints:

```text
POST /chat/completions
POST /v1/chat/completions
POST /api/v1/chat/completions
POST /v1/responses  // authenticated, deliberate 501 unsupported_api; never routed upstream
```

Management endpoints relevant to routing:

```text
GET  /api/accounts
POST /api/accounts
GET  /api/statistics
POST /api/statistics/quota-refresh  // exact body: { force: boolean }
POST /api/accounts/recover
POST /api/providers/recover       // exact { model, provider }
POST /api/accounts/proxy-test
GET  /api/models?accountId=<account id>
POST /api/config
POST /api/probe                 // { model, accountId? }
POST /api/validate-upstreams   // { model, accountId? }
POST /api/test                  // temporary complete route overrides; no persistence
GET  /api/model-aliases
POST /api/model-aliases
GET/DELETE /api/logs/requests
GET/DELETE /api/logs/errors
```

Client `proxyKey` (when nonempty) authenticates `/v1/models`, `/api/v1/models`, `/models`, `/v1/responses`, and all three chat-completions aliases via Bearer or the legacy `X-Admin-Key` client header. An empty key retains open model traffic, not open management. `GET /api/meta` remains public. Every other `/api/*` route requires the independent admin Cookie session, except the explicit `/api/auth/{state,session,login,bootstrap,password,logout}` exchange. A client key, Authorization header, or legacy `X-Admin-Key` never authenticates management. Management responses have no CORS wildcard and are `no-store`; unsafe methods require session CSRF header, same-origin checks and JSON for auth exchanges. Direct cleartext management HTTP is permitted only on loopback with a loopback Host; TLS termination requires configured HTTPS `publicBaseUrl`, an exact Host/Origin, `X-Forwarded-Proto: https`, a private/loopback socket peer, and a valid `X-Cline-Pass-Proxy-Token` equal to the independently provisioned 64-lowercase-hex `CLINE_PASS_ADMIN_PROXY_TOKEN`. The TLS proxy replaces both Headers (never forwards client-supplied attestations); a private-network model client cannot assert TLS merely by spoofing a forwarding Header. The application port must not be publicly exposed. Bootstrap requires a separate one-time code and immediate password change; pending sessions cannot use management routes. The route-auth matrix is executable in `test/admin-auth.test.js`.

Existing environment keys are `DATA_DIR`, `CLINE_PASS_KEY`, `PROXY_KEY`, `PUBLIC_BASE_URL`, `PORT`, and `BIND_HOST`. Effective account/security values from `CLINE_PASS_KEY`, `PROXY_KEY` and `PUBLIC_BASE_URL` may be persisted by a later console save; `DATA_DIR` and `BIND_HOST` are not persisted. Connection-pool and SSE timing environment keys are separate, never persisted and enumerated with ranges in `database-guidelines.md`.

### 3. Contracts

#### Account selection and lease

- An available account has a non-empty `key`, `enabled !== false`, no active ban, no unexpired rule cooldown and (when role-aware pool routing is enabled) no `waiting-refresh`/`quota-exhausted` disposition. See the low-quota scenario below.
- `maxConcurrent: 0` means unlimited. Otherwise `tryLease()` increments `activeCounts` synchronously and returns an idempotent `release()`.
- `tryLeaseResult()` returns a structured `{ lease, blockedBy, retryAt }` instead of only a lease. Admission order is fixed: **hard eligibility (caller) → `maxConcurrent` → RPM**. A concurrency block returns `blockedBy: 'concurrency'` without touching RPM; an RPM block returns `blockedBy: 'rpm'` without incrementing `activeCounts`. `blockedBy` is exactly `concurrency` | `rpm` | `mixed` | `unavailable` (`BLOCKED_BY_REASONS`); an account that is simultaneously concurrency-full and RPM-exhausted is `mixed`.
- `single` waits only for the configured active account (or the first statically available fallback).
- `roundrobin` ranks once, skips full accounts, waits up to `concurrencyWaitMs`, and advances `RR_COUNTER` per selection.
- `sticky` with a session fingerprint ranks available accounts by HRW over stable `account.id`. It waits for the first-ranked account, then may use an immediately available lower-ranked account for this request only. It does not store a session-to-account table.
- Sticky without an identity fingerprint uses round-robin.
- `least-connections` chooses the capacity-eligible account with the smallest `activeCount`; ties use round-robin.
- `weighted-roundrobin` rotates over virtual slots derived from `weight` 1-100 and removes unavailable/full accounts before building the cycle.
- `priority-failover` chooses the smallest capacity-eligible `priority` 1-100; ties use round-robin. A full primary immediately falls to the next tier.
- The three new modes wait only when every statically available account is full, and recompute candidates after capacity notifications.
- Selection returns stable diagnostic facts (`strategy`, preferred/selected account, enumerated reason, overflow, session source). These facts may be logged, but the session value/fingerprint may not.
- `runChatChain()` receives one explicit `account`; every provider attempt in that invocation uses that account's Authorization.
- `errorRules` is the only matching source. Each ordered rule has a stable ID, canonical `account` or `provider-model` scope (`credential` is an input alias), `ignore`/`degrade`/`cooldown`/`hard-quarantine`, optional case-insensitive Provider/resolved-model scopes, and AND-composed status, body-contains ANY, and response-Header conditions. Matching uses bounded redacted failure text and request-local bounded Headers; first match is final, including `ignore`.
- Cooldown reset uses an explicit response Header format (`retry-after`, `unix-seconds`, `unix-milliseconds`, or strict `d/h/m/s` duration), strict fallback and max durations, and never guesses units. Missing, invalid, or expired Header values use fallback and the result is capped by max.
- Without an explicit match, clear account auth/quota/proxy failures produce account `degrade`; clear named Provider 429/5xx/network/timeout/unsupported failures produce provider-model `degrade`; parameter errors, ambiguous attribution, unattributed auto, and cancellation produce `ignore`. Defaults never create cooldown or quarantine. Retry classification remains independent from health action.
- Account cooldown/hard-quarantine stops that account chain and permits at most one pre-stream replacement. Provider-model cooldown/hard-quarantine stops only that Provider attempt and remains on the leased account. Post-start actions affect future routing only; client cancellation evaluates neither rules nor health.

Session identity values are validated, HMACed with `META.routingSecret`, and never logged or persisted. The request-local identity also carries only bounded `keyType` and `confidence` enums. Trusted parent identifiers precede child identifiers. Codex checks parent thread metadata/header before `prompt_cache_key`, session, and thread values; Claude checks parent-agent information before session/agent values. Generic parent headers precede generic current-session fields. `X-Client-Request-Id` alone never establishes affinity. The fallback HMAC input contains only the first system/developer message and first user message (each capped at 4096 characters); if neither is extractable, selection falls back to round-robin.

For Chat Completions, a valid caller `prompt_cache_key` or `session_id` is preserved byte-for-byte. When an explicit Codex/Claude identity reached the Switcher but neither body field exists, `prepareChatAffinity()` injects a domain-separated 64-hex `prompt_cache_key` derived from the local fingerprint. A `message_hmac` fallback is never promoted into an explicit upstream key. The derived value is reused across account/provider attempts but never enters ordinary logs, metadata, responses or management projections. A `preferred` route with an explicit singleton-provider plan is diagnosed as overriding remote sticky provider selection; this is a bounded fact, not proof that a remote provider used the key.

#### Account-level RPM admission and callers

`maxRpm` is the canonical per-account limit (integer 0-100000, `0` = unlimited; see `database-guidelines.md`). Protection is one process-local rolling 60-second window per account plus uncommitted reservations. It is never persisted, clears on restart, is independent per replica, and explicitly is **not** a cross-process hard cap. The owner is `rpmWindows` keyed by stable `account.id`; `RPM_WINDOW_MS` is 60 s (only the test environment may shrink it through `CLINE_PASS_TEST_RPM_WINDOW_MS`).

Admission and permit lifecycle:

- `reserveRpmPermit(account)` increments `reservations`, prunes expired committed start times (`<= now - RPM_WINDOW_MS`), then rejects when the live count (`committed + reservations`) exceeds the finite limit, returning `{ ok: false, retryAt }` with the oldest committed start time plus the window.
- A successful `tryLeaseResult()` lease holds the **first** permit. Every subsequent real Provider attempt takes an independent permit through `lease.takeRpmPermit()`; `reserveRpmPermit()` is the only other source. `claimManagementPermit(lease)` is the management-call alias and returns a no-op `{ ok: true, permit: null }` when there is no lease.
- `commit()` turns the reservation into a committed timestamp at the exact point the native transport calls `req.end(data)`; `clineRequest()` calls `permit?.commit()` immediately after `req.end()`, at the same seam as `attemptOwner.onAttemptCommit()`. Once `req.end()` is reached **nothing refunds it**: DNS/connect/proxy/TLS failure, success, HTTP error, timeout and client cancellation all keep the commit.
- A synchronous failure before `req.end()` (URL/agent/request construction, or an already-aborted signal handled before send) calls `permit.release()`: the reservation is returned and `notifyCapacityWaiters()` wakes capacity waiters. `release()` is idempotent and `commit()`/`release()` settle at most once. Releasing the lease also returns any still-pending first reservation.
- Permit bookkeeping fails closed to that account: an exception must not leak `activeCounts` or a reservation.

Counting coverage (exactly one permit per native `POST <upstreamBase>/chat/completions`):

- Counted: the three chat aliases (`/chat/completions`, `/v1/chat/completions`, `/api/v1/chat/completions`), `/api/test`, `/api/probe`, `/api/validate-upstreams`, `/api/accounts/test` **only when it binds a saved `accountId`**, and `/api/accounts/proxy-test` for a saved account (counted once the request reaches the transport, even if the proxy connect then fails).
- Not counted: `/api/models` and other catalog/document traffic, quota `/users/me/plan/usage-limits` refreshes, and any management request that sends no native chat call. `/api/accounts/test` with a temporary credential and no saved `accountId` has no `maxRpm` owner and is explicitly neither limited nor counted.
- `/api/validate-upstreams` shares one lease across its concurrent batch, but each batched native call atomically claims its own permit. When a permit is unavailable the implemented semantics keep the existing summary shape: that single slug becomes `{ status: 'unknown', localRpm: true, ms: 0, note: 'local account rpm limit' }` and no request is sent — the whole validation request is not converted into a `429`. `harvestAvailableProviders()` behaves the same way and returns `null` when it cannot claim a permit.

Selection, waiting and Provider retries:

- Candidate ranking filters out accounts whose window is exhausted (`rpmAvailable()`); `waitForLease()` and the pipeline selectors recompute after every capacity notification and reuse the existing global `waiters`/`notifyCapacityWaiters` and the `concurrencyWaitMs` deadline. No refill timer, queue or per-account waiter is created. The wait target is `min(deadline, earliest retryAt)` through `waitDurationForBlock()`.
- Initial selection skips an RPM-exhausted candidate in favour of another eligible account, and only when every candidate is blocked returns `busyFailure(blockedBy, retryAt, ...)` with a truthful `blockedBy`/`retryAfter`. `selectionResult()`/`busyFailure()` never expose candidate internals.
- Inside one leased account a Provider retry that cannot claim a permit does **not** wait, does not send an attempt, and does not switch accounts: `runChatChain()` sets `localRpm` and breaks immediately, returning a local `429` whose `Retry-After` comes from `localRpmRetryAt`. Any earlier real failed attempt keeps its original `upstreamStatus`/error row; the local block fabricates no upstream attempt, error rule or account replacement. Only the existing explicit pre-stream account-removal outcome may replace the account.

Projection:

- `GET /api/accounts` projects `rpm: { limit, used, reserved, retryAt }` from `rpmProjection()`. It contains only finite numbers or `null` and never exposes the timestamps array, `head`, candidate state or a reservation list. `used`/`reserved` are `0` when the limit is `0`.
- Request records project `blockedBy` as the bounded enum (`concurrency`/`rpm`/`mixed`) and `retryAfter` as a bounded non-negative integer (`record()` clamps it to 3600), never window timestamps.

#### Account-level model routing

The implemented account-level model-routing field is `accounts[].perModel`; there is no `modelRouting` field in the persisted or API schema.

```js
resolveModelConfig(account, modelId)
// own account.perModel[modelId] -> complete account route
// otherwise                         -> config.perModel[modelId] or {}
```

Presence is tested with `hasOwnProperty`; even `{}` is a complete account override. There is no field merge with the global route. A normalized route has exactly:

```js
{ upstream, upstreams, exclude, pinMode, sort, maxRetries, providerCooldownMs }
```

`maxRetries: null` runs all built provider attempts; an integer `n` permits the first attempt plus at most `n` additional outer attempts. The cap is applied after durable health planning. `providerCooldownMs` remains an integer 0-300000: when positive it adds a process-local `(accountId, resolvedModel, provider)` circuit used to serialize half-open ownership and may override the short 5xx/network/timeout delay; zero disables only that extra per-account circuit, not the shared model/provider health state. Circuit state contains no session/credential/body and is cleared on account identity changes and route replacement; stale-generation completions update neither circuit nor durable health.

A successful model probe builds its known provider set from the observed `finalProvider`, strict provider slugs harvested from either string or structured error envelopes, documented fallbacks and direct-pipeline endpoint details. Discovery state is distinct from `upstreamStatus`: observing a provider prevents a false zero count but never claims that provider passed pin validation.

#### Single-provider attempt planning and health

- Configured `upstreams` are the authoritative candidate source and source order. A non-empty configured list always overrides the stable discovered `META.models[modelId].upstreams` order; discovered order is used only when nothing is configured; a source that is completely empty is `auto`.
- `buildProviderPlan()` builds one stable per-request candidate snapshot: static `exclude`, durable `hardQuarantined`, and `cooldownUntil > now` are filtered before selection, in that order. `plan.rates` snapshots the Provider-model 24-hour direct success rate and `plan.plannedOrder` is a bounded diagnostic order, not a promise about gateway behavior. An expired cooldown returns to eligibility, and a positive per-account circuit still admits at most one concurrent half-open owner.
- `strict` selects source order on the first real attempt (`providerSelection: "strict-first"`), then excludes every provider already attempted in this request and orders the remainder by Provider-model 24-hour direct success rate descending. `preferred` uses that same health order from the first attempt onward (`providerSelection: "health"`). Unknown rates (`null`) sort after known rates; ties and all-unknown keep source-index order. `selectProviderAttempt()` recomputes the remaining candidate set before every attempt.
- `maxRetries` caps real outer attempts: `maxRetries: null` allows every built attempt, an integer `n` permits the first attempt plus at most `n` more (`plan.maxAttempts = n + 1`), and `attempted` exclusion prevents any candidate from being retried twice in one request.
- Exclusions are applied before health routing. A known source that becomes empty after exclusion returns a safe `503` no-provider error and never falls back to `auto`. If candidates exist but every one is durably cooling or hard-quarantined, routing fails safely with bounded retry information instead of bypassing state. Only a completely empty candidate source allows exactly one unattributed `auto` attempt (`plan.maxAttempts = 1`, `providerSelection: "compat-auto"`).
- Every named attempt injects exactly one provider through `providerOptions.gateway.only` (planner), `provider.only` (direct), or the same singleton in both shapes for an unknown pipeline. `injectPrefs()` deletes any incoming `provider.order`/`gateway.order` and never emits one. `sort` is applied only inside the already-selected Provider (`gateway.sort`/`provider.sort`), never as a cross-provider order.
- A 429 is account-scoped only with a fresh complete 100%-used quota snapshot or explicit structured account/subscription/plan quota-exhaustion semantics. Routing/final-provider or structured provider fields make it provider-scoped. HTML and other ambiguous 429 responses are unknown.
- Unmatched Provider failures no longer create implicit durable cooldowns. Explicit provider-model cooldown/hard-quarantine rules own durable state; the existing positive per-account `providerCooldownMs` circuit remains a separate process-local compatibility mechanism.
- Provider-model state is keyed by `(resolvedModel, provider)` and shared across accounts. Hard quarantine survives restart and success and clears only through exact `POST /api/providers/recover` or identity cleanup. A named real attempt is the only source of provider-model samples; an unattributed `auto` attempt creates no named state or provider-model sample.

#### Request-level retry stop rules

- Canonical top-level `retryRules` is an ordered array of `{ id, decision: "stop", when: { statuses, body_contains } }`. Every entry requires a stable unique ID (the `ERROR_RULE_ID` grammar), an exact `decision: "stop"`, and both `when.statuses` and `when.body_contains`; a missing condition, unknown field, non-`stop` decision, or duplicate ID is rejected.
- `statuses` is a non-empty array of unique safe integers 100-599 (at most 500). `body_contains` is a non-empty string or a 1-20 element array; each needle is trimmed, non-empty, at most 500 characters, control-byte-free, and unique case-insensitively. The array form matches ANY needle and the string form is one needle. Matching is case-insensitive plain substring matching against the same bounded/redacted failure text used by `errorRules`; regular expressions and Header conditions are not supported.
- `matchRetryRule()` ANDs the two condition kinds: a rule matches only when the normalized status is in `statuses` and at least one needle occurs in the failure text. The first matching rule wins and returns `{ ruleId, decision: "stop", matchedBy: ["status", "body"], statusCode }`; otherwise it returns `{ ruleId: null, decision: "continue", matchedBy: [], statusCode }`. A status-only or body-only hit is a miss.
- `settleAttempt()` evaluates the retry rule after attempt settlement, in parallel with `errorRules`. Retry decision is independent from health action: a custom retry rule never changes health by itself, and a paired `errorRules` entry (such as provider-model `ignore`) decides the sample/disposition. The manual console preset writes both atomically.
- A `stop` decision sets `chain.retryStop = true` and breaks the in-account attempt loop, so no further Provider attempt is made on that account and the outer account-replacement branch is skipped. The original terminal status/body is preserved. A pre-stream SSE error event settles through the same path and also stops. After a valid SSE response is exposed (`started: true`) no retry decision is evaluated and nothing is replayed; client cancellation and an exhausted candidate set add no replay either.
- Missing persisted `retryRules` normalizes to `[]` at startup and preserves the earlier continue-on-failure behavior; the paired preset is never auto-seeded or auto-migrated.

#### Header and credential boundary

Protocol allowlists are exclusive:

- Codex: `Originator`, `Session_id`, `Thread_id`, `Session-Id`, `Thread-Id`, `X-Client-Request-Id`, `User-Agent`, `X-Codex-Beta-Features`, `X-Codex-Turn-State`, `X-Codex-Turn-Metadata`, `X-Codex-Window-Id`, `X-Codex-Parent-Thread-Id`, `X-OpenAI-Subagent`, `X-OpenAI-Memgen-Request`, `X-ResponsesAPI-Include-Timing-Metrics`, `X-OpenAI-Internal-Codex-Responses-Lite`.
- Claude: `X-Claude-Code-Session-Id`, `X-Claude-Code-Agent-Id`, `X-Claude-Code-Parent-Agent-Id`, `X-Stainless-Arch`, `X-Stainless-Lang`, `X-Stainless-Os`, `X-Stainless-Package-Version`, `X-Stainless-Retry-Count`, `X-Stainless-Runtime`, `X-Stainless-Runtime-Version`, `X-Stainless-Timeout`, `User-Agent`, `X-App`, `Anthropic-Beta`, `Anthropic-Dangerous-Direct-Browser-Access`, `Anthropic-Version`.
- Generic: `Session-Id`, `Session_id`, `Thread-Id`, `Thread_id`, `X-Http-Session-Id`, `X-Session-ID`, `X-Session-Affinity`, `X-Slot-Session-Id`, `X-Conversation-Id`, `X-Thread-Id`, `X-Parent-Session-ID`, `X-Parent-Session-Affinity`, `User-Agent`, `X-Client-Request-Id`, `HTTP-Referer`, `X-Title`.

Always reject downstream `Authorization`, `Proxy-Authorization`, `Cookie`, `Host`, client `Content-Length`, hop-by-hop headers, `X-Codex-Installation-Id`, and `X-OAI-Attestation`. Account custom Headers are merged after the protocol allowlist and before the system-owned `Content-Type` and `Authorization`. Their names/values are strictly bounded, and credential/session/device/hop-by-hop names are rejected case-insensitively. Custom Headers never participate in session identity extraction. `responseHeadersFor()` always overwrites Authorization with `Bearer ${account.key}`. The native `http`/`https` transport is required for chat forwarding so a missing client `User-Agent` stays missing.

Account keys, proxy URLs/authentication, Header values, and notes are intentionally static account configuration in `config.json` and are returned only through authenticated account administration. They must not appear in `metadata.json`, ordinary JSONL logs, traces, error bodies, or diagnostic headers. Raw sessions, HMAC fingerprints and message text remain forbidden in these ordinary projections; only `sessionSource` and applied safe Header names may be recorded. The separately opt-in detailed store may retain sanitized model HTTP content and ordinary headers/session values under `logging-guidelines.md`; it never permits raw credentials, whole account objects or HMAC fingerprints, and does not relax the ordinary exclusions.

#### Account proxy and model alias boundary

- Empty `proxyUrl` selects the process-wide native `http.Agent` or `https.Agent` (both `keepAlive: true`, `scheduling: 'lifo'`, 256 max sockets / 32 max free per agent by default, bounded runtime overrides). `http:`/`https:` use `HttpsProxyAgent`; `socks5:`/`socks5h:` use `SocksProxyAgent`, each explicitly keep-alive with 32 max sockets / 2 max free by default. Agent socket idle timeout is 60 seconds; reuse still depends on the peer keeping the connection open. Do not substitute `fetch` or global Agent defaults for `clineRequest()`.
- `proxyAgents` caches only URLs referenced by persisted accounts and stops at 128 URLs. Excess/new non-persisted URLs get disposable agents rather than enlarging the cache; saving account changes calls `pruneProxyAgents()` to destroy stale agents before removal. `/api/accounts/proxy-test` always passes `ephemeralProxy: true`, even for a saved URL; its agent is destroyed on response end/close, setup failure, or abort and never enters the cache. The in-flight request retains its agent until settlement; do not destroy it just because response headers arrived.
- The account proxy applies to account-bound Cline chat/probe/validation/test and quota-upstream traffic. Probe and validation accept an optional account ID, lease that account once, and keep probe+harvest or the whole validation batch on it; unknown/unavailable/busy accounts return 400/409/429. Public catalog/document fetching and ordinary management APIs remain direct.
- A configured proxy failure is a proxy/network attempt failure and never retries the same request without an agent.
- `requestedModel` is preserved for diagnostics. `resolvedModel = modelAliases[requestedModel] || requestedModel` replaces outbound `body.model` and owns global/account `perModel` lookup. Aliases are not chained.
- `/v1/models` exposes the de-duplicated union of original visible models and aliases so old clients remain compatible.

#### Chat input boundary

- Chat Completions validates the top-level JSON object and model identifier locally, but deliberately does not validate or normalize `messages[*].content`.
- Empty strings, whitespace-only strings, `null`, missing content, empty arrays, empty multimodal parts, and empty tool results pass through unchanged. This preserves compatibility with clients that represent a successful no-output tool call as `""` or `"\n"`; the upstream owns message-role/content schema acceptance.
- `messages: []` remains compatible.
- `POST /v1/responses` returns authenticated `501 unsupported_api` directing callers to `/v1/chat/completions`, without reading/routing the payload or acquiring an account.

#### Abort and SSE lifecycle

- The native HTTP/1.1 server sets `keepAliveTimeout = 95_000` ms and `headersTimeout = keepAliveTimeout + 5_000` ms by default. This is the *between-requests* idle window (slightly above New API's documented 90-second pool idle), not a stream duration or replacement for the existing 50 MiB body limit. Do not require newer Node-only `keepAliveTimeoutBuffer`.
- A direct client socket close aborts the active upstream request. If New API keeps its ordinary Chat upstream request open after its own final client disconnect *before* Switcher returns headers, Switcher cannot observe that final client; the first-event deadline bounds residual work but does not make cancellation immediate.
- Non-stream attempts retain the bounded 120-second default attempt timer. Streaming uses a 120-second wall deadline from attempt start through response headers and the first complete valid `data:` event; comment/metadata bytes never extend it. `clineRequest()` initially sets the native request timeout and returns `setIdleTimeout(ms)` so that, after acceptance, `runChatChain()` clears the first-event timer and actually replaces the active socket timeout with the 360-second upstream idle limit. Downstream heartbeats do not reset this upstream idle timer.
- `readFirstSseEvent()` buffers no more than 64 KiB of prelude and first event: retain comment-only/empty events and `event:`/`id:`/`retry:` metadata until a complete event with `data:` arrives; pass through the raw prelude and first event. Bytes following that event in the same chunk go back to the paused response via `unshift()` in order. A first `data:` error is classified/retried before committing SSE headers. A rejected head (including comment-only overflow) destroys its upstream response immediately; never wait for an unbounded tail. No downstream heartbeat precedes acceptance.
- After the first legal data event has been submitted downstream, the single stream-local `Writable` owns upstream forwarding, the SSE observer and heartbeat writes. With no upstream bytes for 25 seconds (default), it writes `: PING\n\n` only at a complete SSE event boundary; any upstream chunk resets the heartbeat timer, and a partial data line/event suppresses injection rather than corrupting model data. `res.write() === false` pauses further upstream forwarding and extra heartbeat until `drain`, not a client cancellation. A write throw or socket error/close is terminal. Clear heartbeat and drain listeners on every terminal path. The upstream observer never sees generated comments, so usage, DONE, errors, health, attempts and RPM are unchanged.
- Only accepted stream output is eligible for heartbeat; `CLINE_PASS_SSE_HEARTBEAT_MS=0` disables it. New API's scanner resets its own idle window on comment lines before ignoring them as model chunks; Switcher's comments keep only New API ← Switcher alive. Final-client idle protection requires New API's separate existing downstream ping setting.
- After a valid SSE response is exposed (`started: true`), the request is never replayed. Clean completion recovers the named provider and releases any half-open owner; a later classified SSE error updates future provider/account state only.
- The SSE observer records a complete `data: [DONE]` event. A downstream close after `[DONE]` finalizes once as `200 / success`; a close before `[DONE]` finalizes once as `499 / client_cancelled`.
- An observed SSE error or upstream transport error takes precedence over `[DONE]` and remains a real failure. A client cancellation creates no error attempt, usage, error statistic, health result, account action, or provider-health update.
- The account lease stays held until normal stream flush, upstream error/idle timeout, or downstream close. Stream finalization, timer/drain listener cleanup, statistics submission, provider settlement and lease release are idempotent. Existing `shutdown()` stops intake/quota work, waits for active response finalizers while logs remain open, then drains both stores; `destroyRuntimeConnections()` destroys inbound sockets and direct/proxy agents after successful drain or at the deadline (force path). Do not add another exit coordinator or close logs before active finalizers.
- Detailed capture, when enabled, observes native responses before SSE-head consumers with a single pass-through Transform and two-way destruction propagation. Use native `stream.finished(source, { readable: true, writable: false }, callback)` to observe terminal source errors: `aborted` may precede Node's actual `error`, and synthesizing an earlier error changes downstream error bodies with logging enabled. Preserve the native error object/code (`ECONNRESET`); a silent premature close still terminates the tap with `ERR_STREAM_PREMATURE_CLOSE`. The 5 MiB capture cap never becomes a traffic limit; asynchronous store publication is not awaited here. Preserve downstream write/end/writeHead overloads/return values and explicitly carry the detail root into chat result recording because close callbacks may run outside the originating AsyncLocalStorage context. The request-local native-chat owner assigns monotonically increasing `attemptIndex` plus UUID `callId` only after `req.end()`; capture profiles consume the token and never own ordering. See the detailed logging contract for route exclusions and failure states.

#### Usage, statistics, and health

- One request-scoped idempotent finalizer owns statistics commit. Each accepted chat increments the global aggregate and the post-alias resolved-model minute aggregate once, and each participating account ID appears at most once in that request's account segments. Provider retries and account replacement do not duplicate model usage. Statistics mutation and final record/model-metadata mutation share one terminal `saveMeta()` for an ordinary chat; management writes and explicit durable disposition actions retain their existing persistence boundaries.
- Only explicit normalized upstream usage counts. `0` is known; a missing/invalid field is `null`; input, output, total, cache, or cache ratios are never inferred from another field. Model cache Token ratio is likewise computed only from explicit input/cache pairs.
- Non-stream JSON reads its terminal usage object. Streaming retains only the last cumulative usage snapshot while incrementally observing SSE events. Each event is bounded to 64 KiB; an oversized event is discarded through its CRLF/LF boundary, then observation resumes for later events.
- Management, probe, model-catalog, and quota traffic never enters chat statistics or health.
- Rule actions map to direct health samples exactly (`SAMPLE_FAILURE_ACTIONS = {degrade, cooldown, hard-quarantine}`): `ignore` writes 0 samples and no disposition; `degrade` writes 1 failure sample; `cooldown` writes 1 failure sample plus a temporary skip; `hard-quarantine` writes 1 failure sample plus durable quarantine. An account-scope action writes the account sample and a provider-model-scope action writes the `(resolvedModel, provider)` sample.
- Account health is request/account-deduplicated with failure precedence: any account-scope `degrade`/`cooldown`/`hard-quarantine` sample wins for that account in the request; otherwise only an account that obtains final success receives one success. Provider-model health records at most one sample per named real attempt. Stale-generation completions, management traffic, an unattributed `auto` provider attempt, and client cancellation write no sample. An `auto` request that succeeds still records one account success sample, because the account dimension has no named provider attribution.
- Both dimensions expose the rolling 24-hour direct rate `successes / (successes + degrades)`, counts, sample count, and coverage. One sample is sufficient; zero samples is `null`, never numeric zero. Disabled, cooling, and hard-quarantined are independent disposition fields; there are no available/degraded/unhealthy thresholds.
- `GET /api/statistics` is authenticated and returns projected global/account lifetime and 1,440-minute aggregates, plus per-resolved-model rolling aggregates with model tracking/cell-loss coverage, health, quota, and a separately labelled legacy migration baseline. Fixed aggregates also count explicit/fallback affinity, provider fallback, circuit cooldown and half-open requests; `routingCoverage` labels the migration/start minute so pre-tracking history is not fabricated as zero. They never store identity values or high-cardinality provider/session keys. `GET /api/accounts` embeds a stable-ID account statistics summary for the main table while retaining the legacy name-keyed `stats` projection only for old clients. Neither endpoint returns credentials, raw events, messages, sessions, or raw quota responses.

#### Quota refresh and account pipeline

- Routing-owned refreshes and statistics-page refreshes share one FIFO admission pump. Every actual `/users/me/plan/usage-limits` transport uses the account proxy without direct fallback, has a 15-second absolute deadline, caps the body at 256 KiB, and occupies one of exactly two global slots until the native response settles. Overlapping scheduler callbacks, account saves, tabs and manual requests cannot create a third live upstream call; chat selection never waits for this work.
- `quotaJobs` owns one queued/running promise per account ID. Matching demands join that promise. Cancelled or identity-stale work remains ID-locked and slot-counted until settlement; finalizers may remove only the same job object. Queue admission rereads current account identity, source ownership, cache and backoff rather than retaining arbitrary account payloads.
- A successful partial or complete snapshot is reusable for five minutes from `lastSuccessAt`; a routing snapshot remains fresh only when all three windows belong to the latest successful, non-error attempt and are no older than 15 minutes. Manual `force:true` bypasses only the success cache: backoff, deduplication and the global cap still apply. Each page token snapshots a monotonic per-account success version before body parsing, so a success published after batch acceptance is reused instead of replayed, including across key/proxy rotation. Only true account deletion removes that runtime version.
- `POST /api/statistics/quota-refresh` is an authenticated finite sweep derived from persisted accounts. It accepts exactly `{ force: boolean }`, keeps the response open for the sweep, returns only `{ ok, refreshed, cached, deferred, skipped, failed, cancelled }`, and never writes scheduling configuration. At most 16 page batches may be active; excess requests receive `429` with `Retry-After: 1` before jobs are created.
- Page tokens and the routing scheduler are separate sources. Response/socket close withdraws only that page token; disabling quota routing advances a routing epoch and withdraws only routing ownership. A queued job is dropped and a running job aborted only after its final valid owner leaves. Source withdrawal/invalidation publishes neither success nor failure/backoff state.
- Account generation is independent of routing epoch. Key/proxy replacement and deletion clear the old snapshot; disablement retains last-good display data. All three cancel old-generation work. Publication rechecks ID, enabled/key/proxy identity, generation and at least one live source, preventing disable/re-enable and key A→B→A resurrection.
- Accepted quota rows are only `five_hour`, `weekly`, and `monthly`, each with finite `percentUsed` in 0-100 and an optional RFC3339 reset time. Upstream reset times may use 1–9 fractional digits with `Z` or a numeric offset; impossible Gregorian dates, missing timezones and over-precision are `schema` failures. Accepted values normalize to canonical millisecond UTC before persistence/projection. `statisticsQuotaProjection()` adds safe attempt/success times plus `refresh.{eligible,reason,state,nextAttemptAt}` without exposing credentials, owner tokens, controllers or raw responses. Reading retained/partial/error data never makes it fresh for routing.
- Canonical `accountPipeline` has exactly three booleans, an exact permutation of `quotaPool`, `healthSort`, and `sticky`, integer `cachePoolSize` (minimum), `cachePoolMaxSize` (maximum), `cachePoolLowQuotaSize` (fixed low slots) 0-100000, plus integer `sessionBindingExplicitTtlMs`, `sessionBindingFallbackTtlMs` and `sessionBindingMaxEntries`. Recognized legacy four-step input is accepted and normalized: `excludeUnhealthy:true` folds into `healthSort:true`, and the duplicate step is removed deterministically. With minimum 0 and all booleans false, legacy selection remains unchanged. The dynamic-growth and stateful-binding contracts are owned by the `Dynamic cache-pool growth and stateful session binding` scenario below.
- `healthSort` stably refines account groups by direct account success rate descending, known before unknown, preserving prior order on ties. It never filters accounts and never reads Provider-model success data. Cache-pool membership likewise ignores success-rate fluctuations.
- A positive cache pool is effective only in sticky account mode or with the explicit sticky step. A configured positive minimum outside those conditions is dormant. With `cachePoolLowQuotaSize: 0`, effective membership remains the exact legacy non-`reserve`, priority/ID ordering to the persisted target. With positive low slots, the low-quota scenario below replaces membership and selection ranking, not the target, quota job or lease owners. Success-rate changes never alter membership; no member list is persisted.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Chat JSON is malformed or not an object | `400`; no upstream request |
| Chat `model` is missing, blank, non-string, or over 300 characters | `400` |
| Any `messages.<index>.content` value is empty, whitespace-only, `null`, missing, or an empty array/part | Do not reject or normalize locally; preserve it in the upstream request and return the upstream outcome |
| `POST /v1/responses` | authenticated `501 unsupported_api`; no account/upstream request |
| Request body exceeds 50 MiB | Reject promptly with `413` as soon as the limit is crossed, even if the client pauses before request end; discard/drain the remaining body without buffering or destroying the socket |
| No statically available account | `503` with a redacted error |
| Accounts exist but required capacity is unavailable after waiting | `429`, `Retry-After` integer clamped to 1-30 seconds; the RPM-blocked path is the documented exception — `sendBusy()` clamps it to 1-3600 seconds derived from the earliest rolling-window recovery |
| The RPM window is exhausted for the selected/only candidate | local `429` with `blockedBy: 'rpm'`/`'mixed'` and `Retry-After` from the earliest window recovery (bounded 1-3600 s); no upstream attempt, no `activeCounts` change, and no fabricated upstream 429 |
| A same-account Provider retry cannot claim an RPM permit | stop locally with `429`, preserve the earlier real attempt's `upstreamStatus`/error row, and never switch accounts |
| A management chat caller cannot claim a permit | `/api/validate-upstreams` and provider harvest record that slug as `unknown`+`localRpm` and send no request; `/api/test`, `/api/probe`, and saved-account `/api/accounts/test`/`/api/accounts/proxy-test` return the bounded local `429` |
| Explicit `/api/test.accountId` is unknown / unavailable | `400` / `409` |
| Forwardable client header is blank, over 2048 characters, or contains a control byte | omit it |
| Account custom Header is forbidden or violates count/name/value/total bounds | management save `400`; no write |
| Account proxy URL is malformed or unsupported | management/proxy-test `400`; no request |
| Configured proxy connect/auth/TLS/DNS fails | record redacted proxy/network failure; never direct fallback |
| Model alias target is missing/non-Cline or alias collides with an original model | `400`; no write |
| Log filter is unknown or has an invalid integer/boolean | `400` |
| Session identity is over 512 characters or invalid | ignore it and continue identity fallback |
| Upstream has an HTTP 4xx/5xx status | preserve it as `upstreamStatus` and normally as `normalizedStatus` |
| HTTP 200 error envelope has a recognized status/message | normalize and classify before ordered canonical matching; otherwise `502` |
| Ambiguous or non-JSON HTML 429 from Cline | `scope=unknown`; absent an explicit scoped rule, default ignore and no implicit durable cooldown |
| Explicit account quota 429 with a configured removal action | stop that provider chain, do not penalize provider health, and replace the account at most once |
| Every known provider is excluded | no upstream request; safe `503`; never auto-bypass exclusions |
| Error output/history contains a configured key, Bearer token, or request message | replace with `[REDACTED]`; retain the complete structured error reason without substring-corrupting short-message redaction |
| `/api/accounts` canonical rules or account/scheduling fields are invalid | `400`; do not save |
| `errorRules` is omitted and submitted legacy mirrors differ from current compatibility projections | `409`; preserve canonical rules and bytes |
| `/api/accounts.accountPipeline` is missing on an older client | preserve the current server value |
| An older client sends complete legacy four-step booleans but omits `order` and/or any new pipeline field | fold legacy health filtering into health sorting and preserve every omitted current server value |
| `/api/accounts.accountPipeline` is non-object, incomplete, has unknown keys/non-booleans, has `cachePoolSize`/`cachePoolMaxSize` outside integer 0-100000, has a TTL outside integer 60000-604800000, has `sessionBindingMaxEntries` outside integer 1-100000, or has a non-permutation `order` | `400`; do not save |
| `cachePoolMaxSize < cachePoolSize`, or `sessionBindingFallbackTtlMs > sessionBindingExplicitTtlMs` | strict save `400`; non-strict normalization clamps max to min and fallback to the default-or-explicit TTL |
| Usage field is absent/invalid while another usage field is valid | keep the absent field unknown; count only explicit valid fields |
| First SSE head never produces a complete `data:` event (comment-only/metadata until 64 KiB, EOF, or first-event wall deadline) | reject before exposing the SSE response; on overflow destroy the native response immediately without consuming an unbounded tail; no heartbeat |
| First SSE `data:` event is a recognized error after a valid prelude | classify/possibly retry before output; do not expose the error event or leak prelude to the downstream client |
| After start, upstream stays silent beyond socket idle timeout despite downstream comments | terminate as one upstream timeout/failure; do not replay or create a heartbeat attempt |
| `res.write()` returns `false` | wait for `drain` and continue, without a fabricated `499` or premature lease release; throw/close/error is terminal |
| A streaming SSE event exceeds 64 KiB | discard that event only; resume at its CRLF/LF terminator and observe later usage |
| A fixed statistics counter exceeds `Number.MAX_SAFE_INTEGER` | persist `null` plus the exact `overflowFields` marker; never wrap or clamp |
| Rule/default outcome is `ignore`, traffic is management or an unattributed `auto` provider attempt, a completion is stale-generation, or the client disconnects | no success/degrade sample is recorded; `degrade`/`cooldown`/`hard-quarantine` each record exactly one failure sample in their scope |
| A `retryRules` entry is missing `id`/`decision`/`when`, has an unknown field, a non-`stop` decision, a duplicate ID, empty/oversized/out-of-range/duplicate status, or a missing/empty/oversized/control-byte/case-insensitively duplicate body needle | management save `400`; persisted canonical invalidity fails startup without rewriting bytes |
| A `retryRules` entry matches only `status` or only `body` | the rule does not match; the compatible continue-retry default applies |
| The first matching retry rule is `stop` | stop the remaining same-account Provider attempts and account replacement before the first byte; preserve the original terminal status/body |
| A retry stop would fire after SSE output started or during client cancellation | no retry decision, no replay, and no additional health effect |
| A retry stop has no paired `errorRules` entry | health stays independent; the provider-model default or configured rule still decides the sample |
| Capacity rejection happens before any lease/provider plan | `providerPlanSource`/`providerMode` are `null`; routing rejection from `runChatChain()` still reports its source/mode with an empty attempt list |
| Quota body exceeds 256 KiB, times out, or its schema/time/percentage is invalid | Safe failure category/backoff; retain last-good diagnostics, make routing quota unknown, and persist no raw payload |
| Quota reset time uses valid 1–9 digit fractional RFC3339 precision | Normalize to millisecond UTC; publish the accepted snapshot without changing refresh timing |
| Quota completion belongs to an old key/proxy/account generation or has no live page/routing owner | Cancel/discard without mutating snapshot, attempt time, failure count or backoff |
| Quota refresh body is missing/extra/nonboolean, is not an object, or has any query parameter | `400`; no quota owner/job/upstream call |
| More than 16 statistics quota batches are active | `429` plus `Retry-After: 1`; no new job |
| Manual, automatic, routing and save-triggered quota demands overlap | Join by account and keep actual unfinished upstream concurrency at or below two |
| All three canonical pipeline flags are false and `cachePoolSize` is 0 | use the legacy six-mode selection path without extra sorting/filtering |
| `/api/config` scope/action/account/model/route is invalid | `400`; do not save |

### 5. Good / Base / Bad Cases

- **Good:** sticky identity leases account A; provider `first` fails and `second` succeeds; both upstream requests use account A's Authorization.
- **Good:** account A receives an explicit account-quota 429 matching configured `429 -> cooldown` before output; its state is persisted without penalizing the provider, its lease is released, and account B starts from B's own first health-planned provider. A second removal action returns an error without selecting account C.
- **Good:** account A receives an ambiguous HTML 429 from named Provider `first`; no rule matches, so it is ignored for durable state and a retry may continue under independent retry classification.
- **Good:** an alias request logs both names, applies the resolved target's account route, and returns the internal request ID used by request/error logs.
- **Good:** a SOCKS/HTTPS-proxied account reaches Cline through its Agent; a bad proxy produces no direct request.
- **Good:** a streaming request receives fragmented events and one oversized event, then commits the final later cumulative usage exactly once.
- **Good:** an HTTP/1.1 New API-style client reuses an inbound socket across the previous five-second idle window; direct HTTP/HTTPS and persisted proxy tunnels reuse eligible sockets, while draft proxy tests destroy their own tunnel.
- **Good:** a prelude plus first data event is forwarded in order; quiet complete-event intervals produce `: PING\n\n`, but a partial data event is never split by a heartbeat. A slow downstream returns `write(false)`, later drains and still finishes as success.
- **Base:** `CLINE_PASS_SSE_HEARTBEAT_MS=0` leaves accepted SSE model traffic intact without injecting comments; a quiet upstream beyond its socket idle limit still fails.
- **Bad:** counting a heartbeat as an upstream attempt/usage event, resetting the first-data wall deadline with comments, or treating `write(false)` as disconnect.
- **Good:** account success sorting puts known rates before unknown and higher rates first, while ties preserve prior order and no rate is filtered.
- **Good:** a two-account cache pool keeps ordinary sessions on its priority/ID-stable active set; quota reserve and hard account state can replace members, while success-rate changes do not remap membership.
- **Good:** an old quota request finishes after credential rotation; its generation mismatch prevents any state write.
- **Good:** a delayed manual batch is accepted, another owner publishes a new-identity success, and the delayed batch returns `cached` without another upstream call.
- **Good:** routing turns off while a page still owns a shared job; the page may publish the valid result, but routing remains disabled and strict freshness rules are unchanged.
- **Base:** opening statistics within five minutes of a successful partial snapshot returns cached diagnostics without enabling quota routing.
- **Base:** no account-specific `perModel[model]` exists, so the global route is used unchanged.
- **Base:** no identity is extractable, so sticky deliberately behaves as round-robin.
- **Base:** a tool result containing only `"\n"` is forwarded unchanged instead of becoming a Switcher-generated `400`.
- **Good:** a cold `strict` route tries the configured first provider, then excludes it and retries the highest Provider-model 24-hour success rate among the remaining candidates; a cold `preferred` route uses that health order from the first attempt.
- **Good:** an operator confirms the manual preset; a `502` whose body contains `system message must have content` sends exactly one real attempt, performs no account replacement, and the paired provider-model `ignore` rule keeps the channel rate unchanged.
- **Good:** account A is concurrency-full, so a request waits/overflows without consuming A's RPM; after concurrency frees, A still has its full RPM budget.
- **Good:** account A's Provider `first` fails `502`, the retry cannot claim an RPM permit, and the request ends as a local `429` with `Retry-After` from A's window while the error log still retains the real `502` for `first`.
- **Bad:** consuming or reserving RPM before the concurrency check, incrementing `activeCounts` for an RPM-only block, or refunding a permit after `req.end()`.
- **Bad:** fabricating an upstream `429` attempt (or an error rule/account switch) for a local RPM block, or using a capacity-wait `Retry-After` instead of the earliest window recovery.
- **Bad:** calling account selection inside the provider-attempt loop; this breaks request-level account affinity.
- **Bad:** forwarding the downstream Authorization or relying on `fetch` for chat transport; either leaks proxy credentials or creates synthetic client headers.
- **Bad:** treating `preferred` as a gateway-side multi-provider `order`, or projecting the static configuration list or `plan.plannedOrder` as the actual runtime provider path.
- **Bad:** replaying an SSE request after the first valid event has been written.

### 6. Tests Required

`test/integration.test.js` is the required black-box boundary suite. Changes in this scenario must assert:

- repeated session, parent/child identities, and stable opening messages select the same account; request-id-only requests use round-robin;
- caller prompt/session keys are preserved; explicit Codex/Claude header/metadata identities derive one stable upstream key across retries/account replacement; message fallback derives none; ordinary logs contain only safe source/confidence/applied/cache-hit facts;
- HRW rank is independent of account input order, and removing one account remaps only sessions that ranked that account first;
- planner/direct/unknown-pipeline named attempts use singleton `only`, contain no `order`, keep identical Authorization, and apply `maxRetries` as a real outer-attempt cap after health planning and candidate exclusion;
- `strict first follows source order, retries and preferred follow provider-model success rate, singleton-only and safe failures` covers cold strict source order, strict retry and preferred health order, `maxRetries` capping, unknown-rate null-last ordering, model isolation, excluded/all-hard/cooling/auto/discovered candidate sources, and the bounded `providerPlanSource`/`providerMode`/`providerSelection` projection;
- `retry rules stop deterministic request errors before remaining providers or account replacement and stay independent from health` covers the exact `502 + system message must have content` stop, case-insensitive body ANY, HTTP-200 envelope and pre-stream SSE forms, status-only/body-only misses, first-match ordering, compatible continue default, account-replacement blocking, paired-ignore independence, and needle/rate absence from logs and metadata;
- `retryRules management API validates strictly, preserves old-client omission and keeps config bytes on rejection` covers strict schema/size/ID/condition rejection, old-client omission preservation, and byte-preserving rejection;
- `rule actions record exactly the declared direct health sample and disposition per scope` covers the 0/1/1/1 sample matrix together with cooldown/hard-quarantine dispositions;
- discovered providers become named attempts, a completely empty candidate source uses one unattributed auto attempt, all-excluded sends none, active durable cooldowns are skipped, expired cooldowns recover in place, and all-cooling fails safely instead of bypassing state;
- a positive `providerCooldownMs` additionally skips repeated allowed failures and admits one concurrent half-open owner; zero disables only that per-account circuit, while parameter/auth/proxy/cancel outcomes do not poison shared provider health;
- unknown/provider 429 continues within A, while explicit account 429 can switch A to B without provider penalty; a second removal action cannot select C, and banned accounts leave the candidate set;
- ordered content rules prove first-match/range/ignore/status-fallback behavior for nested HTTP-200 errors, non-stream, pre-stream SSE, post-start SSE and provider retry; current messages/keys/Header values are absent from metadata and ordinary logs;
- provider health tests cover valid/missing Retry-After, 5xx/transport/unsupported cooldowns, model isolation, success recovery, stale-generation rejection, restart persistence, and late SSE updates without replay;
- account override reports `configSource: "account"`; `action: "inherit"` restores `"inherited"`; account-scoped probe/validation keeps one account/proxy and never promotes account auth/proxy/quota failures into global provider health;
- real allowed and safe account Headers arrive, prohibited Headers do not, downstream Authorization is replaced, and no synthetic User-Agent appears;
- local mock direct HTTP/HTTPS peers observe repeated chat calls on one upstream TCP/TLS socket; an inbound New API-style keep-alive client sees the same local port across a >5-second gap shorter than its configured idle window;
- HTTP and HTTPS CONNECT mocks count one handshake for two requests on a saved proxy; SOCKS5 and SOCKS5H mocks each count one handshake for two requests; draft proxy-test responses close disposable tunnels, account-save proxy rotation destroys stale idle tunnels, and a bad proxy never produces a direct upstream hit or credential leak; these are local peer-dependent reuse observations, not a guarantee for arbitrary external proxies;
- comment-only prelude beyond 64 KiB destroys a never-ending response promptly; comment-only wait hits the first-data wall deadline without exposing SSE; coalesced prelude/data/DONE preserves ordering and a prelude followed by first-data error may fail over before output;
- independent first-event/stream-idle/heartbeat test observes a New API-equivalent line scanner resetting idle on comments while ignoring them as model data, blocks injection into partial SSE events, and demonstrates that heartbeats cannot mask permanently silent upstreams; `write(false)` is actually observed under backpressure, followed by drain, DONE, one success row and zero active leases;
- complete-DONE, upstream error/idle, early client cancellation and SIGTERM during SSE settle the request/usage/health/attempt/RPM/lease only once; SIGTERM preserves a terminal row through log drain, while a blocked writer is bounded by shutdown deadline;
- old three modes plus least-connections, weighted proportions, priority full-tier fallback/cooldown/recovery behave deterministically and all `activeCount` values return to zero;
- aliases rewrite outbound model/routing lookup, reject conflicts, preserve originals in `/v1/models`, and log requested/resolved names;
- log API request IDs, strict filters, bounded reasons/rows/queues, optional validated error-detail tokens, projections and sensitive-value absence satisfy `logging-guidelines.md`;
- sticky capacity overflows temporarily, all-full returns `429` plus `Retry-After`, and all `activeCount` values return to zero;
- account-level RPM is pinned by `test/integration.test.js`: `account maxRpm round-trips through config and API, preserves old-client omission and rejects invalid values without writing bytes`, `concurrency saturation never consumes RPM while the rolling window and its Retry-After stay exact`, `provider retries commit one permit per real req.end and stop locally with a truthful local 429`, `a pre-send failure releases the RPM reservation while a post-send failure never refunds`, `every account-bound chat caller commits one permit per real native call while catalog, quota and temporary credential tests do not`, `initial selection skips an RPM-exhausted candidate in favour of another account`, `a client cancellation after the attempt started never refunds RPM`, and `RPM windows clear on restart and credential rotation but survive disable/re-enable; zero means unlimited`;
- fragmented first-event SSE errors are normalized before output; valid SSE contains data and `[DONE]`;
- a wrapped error after SSE output starts updates the existing provider trace and future account state without replaying or adding a pseudo-attempt;
- a downstream close after observed `[DONE]` is `200 / success`; a close before `[DONE]` and a non-streaming cancellation are `499 / client_cancelled`, abort upstream work, stop failover, release capacity, and add no error attempt, usage, error/health result, or account action;
- empty/whitespace/null/missing/empty-array message content and a newline-only tool result reach the local mock upstream unchanged instead of producing a Switcher validation error;
- authenticated `POST /v1/responses` returns the stable 501 `unsupported_api` shape without account selection or upstream traffic;
- oversized clients receive prompt `413` before request end while request buffering remains bounded;
- persisted history contains no account key or raw session value;
- non-stream and fragmented/oversized streaming responses count only explicit usage, preserve known zero versus missing, and finalize global/account/resolved-model statistics once across provider retry, account replacement, success, failure and disconnect;
- account request-dedup and named Provider attempt samples, direct rates, zero/null, independent coverage/cell caps, overflow, migration starts, and 24-hour expiry are deterministic;
- all-false size-zero pipeline output is equivalent to each legacy mode, while every stored order round-trips and representative quota/health/sticky permutations prove earlier-stage priority, implicit sticky compatibility, eligibility, capacity fallback and lease release;
- cache-pool migration/old-client preservation (missing max defaults to min), dormant non-sticky behavior, quota-owner withdrawal on mode/step changes, priority/ID membership derived from the persisted target, soft-state stability, hard-state replacement, same-identity HRW, active-only normal traffic, capacity wait then atomic grow-one with persisted target, max-reached 429, concurrent-growth serialization, unrestricted (`maxConcurrent: 0`) accounts never triggering growth, pressure-drop never shrinking, operator clamp, atomic-persistence rollback, lease release and safe diagnostics are deterministic;
- sticky+healthSort binding: first miss selects by active success rate and commits a binding, later hits survive success-rate and hot/warm/unknown changes, a full bound account temporarily overflows without rebinding, a saturated miss grows/promotes before binding, and deletion/disable/key-proxy rotation/cooldown/hard-quarantine/active-exit/`reserve` invalidate the binding;
- binding TTL sliding, explicit 2h versus fallback 15m, LRU eviction at the configured cap, restart-empty state, provisional concurrent convergence, and owner/generation-safe cleanup of never-attempted selections are deterministic, while no session/fingerprint/entry list appears in logs, metadata or APIs;
- quota projection accepts and canonicalizes 1/3/6/9-digit RFC3339 reset times, rejects missing-zone/over-precision/impossible dates without replacing last-good data, never uses a stale generation, stays outside the chat path, and preserves strict 15-minute routing freshness;
- simultaneous routing/save/manual/multi-page demand never exceeds two truly unfinished upstream responses, same-account work joins, force does not bypass backoff, and a success since page-batch acceptance prevents a sequential duplicate even across key/proxy rotation;
- page close, routing off/on, disable/re-enable, key A→B→A, proxy rotation and deletion fence queued/header/body completions; owner-only cancellation records no failure/backoff; slow-drip responses hit the absolute deadline;
- the statistics refresh API rejects invalid/query/overload requests before work, returns bounded outcome counts, changes no configuration, refreshes only enabled keyed persisted accounts and never enters ordinary/detailed chat logs or chat statistics;
- `/api/statistics` is authenticated, coverage-labelled, bounded, stable-ID/resolved-model keyed, migrates v1 model coverage truthfully, and contains no sensitive/raw provider data; `/api/accounts` account summaries stay ID-bound across duplicate/renamed names.
- test-only timing budgets are split by purpose: a *semantic* budget injected through `CLINE_PASS_TEST_*` (quota deadline, success/failure intervals, binding TTL) stays an order of magnitude above real round-trip overhead and is never the synchronization point for "the work finished"; a *synchronization* wait observes a real state (mock admission/request count, `quota.refresh.state`, a published request/error log row, a `metadata.json` field) instead of a fixed delay;
- a bounded settle window is acceptable only for a negative assertion ("no further upstream call", "an obsolete callback did not re-arm") and must be paired with a positive observable assertion;

The current integration suite directly covers stable identities, provider/account failover, capacity overflow, valid SSE, fragmented pre-response SSE errors, wrapped post-start SSE errors without replay, `[DONE]`-then-close success, streaming/non-streaming client cancellation projections, unchanged empty-content and empty-tool-result pass-through, deliberate Responses API rejection, prompt oversized-body rejection, HRW input-order independence, minimal remapping after account removal, missing usage, oversized CRLF SSE recovery, statistics corruption rejection, and quota generation invalidation.

Run `node --check server.js`, `npm test`, and `git diff --check` after changing this boundary. Signal-handling changes additionally require a response-complete drain/restart test and a blocked-writer deadline test. A timing-sensitive case must also be reproduced under bounded load (parallel CPU burners) before a fix is claimed: an idle-only green run does not prove that a wall-clock dependency was removed.

### 7. Wrong vs Correct

#### Wrong

```js
for (const attempt of attempts) {
  const account = pickAccount();
  await attemptOnce(modelId, body, attempt, account, headers, signal);
}
```

#### Correct

```js
const selected = await acquireAccountLease(identity);
const account = selected.lease.account;
const cfg = resolveModelConfig(account, modelId);
try {
  await runChatChain(req, body, modelId, cfg, account, forwardedHeaders, options);
} finally {
  selected.lease.release();
}
```

The streaming path transfers release responsibility to its idempotent finalizer instead of releasing in this immediate `finally` block.

An SSE write returning false is backpressure, not cancellation:

```js
// Wrong: a full downstream buffer is not a broken client.
if (!res.write(': PING\n\n')) finalize('client disconnected', 'client_disconnect');

// Correct: the existing stream-local writer owns writes and drain cleanup.
writeDownstream(': PING\n\n'); // pauses extra pings and resumes on drain
```

Missing usage must remain unknown rather than being converted to a plausible zero.

#### Wrong

```js
const inputTokens = Number(raw.input_tokens) || 0;
commitStatistics({ usage: { inputTokens } });
```

#### Correct

```js
const usage = normalizeUsage(raw.usage);
finalizeStatistics({ usage }); // request-scoped and idempotent
```

Likewise, do not run pipeline grouping unconditionally: `pipelineEnabled() === false` must delegate to `acquireLegacyAccountLease()`.

Quota work must also use the shared admission owner.

#### Wrong

```js
// Two scheduler callbacks can each start two transports.
await Promise.all(due.slice(0, 2).map(refreshQuota));
```

#### Correct

```js
// Every source joins the same per-account job and global two-slot pump.
await requestQuota(account.id, pageToken
  ? { pageToken, force }
  : { routingEpoch });
```

The slot and ID lock are released only when the underlying transport settles, not when one requesting source leaves.

A retry rule must never be approximated with an implicit health side effect or a replay.

#### Wrong

```js
// A matched retry rule silently mutates provider health and continues the loop.
if (matchRetryRule(result)) updateProviderHealth(modelId, attempt.upstream, { classification });
```

#### Correct

```js
const diagnostic = settleAttempt(modelId, attempt, result, account, { cfg, sensitiveValues });
trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
if (diagnostic.retryDecision?.decision === 'stop') { retryStop = true; break; }
```

The paired `errorRules` entry, not the retry rule, decides whether a sample or disposition is written.

---

## Scenario: Dynamic cache-pool growth and stateful session binding

### 1. Scope / Trigger

Use this contract when changing pipeline schema/validation, `cachePoolMembership()`, the persisted grow-only pool target, `growCachePoolOne()`/`growAndLeaseCachePoolOne()`, `acquireCachePoolAccountLease()`, `acquireStatefulBindingAccountLease()`, `acquirePipelineAccountLease()`, the process-local session-binding owner, or the `GET /api/accounts.cachePool` projection.

This scenario owns one pool target, one grow-one decision, and the only session-to-account binding table. A dependent quota-role task may extend membership eligibility inside `cachePoolMembership()`, but it must reuse this target, capacity waiter, `tryLease`/`release`, `rpmAvailable()` (an RPM-blocked active set never grows), routing epoch, identity fingerprint and binding-invalidation seam. Do not add a second account selector, member list, waiter, queue, target, binding map or persistent session store.

### 2. Signatures

```js
normalizeAccountPipeline(value, {
  strict = false, fallbackOrder = PIPELINE_DEFAULT_ORDER, fallbackCachePoolSize = 0,
  fallbackCachePoolMaxSize, fallbackCachePoolLowQuotaSize = 0,
  fallbackSessionBindingExplicitTtlMs = SESSION_BINDING_EXPLICIT_TTL_MS,
  fallbackSessionBindingFallbackTtlMs = SESSION_BINDING_FALLBACK_TTL_MS,
  fallbackSessionBindingMaxEntries = SESSION_BINDING_MAX_ENTRIES,
})
cachePoolTargetFor(pipeline = config.accountPipeline, value = META.cachePoolTargetSize)
normalizeCachePoolTarget(pipeline = config.accountPipeline)
configuredCachePoolSize()
configuredCachePoolMaxSize()
configuredCachePoolTargetSize()
stickyEffective()
cachePoolEnabled()
sessionBindingConfigured()
sessionBindingEnabled(identity, ownerRequestId)
cachePoolMembership(list, candidates = null)
cachePoolRoles()
growCachePoolOne(membership)
growAndLeaseCachePoolOne(membership, identity, mode, excludeIds, { skipSticky = false })
bindingSelectionContext(excludeIds)
tryPipelinePlanLease(plan, identity, mode, { excludeId = null })
findSessionBinding(identity, validIds, now = Date.now())
createProvisionalSessionBinding(identity, accountId, ownerRequestId)
commitSessionBindingSelection(selected)
cleanupSessionBindingSelection(selected)
deleteSessionBinding(fingerprint, entry, { count = true })
pruneSessionBindings(now = Date.now(), { full = false })
touchSessionBinding(fingerprint, entry, now = Date.now())
invalidateSessionBindingsForAccount(accountId)
invalidateSessionBindingsOutside(validIds)
reconcileSessionBindings()
sessionBindingSummary()
acquireCachePoolAccountLease(identity, { excludeIds = new Set(), allowOverflow = true })
acquireStatefulBindingAccountLease(identity, { excludeIds = new Set(), allowOverflow = true, ownerRequestId, bindingDeadline = null })
acquirePipelineAccountLease(identity, { excludeIds, allowOverflow, ownerRequestId })
buildPipelineGroups(list, identity, candidates, { skipSticky = false })
```

Bounded constants and state:

```js
SESSION_BINDING_EXPLICIT_TTL_MS = 7_200_000   // 2h sliding
SESSION_BINDING_FALLBACK_TTL_MS = 900_000     // 15m sliding
SESSION_BINDING_MAX_ENTRIES = 50_000
SESSION_BINDING_TTL_MIN_MS = 60_000
SESSION_BINDING_TTL_MAX_MS = 604_800_000
const sessionBindings = new Map()             // fingerprint -> entry, process-local only
const sessionBindingCounters = { hits, misses, invalidated, temporaryOverflows, provisionalHits }
let sessionBindingGeneration = 0n
```

Management projection:

```text
GET /api/accounts
  -> { ..., accountPipeline, cachePool: {
         minSize, maxSize, targetSize,
         binding: { enabled, size, maxEntries, counters }   // never the entries themselves
       } }
POST /api/accounts
  <- accountPipeline may omit any new field without clearing the current server value
```

### 3. Contracts

#### Pipeline schema and cross-field bounds

- Canonical `accountPipeline` fields are the three booleans, the exact three-step `order` permutation, `cachePoolSize` (minimum total), `cachePoolMaxSize` (maximum total), `cachePoolLowQuotaSize` (fixed low target), `sessionBindingExplicitTtlMs`, `sessionBindingFallbackTtlMs`, and `sessionBindingMaxEntries`.
- `cachePoolSize` and `cachePoolMaxSize` are integers 0-100000 with `0 <= cachePoolSize <= cachePoolMaxSize`. A TTL is an integer 60000-604800000 ms. `sessionBindingMaxEntries` is an integer 1-100000.
- Non-strict normalization is permissive and deterministic: a missing/invalid `cachePoolMaxSize` becomes `Math.max(cachePoolSize, fallbackMax)` where `fallbackMax` is the caller-provided current value or `cachePoolSize`; a missing/invalid TTL or entry cap falls back to the caller-provided value when it is in range, otherwise to the constant default; an out-of-order `cachePoolMaxSize` clamps to `cachePoolSize`; a fallback TTL above the explicit TTL clamps to `Math.min(SESSION_BINDING_FALLBACK_TTL_MS, explicit)`. Strict saves never clamp; they throw.
- `DEFAULT_CONFIG.accountPipeline` ships the feature inert: `cachePoolSize: 0`, `cachePoolMaxSize: 0`, `cachePoolLowQuotaSize: 0`, `sessionBindingExplicitTtlMs: 7_200_000`, `sessionBindingFallbackTtlMs: 900_000`, `sessionBindingMaxEntries: 50_000`.
- Strict saves reject unknown keys, missing/non-boolean flags, missing/invalid order, and every out-of-range or cross-field violation before any persistence; `fallback*` arguments come from the current `config.accountPipeline`, so an older client that omits a field preserves the server value instead of resetting it to the default.
- Recognized legacy four-step input (`excludeUnhealthy`) is still folded into `healthSort: true` and the duplicate step removed; legacy input that omits all new fields yields `cachePoolMaxSize = cachePoolSize` (auto-growth inert).

#### Pool target and membership derivation

- `cachePoolTargetFor()` is the only target owner: `cachePoolSize === 0` returns `0`; otherwise it returns `Math.min(max, Math.max(min, Number.isInteger(META.cachePoolTargetSize) ? META.cachePoolTargetSize : min))`. `META.cachePoolTargetSize` is the single persisted grow-only value; member IDs are never persisted.
- With `cachePoolLowQuotaSize === 0`, `cachePoolMembership(list, candidates)` derives the unchanged legacy membership: eligible candidates are `quota.pool !== 'reserve'`, sorted by `priority` ascending then stable `id` ascending; active candidates are `eligible.slice(0, target)`. Positive low slots use the derived quota-role algorithm in the next scenario. An `enabled`/hard-state-ineligible account never appears because candidate lists come from `enabledAccounts()`. Success rate is never an eligibility input.
- `cachePoolRoles()` projects `active`/`standby`/`null` per account for the console. `active` means "inside the current target"; `standby` means "eligible but beyond the target".
- The effective pool requires `cachePoolSize > 0` **and** `stickyEffective()` (sticky account mode or the explicit sticky step). Outside that condition the configured minimum is dormant and `cachePoolRoles()` returns an empty map.

#### Grow-one timing and atomicity

- `growCachePoolOne(membership)` returns `null` unless **all** active candidates have a finite `maxConcurrent`, none has capacity, **and** every active candidate still has RPM available (`rpmAvailable()`), **and** the current target is below `maxSize`, **and** at least one eligible candidate is available beyond the active set, **and** the first candidate that would be promoted also still has RPM available. Any RPM-only or `mixed` block, an unlimited-concurrency candidate, or an RPM-exhausted promotion target therefore never grows the pool.
- A successful growth sets `META.cachePoolTargetSize = current + 1`, calls `saveMeta()` synchronously, and returns `{ previousActiveIds, targetSize }`. If `saveMeta()` throws, the runtime target is rolled back to `current`, a redacted `[缓存池] 扩容目标持久化失败：` service error is logged, and the caller treats the deadline as exhausted (`429`). No growth is claimed and no temporary file survives.
- Growth is `+1` only and never exceeds `maxSize`. Multiple concurrent waiters each recompute from the current target after waking, so the first committed growth is observed by later waiters and they cannot blindly add a second increment within the same observed capacity. One elapsed deadline therefore produces at most one target increment.
- `maxConcurrent: 0` means unlimited and can never satisfy the saturation precondition, so an unlimited active set never grows the pool.
- Pressure drop never shrinks the target: no automatic decrement exists. The operator clamps or resets it explicitly through `POST /api/accounts` (`normalizeCachePoolTarget(requestedPipeline)` runs before the save), and a hard-state exit is repaired by eligible replacement rather than a lower target.
- After growth the caller re-derives membership, formally promotes the new member, and only then leases it (`growAndLeaseCachePoolOne`). A standby account must be promoted to `active` before it carries traffic or receives a binding; the previous permanent standby-overflow path is removed.
- Without an eligible standby or at the configured maximum the existing capacity error is returned: `429` with the clamped `Retry-After`, `selectionReason: 'capacity-unavailable'`, `errorCategory: 'capacity'`, `upstreamStatus: null` and no attempt.

#### Conditional pipeline (sticky x healthSort)

- Effective sticky is `config.accountMode === 'sticky' || config.accountPipeline.sticky === true`. Stateful binding is enabled only when `stickyEffective() && config.accountPipeline.healthSort === true` **and** the request has a fingerprint and an `ownerRequestId`.
- Toggle matrix: sticky off + healthSort off uses the legacy path; sticky off + healthSort on sorts every request and keeps no table; sticky on + healthSort off keeps the existing stateless HRW and keeps no table; both on uses the stateful binding gate.
- Miss stages call `buildPipelineGroups(..., { skipSticky: true })`, so `sticky` is a precondition gate rather than a linear miss stage; `quotaPool` and `healthSort` keep their relative `order`. Within a resulting group the final tie-break is the existing `cachePoolRank()` HRW/mode rank, so explicit identities stay stable inside equal-rate layers.
- A hit is accepted only when the bound account is still inside the current active set **and** hard-eligible (the candidate list excludes disabled/`reserve` and active quota dispositions); otherwise the entry is deleted and the request continues as a miss. In role-aware mode a newly admissible low candidate invalidates an older high binding: role priority precedes sticky. With low=0, ordinary rate/hot/warm/unknown movement and provider failures retain the earlier binding behavior.
- When no cache pool is effective, the miss/active candidate set is every non-`reserve` candidate, so the combined mode still works with `cachePoolSize: 0`.
- `selectionResult()` reasons in this scenario are `cache-pool-active`, `cache-pool-active-overflow`, `pipeline-sticky-primary` and `pipeline-capacity-fallback`. `cachePoolFallback` is always `false` and `cachePoolTier` is always `active` (or `null`); the removed standby tier must not resurface.

#### Binding lifecycle

- `sessionBindings` is a process-local `Map<fingerprint, entry>` keyed by the existing `extractSessionIdentity()` HMAC fingerprint. Entries are `{ accountId, source: 'explicit' | 'fallback', expiresAt, lastUsedAt, state: 'provisional' | 'confirmed', generation, ownerRequestId }`. Raw sessions/messages, candidate lists, entry account maps and hash prefixes are never persisted, projected to logs, or listed by an API.
- TTL is sliding and source-dependent: `explicit` identity uses `sessionBindingExplicitTtlMs` (default 2h), `fallback`/`message_hmac` uses `sessionBindingFallbackTtlMs` (default 15m). A hit calls `touchSessionBinding()`, which refreshes `expiresAt`, updates `lastUsedAt` and re-inserts at the Map tail so insertion order is the LRU order.
- `pruneSessionBindings()` lazily deletes expired entries (bounded to 256 scanned entries per partial pass, full scan only during reconciliation) and then evicts Map-head entries while `size > sessionBindingMaxEntries`. There is no periodic timer; restart naturally empties the map.
- `findSessionBinding()` returns `{ entry, result: 'hit' | 'provisional' | 'miss' | 'invalidated' }`; an expired entry or an account outside the valid active set is deleted with `result: 'invalidated'`.
- `createProvisionalSessionBinding()` runs after a real lease is acquired and before the first native attempt. It returns a token `{ fingerprint, accountId, generation, ownerRequestId, owned: true, committed: false }` or `null` when there is no fingerprint, the source is `none`, or no `ownerRequestId` exists.
- The native chat transport calls `attemptOwner.onAttemptCommit()` immediately after `req.end()` hands a real request to Node, which calls `commitSessionBindingSelection()`: the entry is set to `confirmed` only when generation and account still match, then touched.
- `cleanupSessionBindingSelection()` removes an entry only when the token is owned, not committed, still `provisional`, and both `generation` and `ownerRequestId` match. A selection that never produced a native attempt (local validation/routing failure, cancellation before `req.end()`) therefore cleans up after itself, while a stale finalizer can never overwrite or delete a newer binding for the same session. Concurrent first requests for one session read the provisional entry and converge on one account.
- Invalidation seam (one function per trigger, all delegating to `deleteSessionBinding`/`invalidateSessionBindingsOutside`, and the two bulk invalidators notify capacity waiters after a removal): account deletion, disablement, key or proxy identity rotation, `persistAccountAction()` cooldown/hard-quarantine, manual account save removing an account from the active set, and a quota snapshot whose pool becomes `reserve` (`maximum >= 95`). Positive low slots additionally invalidate on quota hold/exhaustion and when an older high binding must yield to an admissible low. `reserve` classification and durable `quota-exhausted` are distinct: only a known 100% window confirms the latter (including a partial snapshot). `reconcileSessionBindings()` prunes expiry and drops entries outside the current active set; it runs on account save, account recovery, quota job settlement and summary reads.
- Never invalidated by: provider failure, ordinary request failure, success-rate movement, or temporary capacity overflow. With low=0, hot/warm/unknown quota movement alone does not invalidate; with positive low slots, actual role priority and active membership may do so. An account-scoped replacement updates the binding because the replacement lease establishes a new generation, and manual recovery does not resurrect a deleted entry (the next request misses again).
- With low=0 a full bound account waits only for that account up to the existing deadline, then may lease another active account as a temporary overflow (`bindingResult: 'temporary-overflow'`, `overflow: true`) without rewriting the binding; the next request tries the original account again. A saturated miss in combined mode may grow one member, promote it, and only then create the binding.

#### Diagnostics projection

- Request records add `bindingSource: 'explicit' | 'fallback' | 'none'` (default `none`) and `bindingResult: 'hit' | 'miss' | 'invalidated' | 'temporary-overflow' | 'provisional' | 'not-applicable'` (default `not-applicable`), plus `cachePoolMaxSize` and `cachePoolTargetSize` alongside the existing `cachePoolSize`.
- `sessionBindingCounters` are bounded fixed aggregates (`hits`, `misses`, `invalidated`, `temporaryOverflows`, `provisionalHits`) saturated at `Number.MAX_SAFE_INTEGER` and exposed only through `GET /api/accounts.cachePool.binding.counters`. See `logging-guidelines.md` for the full projection list and exclusions.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| `cachePoolMaxSize` missing on load or save | use the current server value; on legacy load use `cachePoolSize`, so auto-growth stays inert |
| `cachePoolMaxSize < cachePoolSize` on a strict save | `400`; no write; non-strict normalization clamps to `cachePoolSize` |
| `cachePoolSize`/`cachePoolMaxSize` outside integer 0-100000 | strict `400`; non-strict falls back deterministically |
| TTL outside integer 60000-604800000, or `sessionBindingMaxEntries` outside integer 1-100000 | strict `400`; non-strict falls back to the in-range current value then the constant default |
| `sessionBindingFallbackTtlMs > sessionBindingExplicitTtlMs` on a strict save | `400`; non-strict clamps fallback to `min(default, explicit)` |
| New pipeline field omitted by an older client | preserve the current server value for that field |
| New pipeline field is not an integer (string/boolean/`null`/fraction) | strict `400`; no write |
| Persisted `META.cachePoolTargetSize` is non-integer, below min, or above max | effective target is clamped by `cachePoolTargetFor()`; the stored value is only rewritten by an explicit operator save or a successful growth |
| Pool target 0, or a configured positive minimum outside sticky mode/step | feature dormant; legacy selection unchanged; no binding table |
| All active accounts have finite `maxConcurrent` and are full at deadline, target < max | one atomic grow-one + persistence, recompute, promote, lease |
| Any active account has `maxConcurrent: 0` | never grow |
| All active accounts are concurrency-full but at least one is RPM-exhausted | never grow; report `blockedBy: 'rpm'`/`'mixed'` with the earliest window recovery |
| The candidate that would be promoted is RPM-exhausted | never grow and persist no target; keep the existing all-active blocked facts |
| Target already equals max, or no eligible candidate remains | `429` `capacity-unavailable`; no attempt; no growth |
| `saveMeta()` fails during growth | roll back the runtime target, redacted service error, `429`; no temporary file left behind |
| Concurrent waiters reach the deadline together | at most one increment per observed capacity; no double lease, no count leak |
| Binding exists but its account left the active set, was deleted/disabled, rotated key/proxy, entered cooldown/hard quarantine, or became `reserve` | delete the entry; this request is a miss/invalidated and reselects |
| Binding exists and its account is active with capacity | lease it, `bindingResult: hit`/`provisional`; skip health sorting |
| Binding exists but its account is active and full | wait for that account to the existing deadline, then temporary overflow without rebinding |
| Provisional binding's request never issued a native attempt | cleanup only when generation, `ownerRequestId` and `provisional` state still match |
| Sticky off, or healthSort off, or no identity fingerprint | no binding is created, read or retained; `bindingResult` stays `not-applicable` |
| Session/fingerprint/entry-list/credential value would enter logs, metadata or an API | omit it; expose only enums, bounded integer counts and `size`/`maxEntries` |

### 5. Good / Base / Bad Cases

- **Good:** a 2-account pool with `cachePoolMaxSize: 3` serves two concurrent sessions on A/B, the third concurrent request waits `concurrencyWaitMs`, observes both active accounts full, grows the target to 3, promotes C and leases C; `metadata.json.cachePoolTargetSize` is 3, and a restart keeps C active.
- **Good:** every active account is finite-max and concurrency-full while their RPM budgets remain, so one grow-one promotes a standby whose RPM window is still usable.
- **Bad:** growing the pool because every active account is "full" when the real block is RPM, or persisting a target for an RPM-exhausted standby.
- **Good:** a saturated miss in sticky+healthSort mode grows/promotes one member and only then binds the session to it; a later hit returns that member without re-sorting by success rate.
- **Good:** a bound session's account is full; the request waits, then temporarily overflows to another active account with `bindingResult: 'temporary-overflow'`; the next request returns to the bound account.
- **Good:** key rotation clears only the rotated account's bindings; the affected session misses and rebinds, while other sessions keep their entries.
- **Base:** `cachePoolSize: 0` with sticky+healthSort still creates bindings, because the pool is only a capacity/eligibility refinement.
- **Base:** missing `cachePoolMaxSize` in a legacy file starts with max = min and never auto-grows.
- **Base:** a request with no extractable identity leaves `bindingSource: 'none'` and `bindingResult: 'not-applicable'`.
- **Bad:** persisting the active member list, a session→account map, or `META.sessionBindings`; membership and bindings are derived/process-local.
- **Bad:** treating the first appearance of a session as a hit, or letting health sorting re-shuffle already-bound sessions; that defeats the "only new sessions follow success rate" goal.
- **Bad:** ranking the standby overflow head and persisting it as a permanent member instead of performing the documented grow-one/promotion.
- **Bad:** returning a cached/standby account immediately after a hard invalidation without waiting for the existing deadline, or bypassing the configured max.

### 6. Tests Required

`test/integration.test.js` is the required boundary suite. Focused tests must assert:

- legacy config defaults `cachePoolMaxSize` to `cachePoolSize` and persists both min and max; `cachePool.targetSize` and `metadata.json.cachePoolTargetSize` are 0; an old-client save that omits every new field preserves the current min/max/TTLs/entry cap; invalid/partial/unknown pipeline payloads return `400` without changing file bytes; values survive restart.
- all-active saturation waits `concurrencyWaitMs`, grows one member, leases the promoted account, persists the target, and survives restart; concurrent saturation grows only to max with one `429` and no lease leak; a single elapsed deadline cannot chain through multiple increments; an unlimited active account never grows; `max=min` leaves growth inert; the operator can clamp the persisted target down; a forced `saveMeta` failure rolls back the target and leaves no temporary file.
- an RPM-only or `mixed` block never grows, and an RPM-exhausted standby is never promoted by growth; only pure all-active concurrency saturation with a usable promotion target grows one member (`test/integration.test.js`: `RPM-only and mixed blocking never grow the cache pool`, `an RPM-exhausted standby is never promoted by cache-pool growth`).
- `reserve`/hard-ineligible candidates never receive normal traffic or a replacement lease, and a full pool with no eligible standby returns `429` rather than using standby.
- sticky+healthSort: the first request for a session is a `miss` chosen by active success rate, later requests are `hit` and do not migrate when rates or quota hot/warm/unknown change; a full bound account temporarily overflows and then returns to the binding; a saturated miss grows/promotes before binding; explicit and `message_hmac` sessions produce `bindingSource` `explicit`/`fallback`; concurrent first requests converge through the provisional entry; a selection with no native attempt is cleaned up owner-safely.
- sticky-only keeps stateless HRW and never builds a table; healthSort-only sorts every request and never builds a table; `bindingResult` is `not-applicable` and `cachePool.binding.size` stays 0 in both.
- binding TTL slides on hits, explicit and fallback TTLs differ, LRU evicts at the configured cap, restart empties the map, `metadata.json` contains no `sessionBindings` and no session text, and `cachePool.binding` exposes only `enabled`/`size`/`maxEntries`/counters.
- invalidation is deterministic for deletion, disable, key/proxy rotation, cooldown, hard quarantine, active-set exit and `reserve`, and no invalidation occurs for provider failure, ordinary failure, rate movement or temporary overflow.
- no serialized log, metadata or API payload contains a raw session, fingerprint, candidate list or credential.

Run `node --check server.js`, `npm test`, and `git diff --check` after changing this boundary.

### 7. Wrong vs Correct

#### Wrong

```js
// Standby overflow permanently carries the request and the binding follows it.
const standby = plan.groups.flatMap(g => g.accounts).find(a => !membership.activeIds.has(a.id));
const lease = tryLease(standby);
result.pipeline = cachePipelineFacts(plan, membership, candidate, 'standby', true);
```

#### Correct

```js
// One synchronous, persisted grow-one, then formal promotion, then lease.
const growth = growCachePoolOne(membership);          // null when any active is unlimited/free or max is reached
if (!growth) return capacityError();
const context = bindingSelectionContext(excludeIds);  // target = previous + 1
const promoted = context.activeCandidates.find(c => !growth.previousActiveIds.has(c.account.id));
const lease = tryLease(promoted.account);             // only now may this account carry traffic/binding
```

#### Wrong

```js
// The first ranked account is treated as a cache hit for every session.
const ranked = cachePoolRank(active, identity, mode);
return selectionResult(tryLease(ranked[0]), mode, ranked[0], 'cache-pool-active', identity);
```

#### Correct

```js
const lookup = findSessionBinding(identity, context.activeIds);
if (lookup.entry) return leaseBoundAccount(lookup.entry, lookup.result); // hit/provisional short-circuits healthSort
const plan = buildPipelineGroups(active, identity, activeCandidates, { skipSticky: true }); // quotaPool/healthSort order only
const chosen = tryPipelinePlanLease(plan, identity, mode);
return attachBindingMiss(result, identity, ownerRequestId, lookup.result); // provisional entry after the real lease
```

---

## Scenario: Low-quota cache-pool roles and refresh-owned disposition

### 1. Scope / Trigger

Use when changing quota-derived membership, role-aware lease selection, account-failure settlement, the single quota job pump or account-state recovery. This extends the existing dynamic pool target and two-slot quota owner; it creates no member list, per-role lease queue, scheduler or expiry timer. The positive-low feature is effective only for a positive cache pool in sticky account mode or with the sticky pipeline step.

### 2. Signatures

```js
configuredCachePoolLowQuotaSize()
quotaProjection(accountId, now = Date.now())
cachePoolMembership(list, candidates = null) // { lowSize, targetSize, actual: { high, low, unknown }, activeCandidates, ... }
buildPipelineGroups(list, identity, candidates, { skipSticky = false })
cachePipelineFacts(plan, membership, candidate, tier, capacityFallback)
acquireCachePoolAccountLease(identity, options)
acquireStatefulBindingAccountLease(identity, options)
quotaDemandOutcome(account, source, now = Date.now())
quotaNextAttemptAt(account, successAt, now = Date.now())
reconcileQuotaDisposition(id, snapshot)
persistLowQuotaHold(account)
```

```text
GET /api/accounts -> accountPipeline.cachePoolLowQuotaSize,
  cachePool: { minSize, maxSize, lowSize, targetSize, actual: { high, low, unknown }, binding },
  accounts[].{ cachePoolRole, cachePoolQuotaRole, state, quota }
GET /api/statistics -> accounts[].quota.{ quotaDisposition, quotaRetryAt, refresh }
POST /api/statistics/quota-refresh <- { force: boolean } // existing job owner
```

### 3. Contracts

- `0 <= cachePoolLowQuotaSize <= cachePoolSize <= cachePoolMaxSize <= 100000`. `cachePoolLowQuotaSize: 0` is an exact bypass of role-aware membership/selection: no low-priority override, no quota hold promotion, and the original priority/ID non-`reserve` membership and selection remain intact. A positive configured minimum without effective sticky remains dormant. The single persisted `META.cachePoolTargetSize` is total active size; `lowSize` is fixed while grow-one increases the high target (`targetSize - lowSize`).
- Role input uses only a **fresh complete** latest successful three-window quota snapshot (`quotaProjection`). `used = max(five_hour, weekly, monthly percentUsed)`: `used < 80` is high/hot, `80 <= used < 95` low/warm, `used >= 95` reserve (excluded), and incomplete/stale/failed data unknown. Known numeric `0` is high, never unknown. Unknown is a last-resort filler, never a fabricated high/low.
- Derive up to `lowSize` warm members by remaining (`100 - used`) ascending then priority/ID; up to `targetSize - lowSize` hot members by remaining descending then priority/ID. Fill shortages from unselected **known** hot/warm, then unknown, truncated to total target. `cachePool.actual` counts actual high/low/unknown members, not intended slots. Membership does not depend on success rate. A `quota-exhausted` state may be confirmed from a partial snapshot even though that snapshot cannot assign any routing role.
- For a positive low target, `buildPipelineGroups()` fixes low → high → unknown priority before optional quota/health/sticky and mode ranking **within** each role. An admissible low beats an older high session binding; a bound low blocked by concurrency or RPM may temporarily overflow to an admissible high without rebinding or waiting for low, and a held low is excluded before ranking. A blocked role reports truthful capacity facts. RPM-only or mixed blocks never trigger growth. Only after the existing wait/deadline, if *every* active candidate has finite `maxConcurrent`, is concurrency-full and RPM-available and the promoted candidate is RPM-available, may existing grow-one commit; do not double-lease or grow beyond max.
- The selected lease's bounded `selectedQuotaRole` (`low`/`high`/`unknown`, or null for low=0) is a request snapshot: later quota refresh must not change failure attribution. Only an actual low-role attempt whose final canonical rule/default policy is `scope: 'account', action: 'degrade'` persists `waiting-refresh` and returns independent `quotaRemovalAction: 'waiting-refresh'`. It stops that account's provider chain and allows at most one pre-output account replacement. `provider-model`, explicit `ignore`, cancellation, and explicit account `cooldown`/`hard-quarantine` create no extra quota hold; a post-start SSE failure can affect future routing but is never replayed.
- `META.accountStates` rule and quota dimensions are independent. Waiting has no fixed-duration cooldown: the next routing scheduler cycle requests a real quota fetch, bypassing only the recent-success cache. Existing failure backoff, same-account dedupe, generation/routing-epoch fences and the global two transport slots remain authoritative. Manual `force` also bypasses success cache, not failure backoff. Disable/re-enable retains a hold; key/proxy rotation and deletion clear its stale identity; manual account recovery clears rule fields only.
- Each **new actual successful** quota snapshot evaluates every known window, independently of chat errors: any known `percentUsed >= 100` (even partial) confirms `quota-exhausted`. Enabling positive low slots on an existing persisted successful known-100 snapshot also reconciles it immediately on save/startup, without fabricating a new fetch; this does **not** allow cached data to clear a newer hold. Failed work retains the prior disposition. For exhausted windows `quotaRetryAt` is the earliest valid **future** reset; after it, retry and re-evaluate every window, including another still-100 window. Without a future reset, use the existing success/failure cadence, not a busy loop. Partial non-100 success is unknown for recovery and keeps an existing waiting/exhausted disposition; only a real three-window success with all `percentUsed < 100`, fetched no earlier than the disposition, clears the quota dimension. Neither recovery nor rule expiry clears the other dimension or changes operator `enabled`.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Legacy missing low, explicit low 0, or dormant non-sticky pool | Preserve existing membership and selection; no synthetic hold |
| 79.999/80/94.999/95/100 max-used boundaries | High/low/low/reserve/reserve respectively; known zero is high |
| Low concurrency/RPM/hold blocked, high available | Immediate high-role fallback without waiting on low or growing |
| All active RPM-blocked or a promotion candidate RPM-blocked | Local bounded capacity response; no new target/member/attempt |
| Low account/degrade before first SSE output | Persist waiting-refresh, stop that chain, replace at most once; independent rule action remains degrade |
| Explicit account cooldown/hard, provider-model action, ignore or cancellation | No additional quota hold; started stream never replays |
| Latest successful snapshot has partial known 100 | Confirm durable quota-exhausted; exclude from routing, schedule by earliest valid exhausted reset |
| Partial known 80, refresh error, or old cached success after hold | Keep waiting/exhausted and exclude; never infer missing windows or clear from cached data |
| Full new success with all three windows below 100 | Clear only quota disposition; an independent rule quarantine stays |
| Manual account recover on held account | Clear only rule fields; leave quota hold in place |

### 5. Good / Base / Bad Cases

- **Good:** with low target 1 and total target 2, a warm 94.999% account serves first, then its RPM block immediately falls back to a high hot account; a later pure-concurrency grow increases the high target but not the low slot.
- **Good:** a low account/degrade before output installs waiting-refresh, swaps to another account at most once, and a subsequent failed/partial non-100 quota refresh retains the hold until a complete new success.
- **Base:** low=0 and a positive pool preserve prior priority/ID membership and sticky selection, including absence of synthetic quota holds.
- **Bad:** using partial weekly=80 as proof of recovery, checking only fresh-complete snapshots for known 100%, or deleting a quota hold when a rule cooldown expires.

### 6. Tests Required

`test/low-quota-pool.test.js` is the focused local-mock/temporary-`DATA_DIR` regression suite: `fresh quota thresholds choose lowest remaining low, highest remaining high, then high on low RPM block`; `known low filler beats unknown; concurrent low lease falls back to high without growth`; `role priority supersedes an older high binding when low RPM recovers`; `pure concurrency growth expands the high target once and retains low slots across restart`; `low account degradation holds and replaces before output; failed refresh retains hold, successful refresh restores`; `partial known 100 persists across restart and manual recover; earliest then later reset drive recovery`; `provider-scope and explicit ignore never create low quota hold; no reset retries on success cadence`; `post-start low account failure holds only future traffic without replay`; `cancelled low stream does not create a quota hold or an account failure sample`; `fresh quota recovery clears only quota fields and preserves an independent rule quarantine`. The same suite asserts `pre-admission capacity rows do not fabricate zero pool composition`. Existing `test/integration.test.js` covers low=0 pool, quota job/lease/RPM/stream boundaries. Run `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test` and `git diff --check`; no real browser or live upstream is implied.

### 7. Wrong vs Correct

```js
// Wrong: partial success silently recovers a held account; all-zero diagnostics
// also claim a composition for a request that never acquired a pool lease.
if (snapshot.limits.weekly?.percentUsed < 100) delete META.accountStates[id];
record(modelId, { pipeline: { cachePoolActual: { high: 0, low: 0, unknown: 0 } } });

// Correct: reconcile only after real success using all three windows and
// disposition time; keep pre-admission composition absent (null).
if (windows.length === 3 && windows.every(w => w.percentUsed < 100) &&
    snapshot.fetchedAt >= disposition.quotaDispositionAt)
  META.accountStates[id] = { ...disposition, quotaDisposition: null,
    quotaDispositionAt: 0, quotaRetryAt: 0, quotaReason: null };
record(modelId, { pipeline: selected?.pipeline ?? null });
```
