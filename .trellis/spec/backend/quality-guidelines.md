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
resolveModelAlias(requestedModel)
resolveModelConfig(account, resolvedModel)
buildProviderAttempts(modelId, routeConfig, now)
injectPrefs(body, modelId, attempt)
classifyAttemptFailure(result, attempt, account, now)
updateProviderHealth(modelId, upstream, outcome, now)
responseHeadersFor(account, forwardedHeaders)
proxyAgentFor(proxyUrl)
runChatChain(req, body, modelId, cfg, account, forwardedHeaders,
  { stream = false, attemptTimeoutMs = 120000 })
clineRequest(url, { headers = {}, body, signal, timeoutMs = 120000,
  account = null, proxyUrl = "" })
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
normalizeFailureForRules(errorValue, sensitiveValues)
matchErrorRule({ result, classification, modelId, provider, sensitiveValues })
planProviderAttempts(modelId, route, account)
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

When `proxyKey` is non-empty, `/api/*`, `/v1/*`, and chat endpoints require either `Authorization: Bearer <proxyKey>` or `X-Admin-Key: <proxyKey>`. `GET /api/meta` is the intentional public exception.

Runtime environment keys are `DATA_DIR`, `CLINE_PASS_KEY`, `PROXY_KEY`, `PUBLIC_BASE_URL`, `PORT`, and `BIND_HOST`. Environment values override the loaded runtime configuration; a later console save may write the effective account/security value to `config.json`.

### 3. Contracts

#### Account selection and lease

- An available account has a non-empty `key`, `enabled !== false`, no active ban, and no unexpired cooldown.
- `maxConcurrent: 0` means unlimited. Otherwise `tryLease()` increments `activeCounts` synchronously and returns an idempotent `release()`.
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

- Configured `upstreams` are the authoritative provider order. Without a configured order, the stable discovered `META.models[modelId].upstreams` order is used.
- Exclusions are applied before health routing. A known list that becomes empty after exclusion returns a safe no-provider error and never falls back to auto.
- Providers with durable hard quarantine or `cooldownUntil > now` are skipped. Other Providers retain source order in this child scope; success-rate Provider retry ordering is owned by the dependent Provider-selection task. An expired cooldown returns to eligibility, and a positive per-account circuit still admits at most one concurrent half-open owner.
- If every named Provider is explicitly cooling or hard-quarantined, routing fails safely with bounded retry information rather than bypassing state. If no Provider is known at all, exactly one `auto`/unattributed attempt is allowed.
- Every named attempt injects exactly one provider through `providerOptions.gateway.only` (planner), `provider.only` (direct), or the same singleton in both shapes for an unknown pipeline. `order` is removed even if supplied downstream. `preferred` remains a persisted UI/config mode but its fallback is switcher-managed outer retry.
- A 429 is account-scoped only with a fresh complete 100%-used quota snapshot or explicit structured account/subscription/plan quota-exhaustion semantics. Routing/final-provider or structured provider fields make it provider-scoped. HTML and other ambiguous 429 responses are unknown.
- Unmatched Provider failures no longer create implicit durable cooldowns. Explicit provider-model cooldown/hard-quarantine rules own durable state; the existing positive per-account `providerCooldownMs` circuit remains a separate process-local compatibility mechanism.
- Provider-model state is keyed by `(resolvedModel, provider)` and shared across accounts. Hard quarantine survives restart and success and clears only through exact `POST /api/providers/recover` or identity cleanup. Unattributed auto never creates named state or success samples.

#### Header and credential boundary

Protocol allowlists are exclusive:

- Codex: `Originator`, `Session_id`, `Thread_id`, `Session-Id`, `Thread-Id`, `X-Client-Request-Id`, `User-Agent`, `X-Codex-Beta-Features`, `X-Codex-Turn-State`, `X-Codex-Turn-Metadata`, `X-Codex-Window-Id`, `X-Codex-Parent-Thread-Id`, `X-OpenAI-Subagent`, `X-OpenAI-Memgen-Request`, `X-ResponsesAPI-Include-Timing-Metrics`, `X-OpenAI-Internal-Codex-Responses-Lite`.
- Claude: `X-Claude-Code-Session-Id`, `X-Claude-Code-Agent-Id`, `X-Claude-Code-Parent-Agent-Id`, `X-Stainless-Arch`, `X-Stainless-Lang`, `X-Stainless-Os`, `X-Stainless-Package-Version`, `X-Stainless-Retry-Count`, `X-Stainless-Runtime`, `X-Stainless-Runtime-Version`, `X-Stainless-Timeout`, `User-Agent`, `X-App`, `Anthropic-Beta`, `Anthropic-Dangerous-Direct-Browser-Access`, `Anthropic-Version`.
- Generic: `Session-Id`, `Session_id`, `Thread-Id`, `Thread_id`, `X-Http-Session-Id`, `X-Session-ID`, `X-Session-Affinity`, `X-Slot-Session-Id`, `X-Conversation-Id`, `X-Thread-Id`, `X-Parent-Session-ID`, `X-Parent-Session-Affinity`, `User-Agent`, `X-Client-Request-Id`, `HTTP-Referer`, `X-Title`.

Always reject downstream `Authorization`, `Proxy-Authorization`, `Cookie`, `Host`, client `Content-Length`, hop-by-hop headers, `X-Codex-Installation-Id`, and `X-OAI-Attestation`. Account custom Headers are merged after the protocol allowlist and before the system-owned `Content-Type` and `Authorization`. Their names/values are strictly bounded, and credential/session/device/hop-by-hop names are rejected case-insensitively. Custom Headers never participate in session identity extraction. `responseHeadersFor()` always overwrites Authorization with `Bearer ${account.key}`. The native `http`/`https` transport is required for chat forwarding so a missing client `User-Agent` stays missing.

Account keys, proxy URLs/authentication, Header values, and notes are intentionally static account configuration in `config.json` and are returned only through authenticated account administration. They must not appear in `metadata.json`, ordinary JSONL logs, traces, error bodies, or diagnostic headers. Raw sessions, HMAC fingerprints and message text remain forbidden in these ordinary projections; only `sessionSource` and applied safe Header names may be recorded. The separately opt-in detailed store may retain sanitized model HTTP content and ordinary headers/session values under `logging-guidelines.md`; it never permits raw credentials, whole account objects or HMAC fingerprints, and does not relax the ordinary exclusions.

#### Account proxy and model alias boundary

- Empty `proxyUrl` means native direct transport. `http:`/`https:` use `HttpsProxyAgent`; `socks5:`/`socks5h:` use `SocksProxyAgent`. The pinned agent versions preserve Node >=18.
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

- A client socket close aborts the active upstream request.
- The stream path buffers at most the first 64 KiB while waiting for a complete first SSE event. A pre-response error event is normalized and may still trigger provider/account failover.
- After a valid SSE response is exposed (`started: true`), the request is never replayed. Clean completion recovers the named provider and releases any half-open owner; a later classified SSE error updates future provider/account state only.
- The SSE observer records a complete `data: [DONE]` event. A downstream close after `[DONE]` finalizes once as `200 / success`; a close before `[DONE]` finalizes once as `499 / client_cancelled`.
- An observed SSE error or upstream transport error takes precedence over `[DONE]` and remains a real failure. A client cancellation creates no error attempt, usage, error statistic, health result, account action, or provider-health update.
- The account lease stays held until normal stream flush, upstream error, or downstream close. Stream finalization, listener cleanup, statistics submission, provider settlement and lease release are idempotent.
- Detailed capture, when enabled, observes native responses before SSE-head consumers with a single pass-through Transform and two-way destruction propagation. Use native `stream.finished(source, { readable: true, writable: false }, callback)` to observe terminal source errors: `aborted` may precede Node's actual `error`, and synthesizing an earlier error changes downstream error bodies with logging enabled. Preserve the native error object/code (`ECONNRESET`); a silent premature close still terminates the tap with `ERR_STREAM_PREMATURE_CLOSE`. The 5 MiB capture cap never becomes a traffic limit; asynchronous store publication is not awaited here. Preserve downstream write/end/writeHead overloads/return values and explicitly carry the detail root into chat result recording because close callbacks may run outside the originating AsyncLocalStorage context. The request-local native-chat owner assigns monotonically increasing `attemptIndex` plus UUID `callId` only after `req.end()`; capture profiles consume the token and never own ordering. See the detailed logging contract for route exclusions and failure states.

#### Usage, statistics, and health

- One request-scoped idempotent finalizer owns statistics commit. Each accepted chat increments the global aggregate and the post-alias resolved-model minute aggregate once, and each participating account ID appears at most once in that request's account segments. Provider retries and account replacement do not duplicate model usage. Statistics mutation and final record/model-metadata mutation share one terminal `saveMeta()` for an ordinary chat; management writes and explicit durable disposition actions retain their existing persistence boundaries.
- Only explicit normalized upstream usage counts. `0` is known; a missing/invalid field is `null`; input, output, total, cache, or cache ratios are never inferred from another field. Model cache Token ratio is likewise computed only from explicit input/cache pairs.
- Non-stream JSON reads its terminal usage object. Streaming retains only the last cumulative usage snapshot while incrementally observing SSE events. Each event is bounded to 64 KiB; an oversized event is discarded through its CRLF/LF boundary, then observation resumes for later events.
- Management, probe, model-catalog, and quota traffic never enters chat statistics or health.
- Account health is request/account-deduplicated: any account-scope `degrade` wins for that account in the request; otherwise only an account that obtains final success receives one success. Provider-model health records each named real attempt as success or provider-model `degrade`. Ignore/cooldown/hard-quarantine, management traffic, auto attempts, and cancellation add no sample.
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
- Canonical `accountPipeline` has exactly three booleans, an exact permutation of `quotaPool`, `healthSort`, and `sticky`, integer `cachePoolSize` (minimum) and `cachePoolMaxSize` (maximum) 0-100000, plus integer `sessionBindingExplicitTtlMs`, `sessionBindingFallbackTtlMs` and `sessionBindingMaxEntries`. Recognized legacy four-step input is accepted and normalized: `excludeUnhealthy:true` folds into `healthSort:true`, and the duplicate step is removed deterministically. With minimum 0 and all booleans false, legacy selection remains unchanged. The dynamic-growth and stateful-binding contracts are owned by the `Dynamic cache-pool growth and stateful session binding` scenario below.
- `healthSort` stably refines account groups by direct account success rate descending, known before unknown, preserving prior order on ties. It never filters accounts and never reads Provider-model success data. Cache-pool membership likewise ignores success-rate fluctuations.
- A positive cache pool is effective only in sticky account mode or with the explicit sticky step. A configured positive minimum outside those conditions is dormant. Effective membership is derived per request from hard eligibility, non-`reserve` quota pool, priority and stable account ID, truncated to the persisted grow-only target; success-rate changes never promote or evict members, and no member list is persisted. Shared quota admission remains unchanged.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Chat JSON is malformed or not an object | `400`; no upstream request |
| Chat `model` is missing, blank, non-string, or over 300 characters | `400` |
| Any `messages.<index>.content` value is empty, whitespace-only, `null`, missing, or an empty array/part | Do not reject or normalize locally; preserve it in the upstream request and return the upstream outcome |
| `POST /v1/responses` | authenticated `501 unsupported_api`; no account/upstream request |
| Request body exceeds 50 MiB | Reject promptly with `413` as soon as the limit is crossed, even if the client pauses before request end; discard/drain the remaining body without buffering or destroying the socket |
| No statically available account | `503` with a redacted error |
| Accounts exist but required capacity is unavailable after waiting | `429`, `Retry-After` integer clamped to 1-30 seconds |
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
| A streaming SSE event exceeds 64 KiB | discard that event only; resume at its CRLF/LF terminator and observe later usage |
| A fixed statistics counter exceeds `Number.MAX_SAFE_INTEGER` | persist `null` plus the exact `overflowFields` marker; never wrap or clamp |
| Rule/default outcome is ignore/cooldown/hard-quarantine, traffic is management/auto, or client disconnects | no success/degrade sample is recorded |
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
- **Good:** account success sorting puts known rates before unknown and higher rates first, while ties preserve prior order and no rate is filtered.
- **Good:** a two-account cache pool keeps ordinary sessions on its priority/ID-stable active set; quota reserve and hard account state can replace members, while success-rate changes do not remap membership.
- **Good:** an old quota request finishes after credential rotation; its generation mismatch prevents any state write.
- **Good:** a delayed manual batch is accepted, another owner publishes a new-identity success, and the delayed batch returns `cached` without another upstream call.
- **Good:** routing turns off while a page still owns a shared job; the page may publish the valid result, but routing remains disabled and strict freshness rules are unchanged.
- **Base:** opening statistics within five minutes of a successful partial snapshot returns cached diagnostics without enabling quota routing.
- **Base:** no account-specific `perModel[model]` exists, so the global route is used unchanged.
- **Base:** no identity is extractable, so sticky deliberately behaves as round-robin.
- **Base:** a tool result containing only `"\n"` is forwarded unchanged instead of becoming a Switcher-generated `400`.
- **Bad:** calling account selection inside the provider-attempt loop; this breaks request-level account affinity.
- **Bad:** forwarding the downstream Authorization or relying on `fetch` for chat transport; either leaks proxy credentials or creates synthetic client headers.
- **Bad:** replaying an SSE request after the first valid event has been written.

### 6. Tests Required

`test/integration.test.js` is the required black-box boundary suite. Changes in this scenario must assert:

- repeated session, parent/child identities, and stable opening messages select the same account; request-id-only requests use round-robin;
- caller prompt/session keys are preserved; explicit Codex/Claude header/metadata identities derive one stable upstream key across retries/account replacement; message fallback derives none; ordinary logs contain only safe source/confidence/applied/cache-hit facts;
- HRW rank is independent of account input order, and removing one account remaps only sessions that ranked that account first;
- planner/direct/unknown-pipeline named attempts use singleton `only`, contain no `order`, keep identical Authorization, preserve configured order among non-cooling providers, and apply `maxRetries` after health planning;
- discovered providers become named attempts, no-known-provider uses one unattributed auto attempt, all-excluded sends none, active durable cooldowns are skipped, expired cooldowns recover in place, and all-cooling fails open only the earliest provider;
- a positive `providerCooldownMs` additionally skips repeated allowed failures and admits one concurrent half-open owner; zero disables only that per-account circuit, while parameter/auth/proxy/cancel outcomes do not poison shared provider health;
- unknown/provider 429 continues within A, while explicit account 429 can switch A to B without provider penalty; a second removal action cannot select C, and banned accounts leave the candidate set;
- ordered content rules prove first-match/range/ignore/status-fallback behavior for nested HTTP-200 errors, non-stream, pre-stream SSE, post-start SSE and provider retry; current messages/keys/Header values are absent from metadata and ordinary logs;
- provider health tests cover valid/missing Retry-After, 5xx/transport/unsupported cooldowns, model isolation, success recovery, stale-generation rejection, restart persistence, and late SSE updates without replay;
- account override reports `configSource: "account"`; `action: "inherit"` restores `"inherited"`; account-scoped probe/validation keeps one account/proxy and never promotes account auth/proxy/quota failures into global provider health;
- real allowed and safe account Headers arrive, prohibited Headers do not, downstream Authorization is replaced, and no synthetic User-Agent appears;
- HTTP, HTTPS, SOCKS5, and SOCKS5H proxies create real local tunnels; bad proxy tests prove no direct fallback and no credential leakage;
- old three modes plus least-connections, weighted proportions, priority full-tier fallback/cooldown/recovery behave deterministically and all `activeCount` values return to zero;
- aliases rewrite outbound model/routing lookup, reject conflicts, preserve originals in `/v1/models`, and log requested/resolved names;
- log API request IDs, strict filters, bounded reasons/rows/queues, optional validated error-detail tokens, projections and sensitive-value absence satisfy `logging-guidelines.md`;
- sticky capacity overflows temporarily, all-full returns `429` plus `Retry-After`, and all `activeCount` values return to zero;
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

The current integration suite directly covers stable identities, provider/account failover, capacity overflow, valid SSE, fragmented pre-response SSE errors, wrapped post-start SSE errors without replay, `[DONE]`-then-close success, streaming/non-streaming client cancellation projections, unchanged empty-content and empty-tool-result pass-through, deliberate Responses API rejection, prompt oversized-body rejection, HRW input-order independence, minimal remapping after account removal, missing usage, oversized CRLF SSE recovery, statistics corruption rejection, and quota generation invalidation.

Run `node --check server.js`, `npm test`, and `git diff --check` after changing this boundary. Signal-handling changes additionally require a response-complete drain/restart test and a blocked-writer deadline test.

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

---

## Scenario: Dynamic cache-pool growth and stateful session binding

### 1. Scope / Trigger

Use this contract when changing pipeline schema/validation, `cachePoolMembership()`, the persisted grow-only pool target, `growCachePoolOne()`/`growAndLeaseCachePoolOne()`, `acquireCachePoolAccountLease()`, `acquireStatefulBindingAccountLease()`, `acquirePipelineAccountLease()`, the process-local session-binding owner, or the `GET /api/accounts.cachePool` projection.

This scenario owns one pool target, one grow-one decision, and the only session-to-account binding table. A dependent quota-role task may extend membership eligibility inside `cachePoolMembership()`, but it must reuse this target, capacity waiter, `tryLease`/`release`, routing epoch, identity fingerprint and binding-invalidation seam. Do not add a second account selector, member list, waiter, queue, target, binding map or persistent session store.

### 2. Signatures

```js
normalizeAccountPipeline(value, {
  strict = false, fallbackOrder = PIPELINE_DEFAULT_ORDER, fallbackCachePoolSize = 0,
  fallbackCachePoolMaxSize,
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

- Canonical `accountPipeline` fields are the three booleans, the exact three-step `order` permutation, `cachePoolSize` (minimum), `cachePoolMaxSize` (maximum), `sessionBindingExplicitTtlMs`, `sessionBindingFallbackTtlMs`, and `sessionBindingMaxEntries`.
- `cachePoolSize` and `cachePoolMaxSize` are integers 0-100000 with `0 <= cachePoolSize <= cachePoolMaxSize`. A TTL is an integer 60000-604800000 ms. `sessionBindingMaxEntries` is an integer 1-100000.
- Non-strict normalization is permissive and deterministic: a missing/invalid `cachePoolMaxSize` becomes `Math.max(cachePoolSize, fallbackMax)` where `fallbackMax` is the caller-provided current value or `cachePoolSize`; a missing/invalid TTL or entry cap falls back to the caller-provided value when it is in range, otherwise to the constant default; an out-of-order `cachePoolMaxSize` clamps to `cachePoolSize`; a fallback TTL above the explicit TTL clamps to `Math.min(SESSION_BINDING_FALLBACK_TTL_MS, explicit)`. Strict saves never clamp; they throw.
- `DEFAULT_CONFIG.accountPipeline` ships the feature inert: `cachePoolSize: 0`, `cachePoolMaxSize: 0`, `sessionBindingExplicitTtlMs: 7_200_000`, `sessionBindingFallbackTtlMs: 900_000`, `sessionBindingMaxEntries: 50_000`.
- Strict saves reject unknown keys, missing/non-boolean flags, missing/invalid order, and every out-of-range or cross-field violation before any persistence; `fallback*` arguments come from the current `config.accountPipeline`, so an older client that omits a field preserves the server value instead of resetting it to the default.
- Recognized legacy four-step input (`excludeUnhealthy`) is still folded into `healthSort: true` and the duplicate step removed; legacy input that omits all new fields yields `cachePoolMaxSize = cachePoolSize` (auto-growth inert).

#### Pool target and membership derivation

- `cachePoolTargetFor()` is the only target owner: `cachePoolSize === 0` returns `0`; otherwise it returns `Math.min(max, Math.max(min, Number.isInteger(META.cachePoolTargetSize) ? META.cachePoolTargetSize : min))`. `META.cachePoolTargetSize` is the single persisted grow-only value; member IDs are never persisted.
- `cachePoolMembership(list, candidates)` derives membership on every call from the current target: eligible candidates are `quota.pool !== 'reserve'`, sorted by `priority` ascending then stable `id` ascending; active candidates are `eligible.slice(0, target)`. An `enabled`/hard-state-ineligible account never appears because candidate lists come from `enabledAccounts()`. Success rate is never an eligibility input.
- `cachePoolRoles()` projects `active`/`standby`/`null` per account for the console. `active` means "inside the current target"; `standby` means "eligible but beyond the target".
- The effective pool requires `cachePoolSize > 0` **and** `stickyEffective()` (sticky account mode or the explicit sticky step). Outside that condition the configured minimum is dormant and `cachePoolRoles()` returns an empty map.

#### Grow-one timing and atomicity

- `growCachePoolOne(membership)` returns `null` unless **all** active candidates have a finite `maxConcurrent` and none has capacity, **and** the current target is below `maxSize`, **and** at least one eligible candidate is available beyond the active set.
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
- A hit is accepted only when the bound account is still inside the current active set **and** hard-eligible (the candidate list already excludes disabled/`reserve`); otherwise the entry is deleted and the request continues as a miss. Rate, hot/warm/unknown and provider failures never invalidate a binding.
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
- Invalidation seam (one function per trigger, all delegating to `deleteSessionBinding`/`invalidateSessionBindingsOutside`, and the two bulk invalidators notify capacity waiters after a removal): account deletion, disablement, key or proxy identity rotation, `persistAccountAction()` cooldown/hard-quarantine, manual account save removing an account from the active set, and a quota snapshot whose pool becomes `reserve` (`maximum >= 95`). `reserve` is the implemented observable of confirmed exhaustion; there is no separate exhausted state or seam. `reconcileSessionBindings()` prunes expiry and drops entries outside the current active set; it runs on account save, account recovery, quota job settlement and summary reads.
- Never invalidated by: provider failure, ordinary request failure, success-rate movement, hot/warm/unknown quota movement, or temporary capacity overflow. An account-scoped replacement updates the binding because the replacement lease establishes a new generation, and manual recovery does not resurrect a deleted entry (the next request misses again).
- A full bound account waits only for that account up to the existing deadline, then may lease another active account as a temporary overflow (`bindingResult: 'temporary-overflow'`, `overflow: true`) without rewriting the binding; the next request tries the original account again. A saturated miss in combined mode may grow one member, promote it, and only then create the binding.

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
