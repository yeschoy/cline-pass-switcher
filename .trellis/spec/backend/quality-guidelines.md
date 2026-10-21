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
buildProviderPlan(modelId, cfg, account, now, preferredProvider = null)
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
  { stream = false, attemptTimeoutMs = 120000, sensitiveValues = [], attemptOwner = null, preferredProvider = null })
clineRequest(url, { headers = {}, body, signal, timeoutMs = 120000, method = "POST",
  account = null, proxyUrl = "", ephemeralProxy = false, proxyAgentFactory = null,
  egressHint = null, attemptOwner = null, attemptMeta = null, permit = null })
// response: { status, headers, body, setIdleTimeout(ms), attemptToken, detailAttempt, egress }
// rejection: Error with .egress (plus .attemptToken / .detailAttempt when present)
clineRequestJSON(url, { ...clineRequest options, maxResponseBytes = Infinity }) // adds text
resolveEgress(account, proxyUrl = "", egressHint = null)
// -> { kind: "explicit" | "pool" | "account" | "direct", entryId, endpointKey, poolFallback, connectPhase }
//    non-enumerable: url, entry (pool lease handle), poolRetryAt
egressOrigin(egress, account)      // "proxy" for explicit/pool/account, else "network"
egressLabel(egress)                // "direct" | "account-proxy" | "pool:<8hex>" | null
poolRetryAfterSeconds(now)         // whole-pool earliest recovery, ceil seconds, clamped 1-60
isPoolConnectFailure(result)       // egress.kind === "pool" && connectPhase && upstreamStatus === 0
createPoolProxyAgent(proxyUrl)     // pool-only agent; non-200 CONNECT -> connect error
configuredEgressSecrets({ includeUrls = true })
effectiveProxyPool(candidate = config)   // candidate.proxyPool || PROXY_POOL_OFF
proxyPoolPatch(value, current = config)  // {} when omitted or absent-and-default; else { proxyPool }
effectivePoolClientKeys(candidate = config)        // candidate.proxyPoolClientKeys || { default: 'on', overrides: {} }
proxyPoolClientKeysPatch(value, current = config)  // {} when omitted or absent-and-default; else { proxyPoolClientKeys }
accountUsesProxyPool(account)      // proxyPool.enabled && mode(account.clientKeyId ?? 'legacy') === 'on'
anyClientKeyUsesProxyPool()        // some legacy/clientKeys id has effective mode 'on'
applyProxyPoolConfig(previous, next)
catalogFetchJSON(url, account, timeoutMs = 60000)
normalizeUsage(raw)
createSseObserver(maxBytes = 64 * 1024)
commitStatistics({ ts, modelId, finalProvider, globalError, usage, segments, clientDisconnect })
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
POST /v1/responses  // authenticated Responses-over-Chat subset; protocol 400 before lease for unsupported fields
POST /v1/messages
POST /v1/messages/count_tokens  // client auth only; local estimate; no lease/network/statistics
```

Management endpoints relevant to routing:

```text
GET  /api/accounts
POST /api/accounts
GET  /api/statistics
POST /api/statistics/quota-refresh  // exact body: { force: boolean }
POST /api/accounts/recover
POST /api/accounts/quota-recover // exact { id }, monthly protection only
POST /api/accounts/reset-health  // exact { id }: drop routing health samples, rule cooldown/quarantine and provider circuits; keep request/error stats and quota protection
POST /api/providers/recover       // exact { model, provider }
POST /api/accounts/proxy-test
GET  /api/models?accountId=<account id>
POST /api/config
POST /api/config/reload         // exact {}: re-read config.json without restart; 400 keeps live config
POST /api/probe                 // { model, accountId? }
POST /api/validate-upstreams   // { model, accountId? }
POST /api/test                  // temporary complete route overrides; no persistence
GET  /api/model-aliases
POST /api/model-aliases
GET/DELETE /api/logs/requests
GET/DELETE /api/logs/errors
GET  /api/proxy-pool/status      // credential-free pool/entry projection
POST /api/proxy-pool/refresh     // {} | { wait: boolean }; 409 unless enabled floppydata source
GET  /api/proxy-pool/balance     // FloppyData traffic balance on demand
POST /api/proxy-pool/test        // exact {} or { sample: 1-50 }; default 10
```

#### Config hot reload and shutdown

Operators who edit `data/config.json` by hand apply it with `POST /api/config/reload` (UI button "从配置文件热加载") or `docker kill -s HUP cline-pass-console`, never `docker restart`. Both call `reloadConfigFromDisk()`:

- Hot fields: `accounts`, `accountMode`, `activeAccount`, `concurrencyWaitMs`, `poolFullWaitMs`, `errorRules` (legacy projections re-derived), `retryRules`, `quotaProtection`, `accountPipeline`, `accountWorkflow`, `sessionProviderAffinityEnabled`, `perModel`, `modelAliases`, `knownModels`, `exposeCatalog`, `proxyPool`, `proxyPoolClientKeys`. An absent field keeps its live value; startup migrations never run on reload. A present `proxyPool` goes through strict `normalizeProxyPool(..., { secret: META.routingSecret })` and a present `proxyPoolClientKeys` through strict `normalizeProxyPoolClientKeys(..., { knownIds })` (ids from the live, restart-only `clientKeys`); a rejected value refuses the whole reload and leaves the file unchanged. A published change calls `applyProxyPoolConfig()` (see the egress proxy pool scenario below).
- Validation is the same strict path as `POST /api/accounts` (`accountInputError` with new ids allowed, `normalizeAccountList`, strict rule/pipeline normalizers, alias/route validators). Any failure throws before mutation; HTTP returns 400 and SIGHUP logs `[配置] SIGHUP 热加载失败`.
- Restart-only fields (`port`, `apiKey`, `proxyKey`, `clientKeys`, `publicBaseUrl`, `upstreamBase`, probe identity/schedule, logging switches) that differ from live values refuse the whole reload; their env-pinned copies (`PORT`, `PROXY_KEY`, `PUBLIC_BASE_URL`) are ignored instead. An injected `CLINE_PASS_KEY` account is re-added if the file lacks it.
- A changed candidate is written back atomically (generated account ids persist; env-pinned fields keep file bytes), then `applyAccountConfig()` publishes it with the identical per-account/per-route invalidation used by UI saves. In-flight responses keep their already-selected account.
- `SHUTDOWN_TIMEOUT_MS` defaults to 25s in production (`CLINE_PASS_SHUTDOWN_MS`, 1s–120s) and compose `stop_grace_period: 30s` must stay above it, so SIGTERM drains streams and logs before any SIGKILL.

Legacy `proxyKey` (effective `PROXY_KEY` at startup) and up to 16 additional client keys authenticate `/v1/models`, `/api/v1/models`, `/models`, `/v1/responses`, `/v1/messages`, `/v1/messages/count_tokens`, and all three chat-completions aliases via Bearer or the legacy `X-Admin-Key` client header. `/v1/messages` and `count_tokens` additionally accept `x-api-key`; Chat and Responses ignore that Header. Conflicting presented credentials return `401`. A client `x-api-key` is never forwarded upstream. Authentication resolves a stable `clientKeyId` before leasing; only an empty Legacy key retains anonymous Legacy-owned model traffic, never management or access to additional keys' pools. See [client-key-guidelines.md](./client-key-guidelines.md) for complete routing, API and migration contracts. `GET /api/meta` remains public. Every other `/api/*` route requires the independent admin Cookie session, except the explicit `/api/auth/{state,session,login,bootstrap,password,logout}` exchange. A client key, Authorization header, or legacy `X-Admin-Key` never authenticates management. Management responses have no CORS wildcard and are `no-store`; unsafe methods require session CSRF header, same-origin checks and JSON for auth exchanges. Direct cleartext management HTTP is permitted only on loopback with a loopback Host; TLS termination requires configured HTTPS `publicBaseUrl`, an exact Host/Origin, `X-Forwarded-Proto: https`, a private/loopback socket peer, and a valid `X-Cline-Pass-Proxy-Token` equal to the independently provisioned 64-lowercase-hex `CLINE_PASS_ADMIN_PROXY_TOKEN`. The TLS proxy replaces both Headers (never forwards client-supplied attestations); a private-network model client cannot assert TLS merely by spoofing a forwarding Header. The application port must not be publicly exposed. Bootstrap requires a separate one-time code and immediate password change; pending sessions cannot use management routes. The route-auth matrix is executable in `test/admin-auth.test.js`.

Existing environment keys are `DATA_DIR`, `CLINE_PASS_KEY`, `PROXY_KEY`, `PUBLIC_BASE_URL`, `PORT`, and `BIND_HOST`. Effective account/security values from `CLINE_PASS_KEY`, `PROXY_KEY` and `PUBLIC_BASE_URL` may be persisted by a later console save; `DATA_DIR` and `BIND_HOST` are not persisted. Connection-pool and SSE timing environment keys are separate, never persisted and enumerated with ranges in `database-guidelines.md`.

### 3. Contracts

#### Account selection and lease

- An available account has a non-empty `key`, `enabled !== false`, no active rule or monthly-protection ban, no confirmed short-window or unexpired provisional protection hold, no unexpired rule cooldown and (when role-aware pool routing is enabled) no `waiting-refresh`/`quota-exhausted` disposition. See the low-quota scenario below.
- `maxConcurrent: 0` means unlimited. Otherwise `tryLease()` increments `activeCounts` synchronously and returns an idempotent `release()`.
- `tryLeaseResult()` returns a structured `{ lease, blockedBy, retryAt }` instead of only a lease. Admission order is fixed: **hard eligibility (caller) → `maxConcurrent` → RPM**. A concurrency block returns `blockedBy: 'concurrency'` without touching RPM; an RPM block returns `blockedBy: 'rpm'` without incrementing `activeCounts`. `blockedBy` is exactly `concurrency` | `rpm` | `mixed` | `unavailable` (`BLOCKED_BY_REASONS`); an account that is simultaneously concurrency-full and RPM-exhausted is `mixed`.
- `single` waits only for the configured active account (or the first statically available fallback).
- `roundrobin` ranks once, skips full accounts, waits up to `concurrencyWaitMs`, and advances `RR_COUNTER` per selection.
- `sticky` with a session fingerprint ranks available accounts by HRW over stable `account.id`. It waits for the first-ranked account, then may use an immediately available lower-ranked account for this request only. It does not store a session-to-account table.
- Sticky without an identity fingerprint uses round-robin.
- `least-connections` chooses the capacity-eligible account with the smallest `activeCount`; ties use round-robin.
- `weighted-roundrobin` rotates over virtual slots derived from `weight` 1-100 and removes unavailable/full accounts before building the cycle.
- `priority-failover` chooses the smallest capacity-eligible `priority` 1-100; ties use round-robin. A full primary immediately falls to the next tier.
- Opt-in `load-health` is only valid with pipeline sticky off. Within the first quota group with an admissible account, candidates whose known recent account success rate is within 15 percentage points of the best known admissible rate compete alongside unknown-sample accounts (unknown is not zero). Prefer lowest in-flight `activeCount`; among known samples retain the highest rate and let unknown samples share its round-robin tie for exploration (never assign unknown a fabricated zero or perfect score). The mode alone bypasses `healthSort`'s strict success-rate grouping; owner, hard-eligibility, quota, finite concurrency and RPM gates still apply. It never changes sticky HRW, binding hits or misses, provider retries, or existing mode sequences.
- The existing non-sticky modes wait only when every statically available account is blocked, and recompute candidates after capacity notifications.
- Selection returns stable diagnostic facts (`strategy`, preferred/selected account, enumerated reason, overflow, session source). These facts may be logged, but the session value/fingerprint may not.
- `runChatChain()` receives one explicit `account`; every provider attempt in that invocation uses that account's Authorization.
- `errorRules` is the only matching source. Each ordered rule has a stable ID, canonical `account` or `provider-model` scope (`credential` is an input alias), `ignore`/`degrade`/`cooldown`/`hard-quarantine`, optional case-insensitive Provider/resolved-model scopes, and AND-composed status, body-contains ANY, and response-Header conditions. Matching uses bounded redacted failure text and request-local bounded Headers; first match is final, including `ignore`.
- Cooldown reset uses an explicit response Header format (`retry-after`, `unix-seconds`, `unix-milliseconds`, or strict `d/h/m/s` duration), strict fallback and max durations, and never guesses units. Missing, invalid, or expired Header values use fallback and the result is capped by max.
- Without an explicit match, clear account auth/quota/proxy failures produce account `degrade`; clear named Provider 429/5xx/network/timeout/unsupported failures produce provider-model `degrade`; parameter errors, ambiguous attribution, unattributed auto, and cancellation produce `ignore`. Defaults never create cooldown or quarantine. Retry classification remains independent from health action.
- Account cooldown/hard-quarantine stops that account chain and permits at most one pre-stream replacement. Provider-model cooldown/hard-quarantine stops only that Provider attempt and remains on the leased account. Post-start actions affect future routing only; client cancellation evaluates neither rules nor health.

Session identity values are validated, HMACed with `META.routingSecret`, and never logged or persisted. In multi-key mode, identical downstream sessions have independent owner-scoped binding namespaces; Legacy preserves its previous HMAC mapping. The request-local identity also carries only bounded `keyType` and `confidence` enums. Trusted parent identifiers precede child identifiers. Codex checks parent thread metadata/header before `prompt_cache_key`, session, and thread values; Claude checks parent-agent information before session/agent values. Generic parent headers precede generic current-session fields. `X-Client-Request-Id` alone never establishes affinity. The fallback HMAC input contains only the first system/developer message and first user message (each capped at 4096 characters); if neither is extractable, selection falls back to round-robin.

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

- Candidate ranking filters out accounts whose window is exhausted (`rpmAvailable()`); `waitForLease()` and the pipeline selectors recompute after every capacity notification and reuse the existing global `waiters`/`notifyCapacityWaiters`. No refill timer, queue or per-account waiter is created. `acquireAccountLease()` snapshots both effective wait budgets once at admission; `poolWaitForBlock()` anchors the deadline to selection start without rereading mutable config on wakes or binding re-entry. Only when every currently qualified owner-scoped candidate (active set for cache pools) has finite `maxConcurrent`, is concurrency-saturated and still has RPM may it use effective `poolFullWaitMs` (`null`/absence inherits `concurrencyWaitMs`). Single/sticky preferred-only waits inspect the whole eligible pool to choose the budget without changing which account they wait on. RPM-only/mixed blocks and a full preferred account with another free retain the old budget; the wait target remains `min(deadline, earliest retryAt)` through `waitDurationForBlock()`. A capacity release wakes waiters early and cannot chain two deadlines.
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

`maxRetries: null` runs all built provider attempts; an integer `n` permits the first attempt plus at most `n` additional outer attempts. The cap is applied after durable health planning. `providerCooldownMs` remains an integer 0-300000: when positive it adds a process-local `(accountId, resolvedModel, provider)` circuit used to serialize half-open ownership and may override the short 500/504/network/timeout delay; zero disables only that extra per-account circuit, not the shared model/provider health state. The circuit opens on normalized **500/504**, `terminalOrigin` network/timeout, 429, or clear unavailable messaging—not on **502** (often gateway-normalized input/self failures). Circuit state contains no session/credential/body and is cleared on account identity changes and route replacement; stale-generation completions update neither circuit nor durable health.

A successful model probe builds its known provider set from the observed `finalProvider`, strict provider slugs harvested from either string or structured error envelopes, documented fallbacks and direct-pipeline endpoint details. Discovery state is distinct from `upstreamStatus`: observing a provider prevents a false zero count but never claims that provider passed pin validation. Manual `POST /api/probe` reuses its second account-bound/RPM-counted native call with a syntactically valid random impossible Provider slug. It returns a request-local `pinCapability: 'supported' | 'ignored' | 'unknown'`: `supported` requires HTTP 400/404, the exact fake slug in a clear Provider-routing rejection, a safe available-provider list, and no account/auth/quota/model-input attribution; `ignored` requires HTTP 200 with complete visible content and a named actual Provider different from the fake slug. All other outcomes—including generic 400, 401/403/429/5xx, network/proxy/timeout, local RPM, missing actual and empty content—are `unknown`. Harvested slugs remain discovery data independent of this verdict; the fake slug is never a candidate. `supported` proves only that the impossible slug was rejected at this boundary, not that every valid requested Provider will actually be used; compare subsequent named attempts with observed actual routing. `pinnable` is a legacy pipeline-recognition mirror, not proof of pin enforcement. The verdict is scoped only to this manual account/model/pipeline observation and is neither persisted globally nor used by chat/scheduled health, routing or the automatic paid-call budget. It can still incur a real model call if `only` is ignored.

#### Single-provider attempt planning and health

- Configured `upstreams` are the authoritative candidate source and source order. A non-empty configured list always overrides the stable discovered `META.models[modelId].upstreams` order; discovered order is used only when nothing is configured; a source that is completely empty is `auto`.
- `buildProviderPlan()` builds one stable per-request candidate snapshot: static `exclude`, durable `hardQuarantined`, and `cooldownUntil > now` are filtered before selection, in that order. `plan.rates` snapshots the Provider-model 24-hour direct success rate and `plan.plannedOrder` is a bounded diagnostic order, not a promise about gateway behavior. An expired cooldown returns to eligibility, and a positive per-account circuit still admits at most one concurrent half-open owner.
- On the **direct** pipeline, `strict` selects source order on the first real attempt (`providerSelection: "strict-first"`), then excludes every provider already attempted in this request and orders the remainder by Provider-model 24-hour direct success rate descending. `preferred` uses that same health order from the first attempt onward (`providerSelection: "health"`). Unknown rates (`null`) sort after known rates; ties and all-unknown keep source-index order. `selectProviderAttempt()` recomputes the remaining candidate set before every attempt.
- On the **planner** pipeline and on an unknown pipeline (treated as gateway-capable), that same strict source order or preferred health order is applied once to the filtered allow-list. The list is injected as `providerOptions.gateway.only` and `.order` on a single HTTP attempt. `pinMode`, health, and a session hint may only reorder that list before send. They do not open another provider HTTP attempt, and `maxRetries` does not add provider HTTP attempts on this path. Direct OpenRouter keeps the local walk above.
- With `sessionProviderAffinityEnabled` (default `true`), only explicit HMAC session identities in the same client-key owner and resolved model may prefer the last **attempted** named Provider on their next request (`providerSelection: "session-preferred"`). The single process-local `sessionBindings` LRU holds hints independently of optional account bindings: 60-minute successful-use sliding TTL, at most 16 fixed slots/model hints per identity (bounded lookup/settlement without scanning all bindings), shared `sessionBindingMaxEntries` total cap, restart clears hints. A missing/fallback identity, auto attempt, cancelled/failed SSE, or local rejection never establishes a hint. The terminal successful HTTP attempt does even when actual Provider is unknown or different: the hint is planned-only and does not prove actual routing or cache hits. Older concurrent successful turns cannot overwrite a newer success while its hint remains live. Selection only promotes a hint within the current account's complete route and eligible Provider set (exclusions, durable cooldown/quarantine and per-account circuit/half-open admission still apply); account replacement rechecks its own route. Successful completion on another eligible account can refresh the hint. Rotating a downstream client credential (including Legacy) clears that owner's hints; an old in-flight turn cannot republish after rotation. An administrator can disable the flag through `POST /api/accounts`; old full saves omitting it preserve the current setting. Disabled-to-enabled transitions clear prior hints and prevent in-flight turns from reintroducing them.

#### Scenario: explicit-session Provider preference

1. **Scope / trigger.** This is an ordering hint inside an already leased account's named Provider attempts, not an account selector, a pin-enforcement measurement, or a health sample. The account-specific complete route and eligibility filters take precedence. The browser draft contract is in `../frontend/state-management.md`.
2. **Signatures.** `GET /api/accounts` projects `sessionProviderAffinityEnabled: boolean` and `cachePool.binding.{size,providerEntries,totalEntries,maxEntries}`. `POST /api/accounts` accepts optional `sessionProviderAffinityEnabled: boolean` alongside the existing full account payload. `buildProviderPlan(modelId, cfg, account, now, preferredProvider)` and `selectProviderAttempt(modelId, plan, account, attempted, now)` consume the hint; `rememberSessionProvider(identity, modelId, account, attempt, sequence, affinityGeneration)` updates it only at terminal success. There is no persisted hint schema or new environment key.
3. **Contracts.** Missing persisted flag migrates to `true`; an older management save omitting it retains the previous value. A named terminal success renews the process-local 3,600,000 ms expiry; reads do not renew it. The hint key is owner-scoped HMAC identity plus resolved model, stored in at most 16 fixed slots per identity under the shared bounded `sessionBindings` LRU. Restart drops hints. The selection trace can report `session-preferred` but cannot report raw identity, fingerprint, an actual Provider match, or a cache hit on that basis. Disable/re-enable and downstream credential rotation invalidate old hints/in-flight publications.
4. **Validation & error matrix.** Boolean `true`/`false` → accepted after all normal account-payload validation; omitted in old save → preserve; string/number/null → HTTP 400 before config mutation; malformed/unreadable persisted JSON → startup failure without overwriting bytes. Fallback or missing identity, `auto`, expired/evicted hint, ineligible Provider, or disabled flag → original ordering, not an error. Excluded/quarantined/cooling/held Provider → never promoted. Failed or cancelled chat/SSE → no new hint.
5. **Good/base/bad cases.** Good: explicit owner/session/model A fails then B succeeds; the next request prefers eligible B, including on a different permitted account. Base: no explicit identity or no eligible B retains strict/preferred ordering and the existing `maxRetries` cap. Bad: a different owner, complete account `perModel` override, manual exclusion, half-open contention, or stale credential may not borrow/recreate B. Reported actual Provider C after successful attempted B does not turn B into an observed actual/cached hit.
6. **Tests required.** `test/integration.test.js` asserts the attempt sequence, account override/replacement, strict/preferred, TTL/restart, SSE final failure/cancel, and planned-versus-actual separation; `test/multi-client-keys.test.js` asserts owner/key rotation, late completion, and 16-slot bound; `test/account-draft.test.js` and `test/ui-contract.test.js` assert native draft/save, stale read and safe projection. Run the full project gate. For the toggle's focus/keyboard/responsive behavior, collect separate real-browser evidence; VM assertions do not substitute for it.
7. **Wrong vs correct.** Wrong: promote a saved slug before resolving the selected account's complete route, or record it when the first SSE data arrives. Correct: resolve/lease account → filter current eligible candidates → promote the saved slug only if present → record its attempted slug only on successful terminal settlement. This prevents manual exclusions and cancelled streams from becoming false affinity.

#### Remaining attempt-planning rules

- `maxRetries` caps real outer attempts: `maxRetries: null` allows every built attempt, an integer `n` permits the first attempt plus at most `n` more (`plan.maxAttempts = n + 1`), and `attempted` exclusion prevents any candidate from being retried twice in one request.
- Exclusions are applied before health routing. A known source that becomes empty after exclusion returns a safe `503` no-provider error and never falls back to `auto`. If candidates exist but every one is durably cooling or hard-quarantined, routing fails safely with bounded retry information instead of bypassing state. Only a completely empty candidate source allows exactly one unattributed `auto` attempt (`plan.maxAttempts = 1`, `providerSelection: "compat-auto"`).
- **Gateway allow-list (planner and unknown pipeline).** `injectPrefs()` strips client `provider.only` / `provider.order` / `gateway.only` / `gateway.order`, deletes a conflicting top-level `provider` object, and injects the filtered ordered allow-list once as both `providerOptions.gateway.only` and `providerOptions.gateway.order`. Other `providerOptions` namespaces are preserved. `order` is a priority hint for the gateway, not a promise the gateway will honor it, and it is not copied into `actualProvider`. `sort` still applies only inside the gateway object (`gateway.sort`), never as a second cross-provider walk. An empty candidate source stays one unattributed `auto` attempt with no `only` or `order`.
- **Direct pipeline.** Named attempts still inject exactly one `provider.only`. `injectPrefs()` deletes incoming `provider.order` / `gateway.order` and does not emit `order`. Local sequential retry and `maxRetries` keep their existing meaning. `sort` is `provider.sort` inside that single provider.
- A 429 is account-scoped only with a fresh complete 100%-used quota snapshot or explicit structured account/subscription/plan quota-exhaustion semantics. Routing/final-provider or structured provider fields make it provider-scoped. An upstream-HTTP 429 with `text/html` and no structured error is classified as `scope=gateway`, evidence `gateway_html_throttle` (historical docs called this egress-IP throttling; that IP hypothesis is **unverified** in production and must not be treated as fact). It bypasses `errorRules` entirely (even a matching account cooldown rule), the provider circuit and every health sample. The **account id** enters a process-local backoff of 1s doubling to at most 8s (concurrent rejections for that account share one window; a success clears that account’s window only—other accounts are not paused, even on the same `proxyUrl`); every chain attempt on that account waits out its window plus up to 250ms jitter before sending. The rejected chain retries the same provider once after the backoff, never rotates provider or account, and otherwise returns the 429 with `Retry-After` from the backoff and a clear `rate_limit_error` message (`upstream gateway rate limited (HTML throttle)`), not a generic invalid-response string. Other ambiguous 429 responses are unknown.
- **HTML 429 on a pool entry.** When the attempt's `egress.kind === 'pool'`, the same `gateway` classification applies (no rule, circuit or health sample), but `clineRequest()` cools only that entry (`Retry-After` seconds or HTTP-date clamped 1-600 s, else `throttleCooldownMs`) and `settleAttempt()` neither calls `noteGatewayThrottle(account)` nor waits on the account window. `egressStep()` runs before `gatewayStep()` (non-stream, pre-stream SSE error and `!up` branches): it adds the entry to the request-local `egressExclude` and, while `egressRetries < proxyPool.egressRetries`, the client is connected and `hasAvailable(egressExclude)`, immediately retries the same provider on another unused entry (`attempted.delete(upstream)`, `index--`, no wait; budget independent of provider retries, gateway retries and account replacement). Otherwise it stops with no account-egress replay: the final `429 rate_limit_error` carries `Retry-After = poolRetryAfterSeconds()` (earliest recovery over the **whole** active pool, including entries this request used, ceil seconds clamped 1-60). The pre-attempt account backoff wait is skipped when `poolEgressExpected()` (`accountUsesProxyPool(account)` for the account of **this** `runChatChain()` invocation and `hasAvailable(egressExclude)`; `account` is a per-invocation parameter that is never reassigned, and a pre-stream replacement re-invokes the chain with the new account); a success on a pool entry does not clear the account backoff. A `poolFallback` attempt (account/direct egress), pool-off traffic and accounts whose client key does not use the pool keep the per-account backoff and single same-egress retry unchanged.
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

- Empty `proxyUrl` selects the process-wide native `http.Agent` or `https.Agent` (both `keepAlive: true`, `scheduling: 'lifo'`, 512 max sockets / 32 max free per agent by default, bounded runtime overrides). `http:`/`https:` use `HttpsProxyAgent`; `socks5:`/`socks5h:` use `SocksProxyAgent`, each explicitly keep-alive with 32 max sockets / 2 max free by default. Direct agents may set a 60-second **free-socket** idle timeout (pool reclaim between requests). Proxy agent options must **omit** Agent `timeout`: `SocksProxyAgent` / `HttpsProxyAgent` would otherwise apply it to the in-tunnel raw socket and destroy in-flight Chat with `socket hang up` before `NON_STREAM_ATTEMPT_MS` / SSE first-event / stream-idle can fire. In-flight deadlines stay on `req.setTimeout` / `setIdleTimeout`, and `clineRequest()` walks TLS→raw (`_parent` / `.socket`) to keep nested socket timeouts aligned with the attempt deadline. Proxy free tunnels rely on `maxFreeSockets` and peer close. Do not substitute `fetch` or global Agent defaults for `clineRequest()`.
- `proxyAgents` caches only URLs referenced by persisted accounts and stops at 128 URLs. Excess/new non-persisted URLs get disposable agents rather than enlarging the cache; saving account changes calls `pruneProxyAgents()` to destroy stale agents before removal. `/api/accounts/proxy-test` always passes `ephemeralProxy: true`, even for a saved URL; its agent is destroyed on response end/close, setup failure, or abort and never enters the cache. The in-flight request retains its agent until settlement; do not destroy it just because response headers arrived.
- The account proxy applies to account-bound Cline chat/probe/validation/test, quota-upstream traffic and the account-keyed `catalog()` `/models` fetch (`catalogFetchJSON()` → `clineRequestJSON(GET)`, 16 MiB body cap, no redirect following). Probe and validation accept an optional account ID, lease that account once, and keep probe+harvest or the whole validation batch on it; unknown/unavailable/busy accounts return 400/409/429. Public document fetching (`fetchOfficialModels`, OpenRouter lists), FloppyData API calls and ordinary management APIs remain direct.
- Every keyed upstream call picks its egress in `resolveEgress()` inside `clineRequest()`, synchronously and per call: explicit `proxyUrl` (only `/api/accounts/proxy-test` and `/api/proxy-pool/test`) → `kind: 'explicit'`; `accountUsesProxyPool(account)` and `pickEntry()` returns an entry → `kind: 'pool'`, which **overrides** the account's `proxyUrl`; the account uses the pool but there is no entry (empty, all cooling, all at `maxRpmPerProxy`) → the account's own egress (`account` or `direct`) with `poolFallback: true` (D10); pool disabled or absent, **or** the account's client key does not use the pool → exactly the legacy `account.proxyUrl || direct` with no `noteFallback()` and `poolFallback: false`. A missing account or `clientKeyId` counts as `legacy`. Fallback is decided only by "no entry available"; a pool entry that fails is never followed by an account-egress or direct request inside the same attempt.
- Pool entry agents come from `createPoolProxyAgent()` and are owned by the pool runtime, separate from `proxyAgents` (whose 128 cap and `pruneProxyAgents()` stay unchanged). They use the same proxy options, set a free-socket timeout of `CLINE_PASS_PROXY_FREE_SOCKET_TIMEOUT_MS` only when a socket returns to the idle pool, and convert a non-200 HTTP CONNECT reply (407/502 …) into a connect-phase error carrying only the status. Account fixed-proxy agents keep the legacy `https-proxy-agent` behavior of replaying a non-200 CONNECT as an upstream response.
- A configured proxy failure is a proxy/network attempt failure and never retries the same request without an agent.
- `requestedModel` is preserved for diagnostics. `resolvedModel = modelAliases[requestedModel] || requestedModel` replaces outbound `body.model` and owns global/account `perModel` lookup. Aliases are not chained.
- `/v1/models` (also `/models` and `/api/v1/models`) exposes the de-duplicated union of original visible models and aliases so old clients remain compatible. Optional upstream catalog IDs are fetched only with an authenticated owner's eligible account, never the synthetic/global admin fallback when that owner has no eligible pool.

#### Chat input boundary

- Chat Completions validates the top-level JSON object and model identifier locally, but deliberately does not validate or normalize `messages[*].content`.
- Empty strings, whitespace-only strings, `null`, missing content, empty arrays, empty multimodal parts, and empty tool results pass through unchanged. This preserves compatibility with clients that represent a successful no-output tool call as `""` or `"\n"`; the upstream owns message-role/content schema acceptance.
- `messages: []` remains compatible.
- `POST /v1/responses` and `POST /v1/messages` convert to Chat Completions before leasing (`handleChat(..., adapter)`). Unsupported stateful/hosted/file inputs (except Responses `tool_search`, which degrades to a Chat function) return that protocol's 400 envelope with zero account or network work. Chat Completions aliases stay byte-compatible (`adapter === null`). `POST /v1/messages/count_tokens` authenticates, converts, estimates locally, and never leases or records chat statistics.
- Before lease, adapter `toChat` runs Magpie-aligned **tool-history heal** on the converted Chat messages (Responses also heals `input[]` first): unanswered calls get a synthetic tool result with the fixed English interrupted copy; orphan/empty-`call_id` outputs become user text; duplicate results keep the first; clean exchanges stay idempotent. Mint missing call ids **before** pairing so interrupted synthesis can see them. Chat aliases never run heal.
- Call-id hygiene: outbound Responses `call_id` values are bounded to ≤64 with a stable map shared by call and output; Anthropic `tool_use`/`tool_result` ids are charset-safe on the wire (`mp_` + base64url) and restored on the way back. Stream tool fragments with empty ids are minted once per choice/index and later empty id fields are stripped.
- Adapter stream finalization must not treat empty success as success: malformed upstream SSE JSON increments `corruptCount` and forces protocol failure; Responses must not emit empty `response.completed` when there was no valid choice/output (`[DONE]` alone is insufficient); Anthropic `fail` closes any open content block and emits `error` without a trailing successful `message_stop`. Signed empty thinking blocks still include `"thinking":""`.
- Model-name reasoning replay (Chat upstream only): `deepseek` tool turns missing reasoning get a single-space `reasoning_content` placeholder; Kimi/MiMo fold `reasoning_details` into `reasoning_content`; GLM folds spellings without the DeepSeek placeholder; MiniMax-style `<think>` tags are split when present. Existing `clps1.` seal replay in the current tool loop remains first priority.

#### Abort and SSE lifecycle

- The native HTTP/1.1 server sets `keepAliveTimeout = 95_000` ms and `headersTimeout = keepAliveTimeout + 5_000` ms by default. This is the *between-requests* idle window (slightly above New API's documented 90-second pool idle), not a stream duration or replacement for the existing 50 MiB body limit. Do not require newer Node-only `keepAliveTimeoutBuffer`.
- A direct client socket close aborts the active upstream request. If New API keeps its ordinary Chat upstream request open after its own final client disconnect *before* Switcher returns headers, Switcher cannot observe that final client; the first-event deadline bounds residual work but does not make cancellation immediate.
- Non-stream attempts use `CLINE_PASS_NON_STREAM_ATTEMPT_MS` (default 300000). Streaming uses a 120-second wall deadline from attempt start through response headers and the first complete valid `data:` event; comment/metadata bytes never extend it. `clineRequest()` initially sets the native request timeout (and nested socket timeouts) and returns `setIdleTimeout(ms)` so that, after acceptance, `runChatChain()` clears the first-event timer and actually replaces the active and nested socket timeouts with the 360-second upstream idle limit. Downstream heartbeats do not reset this upstream idle timer.
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
- Non-stream JSON reads its terminal usage object. Streaming retains only the last cumulative usage snapshot while incrementally observing SSE events. Each event is JSON-parsed up to 1 MiB so routing metadata and usage inside a large content event are kept; content and error capture stay capped at 64 KiB. An event above 1 MiB is scanned only for routing fields, then discarded through its CRLF/LF boundary, and later events are still observed. The first-event admission cap remains 64 KiB.
- Management, probe, model-catalog, and quota traffic never enters chat statistics or health.
- Rule actions map to direct health samples exactly (`SAMPLE_FAILURE_ACTIONS = {degrade, cooldown, hard-quarantine}`): `ignore` writes 0 samples and no disposition; `degrade` writes 1 failure sample; `cooldown` writes 1 failure sample plus a temporary skip; `hard-quarantine` writes 1 failure sample plus durable quarantine. An account-scope action writes the account sample and a provider-model-scope action writes the `(resolvedModel, provider)` sample.
- Account health is request/account-deduplicated with failure precedence: any account-scope `degrade`/`cooldown`/`hard-quarantine` sample wins for that account in the request; otherwise only an account that obtains final success receives one success. Provider-model health records at most one sample per named real attempt. Stale-generation completions, management traffic, an unattributed `auto` provider attempt, and client cancellation write no sample. An `auto` request that succeeds still records one account success sample, because the account dimension has no named provider attribution.
- Both dimensions expose the rolling 24-hour direct rate `successes / (successes + degrades)`, counts, sample count, and coverage. One sample is sufficient; zero samples is `null`, never numeric zero. Disabled, cooling, and hard-quarantined are independent disposition fields; there are no available/degraded/unhealthy thresholds.
- `GET /api/statistics` is authenticated and returns projected global/account lifetime and 1,440-minute aggregates, plus per-resolved-model rolling aggregates with model tracking/cell-loss coverage, health, quota, and a separately labelled legacy migration baseline. Fixed aggregates also count explicit/fallback affinity, provider fallback, circuit cooldown and half-open requests; `routingCoverage` labels the migration/start minute so pre-tracking history is not fabricated as zero. They never store identity values or high-cardinality provider/session keys. `GET /api/accounts` embeds a stable-ID account statistics summary for the main table while retaining the legacy name-keyed `stats` projection only for old clients. `GET /api/statistics` returns no credentials, raw events, messages, sessions or raw quota responses. Authenticated `GET /api/accounts` deliberately returns account upstream `key`/proxy/Header configuration for full-list editing and `clientKeyId` for ownership, but no additional **client-key** secrets, raw events, sessions or raw quota responses; do not reuse that projection as public metadata or ordinary logs.

#### Model/Provider reference statistics (v5)

- The authenticated `GET /api/statistics` retains its existing fields and adds `referencePrices` (`current` immutable project reference snapshot plus at most eight persisted version snapshots) and `models[].providerStatistics`. Final model outcomes are separate from the legacy request/error aggregate: `finalRequests` counts successes, failures, and cancellations independently; `samples = successes + failures`, so cancellation cannot be mistaken for success. `finalCoverage` starts at v5 migration, never backfills earlier final outcomes. Provider `health` continues to count only named real success/degrade attempts, not all terminal requests. `proxyHealth` (statistics v6) aggregates credential-free proxy endpoints (`scheme://host[:port]`): each (account segment, actual attempt `egress.endpointKey`) pair increments `requests` once, and any attempt on that endpoint with status 500–599 increments `errors5xx`, independent of error-rule `healthAction`. Attribution follows the egress each attempt really used (pool entry, account proxy, explicit), falling back to the account's configured `proxyUrl` only for a trace without egress; direct attempts are excluded, all FloppyData entries aggregate under their shared gateway key, and history is not backfilled.
- Final successful usage is committed once per resolved model. The per-Provider usage owner counts only successful final requests whose response-evidenced provider matches the attempt's health provider; otherwise it uses an explicit null/unknown Provider row. On a direct or singleton pin that health provider is the planned slug, so a different observed provider stays unknown. On a planner/unknown multi-provider attempt the health provider is only the response-evidenced actual, never the allow-list head. `parseRouting()` / the shared routing observer follows Bridge priority: `finalProvider` then `resolvedProvider`, under `provider_metadata` or `providerMetadata`, walked on the response root and each `choices[].delta` / `choices[].message`; a bare top-level `provider` is weaker and cannot replace a sticky final or resolved value; `error.message` may recover the same two keys by regex and must not replace an already observed final or resolved provider. SSE routing observation is not limited to the 64 KiB content/error capture cap (JSON events are parsed through 1 MiB; larger events are field-scanned). Candidate lists (`fallbacksAvailable`) never count. Neither the configured target nor a successful named attempt alone proves the final remote Provider. Without a documented trustworthy new field, do not fill unknown from either. Failed retries have health samples but no usage. `usage.requests` is the number of final successful requests (including those with no usage); each `*KnownRequests` field is its own evidence coverage. The model aggregate retains its earlier 24h scope; Provider usage and valuation are v5-only and have independent start/loss coverage. Missing or invalid usage is unknown, not zero; cache Token ratio and cache-hit request rate retain separate denominators.
- Historical snapshot `clinepass-2026-09-24-v1` remains immutable: four exact IDs (Kimi K3, GLM-5.3, DeepSeek V4 Flash/Pro), integer thousandths USD/1M rate triples, and frozen picodollar minute cells. Historical `clinepass-2026-09-25-v2` uses 12 exact IDs from the ClinePass list, integer ten-thousandths USD/1M input/output/read/write rows, per-model source, project collection date, and unknown official effective date. Current `clinepass-2026-09-29-v3` preserves the v2 persisted snapshot shape and exactly those rates; its version freezes the UTC selection contract. Only authenticated API projections add `selection: 'terminal-utc-weekdays-no-holidays'`, so the exact previous image can validate the persisted version if an isolated v3-cell rollback rehearsal passes. A v2 snapshot/cell remains an unchanged historical interval. The two DeepSeek IDs (`v4-pro` and `v4.1-flash`) use the user-directed direct API tariff for both off-peak/peak rows; ClinePass itself lists only Flash's peak row. Direct API rates are reference comparisons, **not** proof of ClinePass subscription charges. Do not transfer direct DeepSeek's retired-name alias to legacy `cline-pass/deepseek-v4-flash` or use old GLM/Kimi names for new rates.
- Price rows with a listed Cached Write rate or unknown context band (Qwen3.7 Plus) remain visible but cannot produce full amounts from existing usage. For a no-write row, valuation requires explicit safe nonnegative input/output/cached-read with `cachedRead <= input`; fixed-point BigInt picodollars calculate `(input-cachedRead)*inputRate + cachedRead*readRate + output*outputRate`, with v1 multiplier 1000 and v2/v3 multiplier 100. Historical v1/v2 DeepSeek cells retain their frozen lower/upper **reference ranges**. New v3 successes select off-peak or peak using the terminal success `ts` in UTC: Monday–Friday [01:00,04:00) and [06:00,10:00) are peak, otherwise off-peak; Chinese public holidays are deliberately ignored, so weekday-holiday reference estimates may exceed the official holiday rate. Add that single selected amount to both bounds in the existing versioned minute cell. Mixed old intervals remain ranges; equal summed bounds may be shown as a single estimate, never as evidence of the actual billed tariff. Missing price/usage/inconsistent counts cannot produce $0; explicit zero can. Each successful request freezes amount and snapshot version inside the existing bounded minute owner; historical cells are never repriced. Priced-request coverage, version/cell eviction, and monetary/count overflow are independent and cannot be described as a complete bill. This value must never change the independent community $50 monthly remaining projection.

#### Quota refresh and account pipeline

- Routing-owned refreshes and statistics-page refreshes share one FIFO admission pump. Every actual `/users/me/plan/usage-limits` transport goes through `clineRequestJSON()` with the account (no explicit `proxyUrl`), so its egress is a pool entry when the pool is enabled and otherwise the account proxy, never a direct fallback after a configured egress fails; it does not run egress retries, has a 15-second absolute deadline, caps the body at 256 KiB, and occupies one of exactly two global slots until the native response settles. Overlapping scheduler callbacks, account saves, tabs and manual requests cannot create a third live upstream call; chat selection never waits for this work.
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
| `POST /v1/responses` / `POST /v1/messages` unsupported subset | protocol-shaped 400; no account/upstream request |
| Adapter stream: corrupt SSE / empty completed / Anthropic fail mid-block | protocol `response.failed` or Anthropic `error` (close open block; no false success end) |
| Unanswered / orphan tool history on Responses/Anthropic | heal before lease (interrupted copy / user text); not a hard 400 for those shapes |
| Responses `tool_search` | degrade to Chat function and round-trip; not hosted 400 |
| `POST /v1/messages` / `count_tokens` `x-api-key` | accepted as the client key; ignored on Chat/Responses; conflict with Authorization → 401 |
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
| Pool entry fails before the tunnel/TLS is connected (refusal, SOCKS/CONNECT auth, non-200 CONNECT, `connectTimeoutMs`) | cool that entry for `failureCooldownMs`; `errorScope=proxy`, `scopeEvidence=proxy_pool_connect`, `healthAction=none`; no rule/account/circuit effect; switch to another unused entry within `egressRetries`, else the existing `502`; never direct or account egress in the same attempt |
| Pool enabled but no entry is available | this call uses the account egress (`account-proxy`/`direct`) with `poolFallback: true`; HTML 429 there follows the per-account backoff path |
| Model alias target is missing/non-Cline or alias collides with an original model | `400`; no write |
| Log filter is unknown or has an invalid integer/boolean | `400` |
| Session identity is over 512 characters or invalid | ignore it and continue identity fallback |
| Upstream has an HTTP 4xx/5xx status | preserve it as `upstreamStatus` and normally as `normalizedStatus` |
| HTTP 200 error envelope has a recognized status/message | normalize and classify before ordered canonical matching; otherwise `502` |
| HTML 429 from the Cline edge (no structured error) | `scope=gateway`; no error rule, cooldown, circuit or health sample; egress backoff, one same-provider retry, then `429` with `Retry-After` |
| HTML 429 on a pool entry | cool the entry only; no account backoff/wait; immediate retry on another unused entry up to `egressRetries`; exhausted or no other entry → `429 rate_limit_error`, `Retry-After` 1-60 from whole-pool earliest recovery, no account-egress replay |
| `POST /api/accounts` or reload `proxyPool` is invalid (unknown field, bad enum/range/URL, duplicate or colliding entry, >2000 entries, enabled manual with no entries, enabled floppydata without `apiKey`) | `400` (reload refused) with a field-path message that never echoes URL/credential values; no write |
| Other ambiguous 429 from Cline | `scope=unknown`; absent an explicit scoped rule, default ignore and no implicit durable cooldown |
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
| A streaming SSE event exceeds 1 MiB | scan that event for routing fields only, discard it through its CRLF/LF terminator, and observe later events. Events from 64 KiB through 1 MiB are parsed for routing and usage; content/error capture still stops at 64 KiB. The first-event admission cap remains 64 KiB |
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
- **Bad:** copying `targetProviders`, `gateway.order`, or `plan.plannedOrder` into `actualProvider`. Gateway `order` is only the priority hint sent on the planner/unknown path; it does not prove which provider served the response.
- **Bad:** replaying an SSE request after the first valid event has been written.

### 6. Tests Required

`test/integration.test.js` is the required black-box boundary suite. Changes in this scenario must assert:

- repeated session, parent/child identities, and stable opening messages select the same account; request-id-only requests use round-robin;
- caller prompt/session keys are preserved; explicit Codex/Claude header/metadata identities derive one stable upstream key across retries/account replacement; message fallback derives none; ordinary logs contain only safe source/confidence/applied/cache-hit facts;
- HRW rank is independent of account input order, and removing one account remaps only sessions that ranked that account first;
- direct-pipeline named attempts use singleton `provider.only`, contain no `order`, keep identical Authorization, and apply `maxRetries` as a real outer-attempt cap after health planning and candidate exclusion;
- planner and unknown pipelines send one HTTP body whose `providerOptions.gateway.only` and `.order` are the same filtered allow-list, and do not walk that list with a second provider HTTP attempt; `test/gateway-multi-only.test.js` covers that body, direct regression, stream/non-stream actual provider, stickiness, and error-text recovery;
- `strict first follows source order, retries and preferred follow provider-model success rate, singleton-only and safe failures` covers the direct pipeline: cold strict source order, strict retry and preferred health order, `maxRetries` capping, unknown-rate null-last ordering, model isolation, excluded/all-hard/cooling/auto/discovered candidate sources, and the bounded `providerPlanSource`/`providerMode`/`providerSelection` projection;
- `retry rules stop deterministic request errors before remaining providers or account replacement and stay independent from health` covers the exact `502 + system message must have content` stop, case-insensitive body ANY, HTTP-200 envelope and pre-stream SSE forms, status-only/body-only misses, first-match ordering, compatible continue default, account-replacement blocking, paired-ignore independence, and needle/rate absence from logs and metadata;
- `retryRules management API validates strictly, preserves old-client omission and keeps config bytes on rejection` covers strict schema/size/ID/condition rejection, old-client omission preservation, and byte-preserving rejection;
- `rule actions record exactly the declared direct health sample and disposition per scope` covers the 0/1/1/1 sample matrix together with cooldown/hard-quarantine dispositions;
- discovered providers become named attempts, a completely empty candidate source uses one unattributed auto attempt, all-excluded sends none, active durable cooldowns are skipped, expired cooldowns recover in place, and all-cooling fails safely instead of bypassing state;
- a positive `providerCooldownMs` additionally skips repeated allowed failures (500/504/network/timeout/429/unavailable) and admits one concurrent half-open owner; zero disables only that per-account circuit, while 502/parameter/auth/proxy/cancel outcomes do not open that circuit;
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
- authenticated `POST /v1/responses` and `POST /v1/messages` convert through the Chat chain; unsupported subset fields return protocol-shaped 400 with zero upstream/lease; Chat aliases remain unchanged; heal/id/stream-fail/reasoning-replay contracts are pinned by `test/tool-pairing.test.js`, `test/protocol-ids.test.js`, `test/reasoning-replay.test.js`, adapter unit tests, and `test/protocol-integration.test.js`;
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

- `cachePoolTargetFor()` is the only target owner: `cachePoolSize === 0` returns `0`; otherwise it returns `Math.min(max, Math.max(min, Number.isInteger(META.cachePoolTargetSize) ? META.cachePoolTargetSize : min))`. `META.cachePoolTargetSize` is the single persisted grow-only **numeric** value, applied independently to each owner's eligible candidate set; member IDs and per-key targets are never persisted. Growth in one owner pool can enlarge another owner's derived active set without permitting cross-owner leases; admin `cachePool.scope: 'per-client-key'` and summed `actual` counts report that meaning.
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

- `sessionBindings` is a process-local `Map<fingerprint, entry>` keyed by the existing `extractSessionIdentity()` HMAC fingerprint (for additional owners, namespace the fingerprint by stable key ID; keep Legacy mapping unchanged). Entries are `{ accountId, source: 'explicit' | 'fallback', expiresAt, lastUsedAt, state: 'provisional' | 'confirmed', generation, ownerRequestId }`. Raw sessions/messages, candidate lists, entry account maps and hash prefixes are never persisted, projected to logs, or listed by an API.
- TTL is sliding and source-dependent: `explicit` identity uses `sessionBindingExplicitTtlMs` (default 2h), `fallback`/`message_hmac` uses `sessionBindingFallbackTtlMs` (default 15m). A hit calls `touchSessionBinding()`, which refreshes `expiresAt`, updates `lastUsedAt` and re-inserts at the Map tail so insertion order is the LRU order.
- `pruneSessionBindings()` lazily deletes expired entries (bounded to 256 scanned entries per partial pass, full scan only during reconciliation) and then evicts Map-head entries while `size > sessionBindingMaxEntries`. There is no periodic timer; restart naturally empties the map.
- `findSessionBinding()` returns `{ entry, result: 'hit' | 'provisional' | 'miss' | 'invalidated' }`; an expired entry or an account outside the valid active set is deleted with `result: 'invalidated'`.
- `createProvisionalSessionBinding()` runs after a real lease is acquired and before the first native attempt. It returns a token `{ fingerprint, accountId, generation, ownerRequestId, owned: true, committed: false }` or `null` when there is no fingerprint, the source is `none`, or no `ownerRequestId` exists.
- The native chat transport calls `attemptOwner.onAttemptCommit()` immediately after `req.end()` hands a real request to Node, which calls `commitSessionBindingSelection()`: the entry is set to `confirmed` only when generation and account still match, then touched.
- `cleanupSessionBindingSelection()` removes an entry only when the token is owned, not committed, still `provisional`, and both `generation` and `ownerRequestId` match. A selection that never produced a native attempt (local validation/routing failure, cancellation before `req.end()`) therefore cleans up after itself, while a stale finalizer can never overwrite or delete a newer binding for the same session. Concurrent first requests for one session read the provisional entry and converge on one account.
- Invalidation seam (one function per trigger, all delegating to `deleteSessionBinding`/`invalidateSessionBindingsOutside`, and the two bulk invalidators notify capacity waiters after a removal): account deletion, **client owner reassignment or key revocation (including provisional entries)**, disablement, key or proxy identity rotation, `persistAccountAction()` cooldown/hard-quarantine, manual account save removing an account from the active set, and a quota snapshot whose pool becomes `reserve` (`maximum >= 95`). Positive low slots additionally invalidate on quota hold/exhaustion and when an older high binding must yield to an admissible low. `reserve` classification and durable `quota-exhausted` are distinct: only a known 100% window confirms the latter (including a partial snapshot). `reconcileSessionBindings()` prunes expiry and drops entries outside the current active set; it runs on account save, account recovery, quota job settlement and summary reads.
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

## Scenario: Independent account quota exhaustion protection

### 1. Scope / Trigger

Protect against repeated real account-quota failures without using configurable `errorRules` as the policy switch or adding another quota network queue. The $50 monthly reference cap is the current operator-confirmed same-plan assumption, not a real bill. See `database-guidelines.md` for strict persisted configuration/state fields.

### 2. Signatures

```text
GET/POST /api/accounts                    quotaProtection: { monthlyThresholdUsd }
POST /api/accounts/quota-recover           exact { id: <existing stable account ID> } -> { ok: true }
GET /api/statistics                       account.quota.protectionMonthlyAt,
                                          protectionShortWindows, protectionRetryAt,
                                          protectionPendingUntil, protectionPersistence
signalQuotaProtection(account)
reconcileQuotaProtection(id, snapshot)
requestQuota(id, { protection: true })    same quotaJobs/queue/timer, even if quota-pool routing is off
```

### 3. Contracts

- Only a real pre-output upstream HTTP 429 with explicit structured account/subscription quota evidence **and** matching bounded/redacted failure text signals protection; an already fresh complete 100% snapshot may classify as `fresh_account_quota` but cannot suppress this separate signal. Generic Provider 429, HTTP-200 envelopes, post-start SSE, local RPM and cancellation do not qualify. One process-local provisional admission hold lasts at most 30 seconds; failed/unknown verification cannot create a monthly ban.
- A new successful post-signal monthly window with community-reference remaining **strictly below** `quotaProtection.monthlyThresholdUsd` (default $0.20 of $50) installs separate `protectionMonthlyAt`. Monthly-only partial success may confirm the month, not short-window recovery. All lease paths exclude the ban regardless of quota-pool mode. Refresh/reset, ordinary rule recovery, restart, key/proxy rotation and full account saves do not release it. Only exact-ID admin recovery or account deletion does; the browser confirms the possible repeat-failure risk.
- If the atomic metadata write fails, the current process still blocks admission and authenticated projections say `protectionPersistence: 'pending'`, not `'persisted'`. The **existing quota timer** retries the current META with bounded backoff even with routing off or the account disabled; a successful full atomic META write clears the pending marker without an extra quota fetch. An uncommitted ban cannot survive a restart while storage remains unwritable: repair storage and verify persistence first.
- A successful quota snapshot with 100%-used 5h or weekly window adds a separate confirmed short-window hold. Earliest valid exhausted-window reset schedules a recheck, never direct release. Missing reset uses existing bounded cadence. Only a **new complete successful three-window** snapshot with every `percentUsed < 100` releases the short hold; failure, partial data or one recovered window cannot. The monthly ban has priority. Key/proxy rotation fences pending/short evidence, not monthly bans; disabled/unkeyed accounts retain evidence but do not keep the quota timer armed until re-enabled.
- Keep provider/account attempts, original upstream status, retry rules, SSE replay/cancellation and ordinary-log redaction unchanged. An all-held pool fails fast with a safe explanation and `Retry-After`; the local request row has `selectionReason: 'quota-protection'`, `errorCategory: 'quota_protection'`, no upstream status or attempts, rather than a fabricated capacity/RPM/upstream failure.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Threshold not a finite two-decimal number in $0.01–$50.00, or unknown config fields | Strict management save 400 before mutation; malformed persisted canonical value fails startup without replacing bytes; older omission preserves the current value |
| Monthly reference remaining equals the threshold, or month is missing/stale/failed/not newer than trigger | No new monthly ban; known $0.00 is distinct from missing |
| No matching real status, explicit account evidence or redacted content | No new protection signal or quota refresh on that basis |
| Confirmed short hold, then reset time arrives without complete successful three-window evidence | Stay blocked; schedule a bounded recheck only |
| Metadata write fails after confirmed ban | In-process block with pending persistence and bounded retry; no promise of survival if restarted before a successful write |
| Wrong/extra/missing recovery ID or no monthly ban | Safe 400/409; no state change; ordinary rule recovery never clears monthly ban |

### 5. Good / Base / Bad Cases

- **Good:** account A's matching 429 triggers one deduplicated post-signal quota job while B remains usable; a $0.19 monthly reference remainder bans A until explicit recovery, even after restart.
- **Base:** exactly $0.20 does not ban; a failed quota refresh releases only the bounded provisional hold, not a fabricated durable state.
- **Bad:** treat any 429 as account quota, take the minimum percent and multiply by $50, clear the ban on monthly reset/key rotation, or report a failed write as persisted.

### 6. Tests Required

`test/quota-protection.test.js` uses temporary `DATA_DIR`/mock upstream to assert AND/equality/custom threshold, pool-off deduplication, 5h/week/month combinations, partial/failed snapshots, restart/manual release/key rotation, streaming/cancellation and safe local logs. Fault-inject metadata rename failure: original bytes unchanged, current account blocked, pending projection visible, another account unaffected, bounded retry persists then survives restart; before successful persistence, restart limitation is explicit. UI production-VM/static tests cover exact admin action, confirmation, threshold validation/round-trip and accepted-state reload; no save is sent for an invalid draft. Run the full project gate and real-browser narrow/keyboard/confirm smoke for interactive changes.

### 7. Wrong vs Correct

```js
// Wrong: provider limit or timer alone becomes a durable ban/recovery.
if (status === 429 || Date.now() >= resetAt) toggleBan(account);
// Correct: require the full signal, then the existing quota job supplies new
// validated evidence. The timer only schedules a recheck; admin alone clears
// a confirmed monthly ban.
```

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

## Guided account workflow regression gate

Run `test/account-workflow.test.js`, `test/workflow-integration.test.js` and `test/workflow-ui.test.js` plus the existing routing/admin/UI suite when changing workflow contracts. Prove active-cache and client-owner boundaries, cap/RPM admission, equal-counter concurrent selections, zero-count binding hits, temporary overflow retaining bindings, replacement exclusions, same-account Provider retries, restart and new-account0 catch-up. Preserve legacy behavior when disabled. Preview must not prune metadata, create bindings, advance counters or invoke upstream. Reset must check revision/admin/CSRF, include disabled/standby owner members, and publish only after successful persistence.

The optional `accountWorkflow.healthFilter` is off by default and its default editable `minimumHealth` is 0.2. Filter only rates strictly below the threshold; a rate backed by fewer than `MIN_ROUTING_HEALTH_SAMPLES` (20) samples is unknown for routing (`routingHealthRate()`), so one failure cannot exclude an account for the 24h window, while API projections keep the measured rate; unknown account health enters this filter as 1.0 while the measured sample count stays zero/null, including when `unknownHealth` is `unknown-last` for the separate health-priority selector. Recheck a binding against the health gate on each new request before leasing it; invalidate an unhealthy binding and count its replacement as a real new selection. Preview and runtime use the same gate, and an empty filtered pool returns a specific error. A policy save affects later requests and does not revoke already-held leases. Cache account-health projections for workflow admission within a statistics generation and minute, clearing on statistics pruning/commit and account saves; do not cache occupancy, RPM or hard eligibility. Ranking, capacity/RPM reservation and counter increment remain synchronous in one Node event-loop turn. This guarantee is process-local, consistent with the single-process Docker/Compose entrypoint; multiple workers or instances sharing a data directory require a separate shared atomic owner.

#### Workflow `roundrobin` selector and drain tier

- `roundrobin` in `rankWorkflowCandidates()` is least-recently-selected first: ascending `selectionCounters.accounts[id].lastSelected` (missing = 0), ties by stable account ID; it never rotates by the `sequence` cursor. A capacity-skipped account keeps its old `lastSelected`, so it is next once idle; a new account is chosen once and then joins rotation. Binding hits do not update `lastSelected`.
- Quota grouping uses `quotaPoolFor(maximum, drainSettings())`: `< warmThreshold` (default 80) hot, `< upper` warm where upper is `drainThreshold` only while `drainActive()` (`accountWorkflow.enabled && accountPipeline.drainEnabled`) and 95 otherwise, then `drain` for `< 100` while active, else `reserve`. With drain inactive and `warmThreshold` 80 this is byte-for-byte the previous 80/95 projection.
- Drain accounts join the active cache set **in addition to** the target (they never displace an ordinary member or its binding); `cachePool.actual.drain` appears only while drain is active. `effectiveMaxConcurrent(account)` = `min(maxConcurrent || ∞, drainMaxConcurrent)` for drain accounts and is the only limit used by `accountHasCapacity()`, `poolWaitBudget()`, `growCachePoolOne()` and the `/api/accounts` `effectiveMaxConcurrent` projection (`maxConcurrent` stays the configured value).
- Workflow new selection, temporary overflow and replacement rank the drain tier first, then the rest, each with the configured selector; the quota filter never removes drain accounts; binding hits are unchanged. The existing `capacity` decision node carries optional `drainAfter` (no extra node; decisions stay ≤ 8). Preview evaluates drain from the draft policy/pipeline snapshot.
- Drain leases get `quotaRole: 'low'`, and the waiting-refresh/exhausted lifecycle (`lowQuotaProtectionApplies()`) applies to drain accounts even when `cachePoolLowQuotaSize` is 0 (a held former drain account stays held while its snapshot is exhausted `reserve` or stale/failed `unknown`; only a fresh full hot/warm snapshot reconciles it away); ordinary accounts keep the old `lowSize > 0` gate. Legacy/Pipeline paths never see `drain` because it requires the workflow.
- Tests: `test/drain-tier.test.js`, `test/account-workflow.test.js` (LRU), `test/account-draft.test.js` (controls).

## Scheduled account-scoped Provider validation

### 1. Scope / Trigger

Use this scenario for the default-on, potentially billable scheduled checks of already-known channels for subscribed models. Chat account leasing and manual probes keep their existing owners. No real upstream calls or production rollout are authorized by local tests.

### 2. Signatures

```text
config.json: providerProbeSchedule = { enabled: boolean, intervalMs: integer,
  maxPerRound: integer, maxPer24h: integer, failureThreshold: integer }
GET  /api/providers/probe-schedule -> { schedule, budgetRemaining, budgetReserved,
  nextDueAt, running, persistenceWarning, coverage, cells }
POST /api/providers/probe-schedule <- exact providerProbeSchedule object
POST /api/providers/probe-recover <- exact { accountId, model, provider }
```

All are independently admin-authenticated; unsafe methods require existing CSRF/Origin/transport checks. `coverage` separates `eligible`, actual native `sampled`, `deferred`, `capacitySkipped`, `storageSaturated`, and snapshot truncation. A cell is an account-specific `(resolvedModel, provider)` observation, not global health, pin enforcement, or proof of a cache hit. Neither private MAC key nor identity digest is returned.

### 3. Contracts

`providerProbeSchedule` is enabled by default: 300000ms cadence, at most two native chat calls concurrently, two calls per round by default (configurable 1–10), and 100 pre-send debits per rolling 24h (admin-configurable bounded integers). Reuse quota scheduler's timer and per-account lease/RPM permit and account-bound native transport; no startup catch-up, no automatic catalog expansion. A synchronous same-directory metadata atomic write must succeed before sending each scheduled native request; on failure skip and release the uncommitted RPM permit. A debit is conservative even when transport later aborts, and this budget is per DATA_DIR/process, not a distributed lock or dollar cap. Shared DATA_DIR among simultaneous instances is unsupported. The 5000-cell evidence budget is independent of the rolling paid-call limit: full storage evicts only the oldest non-held/non-pending cell (prefer unknown/zero-streak), never a held verdict; all held/pending skips a new combination before lease/RPM/call/debit while existing held combinations may still be budgeted for recovery. A persisted `pending:true` cell reserves the evidence slot with its budget debit before sending and survives crashes as unknown (or retains an earlier held verdict); only completed reliable evidence changes holds. A failed completion write leaves its durable debit/pending marker and old hold unchanged, but clears in-process pending admission after the failed call so that a later round can retry once storage recovers without restarting. Management coverage counts committed native calls, separately counts `capacitySkipped`, and exposes `storageSaturated` without implying that selecting a candidate was a real call. A single batch runs at most two bounded workers (no second work queue). For a complete candidate snapshot, keep account/model/provider source order stable and advance the tier's pick ordinal; do not also rotate that list by the same ordinal (two accounts/two models would cancel and repeatedly select the first). When the 5000-cell or 200-model snapshot is truncated, rotate the account and model starts by each tier's opportunity ordinal, and select within that window by the quotient after the full account×model phase, not by that same rotation index. A single-slot reserved cold opportunity occurs once per five rounds and advances its own derived ordinal by one per cold opportunity, rather than skipping five cold candidates. Hot and cold ordinals are derived from the persisted round/cursor owner; no extra queue, per-triple cursor or second persisted store is created. Under a static finite eligible set with enough ongoing budget/admissions, each tier traverses all of its finite windows and pool entries; a limited daily budget does not promise near-term full coverage.

`metadata.json.providerProbe.cells` contains only bounded `(accountId, resolvedModel, provider)` verdicts with `checkedAt`, `lastReliableAt`, separate-round `lastRound`, streak, held and `reliable`/`unknown` evidence. Unknown resampling updates checkedAt but never renews the last reliable evidence time; a held row becomes stale from the latter without automatically releasing its hold. Only HTTP success with actual Provider matching the target is reliable success; structured explicit provider-specific 4xx may be a reliable failure. Generic 429/5xx, even structured-but-account/auth/quota-labelled 4xx, account/proxy/network/local RPM, malformed/empty response, mismatched actual and absent pin evidence are unknown, and scheduled calls never mutate account/provider chat health, cooldown or statistics. Manual probe endpoints remain independent. Three separate reliable bad rounds hold only that account's route; one later reliable successful scheduled check or exact admin recovery removes the hold. The planner filters manual exclude and hard/cooldown first, then per-account holds **before** a session Provider hint. If all otherwise safe candidates are held, only the original first safe Provider receives at most one attempt; that request's bounded attempt trace uses `providerSelection: 'probe-exploration'` to explain the exception, with no account replacement after its failure. Disable stops new probes but retains holds; identity/route changes invalidate affected verdicts. Config file edits outside the API conservatively clear verdicts on restart while retaining the paid-call budget. Recovery and status endpoints require admin session and CSRF on writes.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing legacy schedule/key/metadata | Migrate to default-enabled bounded schedule and empty evidence; old mtime-only cells lose their unprovable verdicts, but paid-call budget survives |
| Malformed persisted JSON, explicit private key, digest, cell or budget | Fail startup without overwriting operator bytes; do not turn corruption into a fresh budget |
| Invalid or incomplete admin schedule object | HTTP 400 before write; old complete account/config saves omitting the field preserve it |
| Unknown/missing exact recovery cell or bad account/model/provider | 409 for missing cell; 400 for invalid triple; never clear manual exclusion/hard quarantine |
| Budget exhausted, lease/RPM unavailable, or 5000 held/pending cells for a new triple | No automatic model call; capacity skip uses no budget/lease/RPM and is visible in authenticated coverage |
| Evidence-slot/budget atomic write fails | No call, no in-memory reservation; keep prior bytes, release pending permit |
| Post-call result write fails or process crashes | Keep conservative debit and pending/previous held evidence, never publish a false reliable result; retry later or conservatively normalize pending on restart |

### 5. Good / Base / Bad Cases

- **Good:** account A's channel fails reliably in three distinct scheduled rounds, only A avoids it; a later reliably matching actual Provider or exact administrator recovery clears that hold. A different account B stays eligible. A 5001st triple evicts one non-held slot before debit and stores its result.
- **Base:** no known channel, no admissible account, unknown actual Provider, expired budget, or disabled schedule does not fabricate success/failure. When all otherwise safe channels are held, one normally ordered channel may receive exactly one chat attempt, with no account replacement or second held retry.
- **Bad:** a 5001st triple spends budget without evidence space; a full all-held table evicts a held record; a session hint revives a held/excluded channel; a new account inherits an old owner's evidence; a 429/proxy/empty 16-token response becomes a trustworthy Provider failure.

### 6. Tests Required

Use temporary `DATA_DIR` and local mock upstreams in `test/integration.test.js`: no startup burst; 2-per-round/100-per-rolling-24h default and configured 10-per-round with only two concurrent native calls; pre-send atomic failure, restart, two workers competing for a final slot, 5000 non-held then 5001st, all-held skip and held recovery, failed completion write followed by in-process retry, MAC/migration/same-mtime identity edits, hot/cold single-slot fairness and >5000 candidate-window rotation, owner/route/SSE/RPM/shutdown boundaries. `test/account-draft.test.js` and `test/ui-contract.test.js` assert stale draft, bounded status and escaping. Run the full environment-scrubbed project gate. Native keyboard/focus/live-status/narrow-width behavior needs separate real-browser evidence, not a VM claim.

### 7. Wrong vs Correct

```js
// Wrong: pay before checking whether the evidence store can retain this triple.
reservePaidBudget(); await sendProbe();
if (Object.keys(cells).length >= 5000) return; // result discarded

// Correct: synchronously reserve a safe evidence slot and budget in one atomic
// metadata replacement BEFORE handing the existing native transport a call.
const slot = probeEvidenceSlot(key);
if (slot.blocked) return reportCapacitySkip();
const reservation = reserveScheduledProbe(key, round);
if (!reservation.ok) return releasePermitWithoutCall();
await sendAccountBoundProbe();
```

Never infer channel health from a successful HTTP status alone; match the reported actual Provider or retain `unknown`.

## Scenario: Global upstream egress proxy pool

### 1. Scope / Trigger

Use when changing `resolveEgress()`, the egress/connect-phase tracking inside `clineRequest()`, `egressStep()`, `lib/proxy-pool.js`, `lib/floppydata-source.js`, the `/api/proxy-pool/*` routes or the `proxyPool` / `proxyPoolClientKeys` configuration. The Cline edge rate-limits by **egress IP** (about 70 requests per ~60 s, answered with HTML 429 regardless of key or account), so one shared outbound IP throttles every account at once. The opt-in global pool spreads each keyed upstream call over many egress entries. It never changes account selection (HRW, bindings, cache pool, quota role and leases stay account-keyed). Absent or disabled, every path is byte- and behavior-identical to the pre-pool code. The persisted schema is in `database-guidelines.md`; log fields and redaction are in `logging-guidelines.md`.

### 2. Signatures

```js
// lib/proxy-pool.js (pure; clock, random and agent factory injected)
normalizeProxyUrl(value, { strict = false })
normalizeProxyPool(value, { strict = true, secret })   // secret enables entry-id collision checks
normalizeProxyPoolClientKeys(value, { knownIds = ['legacy'], strict = true }) // -> { default, overrides }
PROXY_POOL_CLIENT_KEYS_DEFAULT                          // frozen { default: 'on', overrides: {} }
entryIdFor(secret, normalizedUrl)                       // HMAC-SHA256 hex, first 8 chars
parseRetryAfter(value, now)                             // seconds or HTTP-date -> ms clamped 1000-600000, else null
createProxyPoolRuntime({ secret, now, random, createAgent, destroyAgent, retireGraceMs, rpmWindowMs })
  .configure(cfg) .replaceEntries(urls) .pickEntry({ exclude }) -> { entry: lease | null, retryAt }
  .hasAvailable(exclude) .earliestRetryAt({ exclude }) .noteFallback() .sweep()
  .status() .secretSeeds() .sampleEntries(limit) .destroyAll()
// lease: { entryId, endpointKey, scheme, commit(), release(), noteThrottle(ms), noteConnectFailure() }
//        non-enumerable url and lazily created agent

// lib/floppydata-source.js
createFloppyDataSource({ getConfig, fetchImpl, now, setTimer, clearTimer, onBatch, onStatus,
  normalizeUrl, random, concurrency = 8, timeoutMs = 15000, backoffBaseMs = 30000 })
  .start() .stop() .refresh() .reconfigure(prev, next) -> "restart" | "reschedule" | "none"
  .balance() -> { availableBytes, availableGb, expiringAt } .status() .running
FLOPPYDATA_ERRORS = ['unauthorized', 'insufficient_balance', 'rate_limited',
  'upstream_error', 'network', 'invalid_response']
```

```text
GET  /api/accounts      -> proxyPool: effectiveProxyPool() (defaults when absent; plaintext entries/apiKey, admin only)
                           proxyPoolClientKeys: effectivePoolClientKeys() (default object when absent)
POST /api/accounts      <- optional proxyPool (complete object; omitted keeps the server value)
                           optional proxyPoolClientKeys { default: 'on'|'off', overrides: { [clientKeyId]: 'on'|'off' } }
GET  /api/proxy-pool/status  -> { enabled, source, strategy, total, available, retiring,
       fallbacks: { total, recent }, floppydata: <status> | null,
       clientKeys: [{ id, name, mode: 'default'|'on'|'off', effective: boolean }], // Legacy first; never key values
       entries: [{ entryId, scheme, endpointKey, state: ok|cooldown|rate-limited|retiring,
                   cooldownUntil, reason: throttle|connect|null, rpmUsed, inFlight,
                   recent: { requests, throttled, connectFailures } }] }
POST /api/proxy-pool/refresh <- {} | { wait: boolean } (any other field/type -> 400)
       -> 202 status projection (batch started or already running; the console polls GET status, bounded)
       | 200 status projection (wait: true and the batch settled within PROXY_POOL_REFRESH_WAIT_MS = 30000)
       | 409 unless enabled && source=floppydata && anyClientKeyUsesProxyPool()
GET  /api/proxy-pool/balance -> 200 { ok: true, availableBytes, availableGb, expiringAt }
       | 409 { error: { message, code: 'unauthorized' } } (no apiKey)
       | 502 { error: { message, code: <FLOPPYDATA_ERRORS> } }
POST /api/proxy-pool/test    <- {} | { sample: 1-50 } -> 200 { results: [{ entryId, ok, ms, status?, errorCategory?: 'timeout'|'proxy' }] }
```

All four `/api/proxy-pool/*` routes use the existing admin Cookie/CSRF boundary, reject any query string with `400` and other methods with `405`. Runtime env: `CLINE_PASS_PROXY_FREE_SOCKET_TIMEOUT_MS` (see `database-guidelines.md`).

### 3. Contracts

- **Non-stream chat bypasses the pool.** `runChatChain()` takes `poolEligible` (default `true`); the client chat call site passes `poolEligible: isStream`. When `false`, `egressHint.skipPool` makes `resolveEgress()` skip the pool branch (egress is the account `proxyUrl` or direct, `poolFallback` stays false, `noteFallback()` is not called) and `poolEgressExpected()` is false, so the account-level HTML-429 backoff and single same-egress retry apply. Reason: the residential gateway drops a connection after ~50 s without data, and a non-stream generation sends nothing until it finishes (production logs: every pooled non-stream request lasting >= 50 s failed, 21 of 21, while the same requests without the pool succeeded). Management/short calls (`/api/accounts/test`, quota refresh, probes, catalog) keep `poolEligible = true`. Pool-path tests therefore default to streaming requests (`s.chat()` / `s.chatFull()` default `stream: true`).
- **Session stickiness.** `runChatChain()` takes `sessionKey` (`identity.fingerprint` only when `identity.confidence === 'explicit'`; the fallback first-message HMAC is excluded because unrelated users can share it and overheat one entry) and carries it as `egressHint.stickyKey` into `resolveEgress()` → `pickEntry({ stickyKey })`. Without a key (management, quota refresh, probes, fallback-fingerprint chats) selection follows `strategy`. With a key the runtime picks by rendezvous hashing: highest HMAC(`secret`, `sticky\0key\0entryId`) among available **active** entries; it ignores `strategy` and never moves the round-robin cursor. No config field, so older images are unaffected.
- **Cross-swap retention.** The runtime setting `stickyRetentionMs` is derived by `poolStickyRetentionMs(pool)` in `server.js` (not a user config field): FloppyData `rotation` minutes (5/10/15/20/60), `rotation 0` capped at 60 min, `-1` and the manual source `0`. When `> 0` the runtime keeps a bounded LRU `bindings` map (stickyKey → entry state, 20 000 keys): a session binds on its first pick and keeps that entry while it is available, **including after `replaceEntries()` dropped it from the batch**. A dropped entry with `bound > 0` and age `< stickyRetentionMs` (`bornAt` = import time) moves to `retained` (`where: 'retained'`: selectable only through a binding, excluded from `active`, `total`, `available`, round-robin, random, HRW and `hasAvailable`; status state `retained`); other dropped entries retire as before. `sweep()` retires retained entries at `bornAt + stickyRetentionMs` or when `bound` reaches 0; `retire()` still defers destruction until `inFlight` drains. A bound entry that is cooling, rate-limited or excluded is replaced for this call by the HRW choice among active entries **without changing the binding**; an expired/destroyed binding is dropped and rebound. `replaceEntries(urls, { retain: false })` (pool disabled, source switch, no key using the pool, FloppyData identity restart) and `configure({ stickyRetentionMs: 0 })` release every retained entry and clear all bindings; `onBatch` swaps use the default `retain: true`. `secretSeeds()`, `destroyAll()` and `status()` include retained entries.
- **Selection.** `pickEntry()` sweeps expired retirees, then considers active entries not in `exclude` (by URL or entry ID), with `cooldownUntil <= now` and, when `maxRpmPerProxy > 0`, live committed+reserved count below the limit in a 60 s rolling window. `round-robin` scans from the global cursor and stores `index + 1`; `random` draws uniformly with `crypto.randomInt` among available entries. The returned lease reserves one entry RPM slot and increments `inFlight`. `clineRequest()` commits it right after `req.end()` (same seam as the account permit) and releases it on response end/close or failure; an unsent request refunds the reservation. Entry RPM is independent of the account `maxRpm` permit, which is still taken for every real attempt.
- **Entries and generations.** `replaceEntries()` is the only mutation for manual saves and FloppyData batches. Same-URL entries keep their health state; a changed list bumps the generation and resets the cursor. Removed entries with `inFlight > 0` move to `retiring` (never selected; in-flight requests and long SSE streams finish on their agent) and are destroyed when the last lease releases, or by the sweep after `SSE_STREAM_IDLE_MS + 60000`; idle removed entries are destroyed at once. Runtime entry-ID collisions are dropped. Health state lives only in memory and resets on restart or batch swap.
- **Connect phase.** Before the socket is connected (reused keep-alive socket, `secureConnect` for HTTPS targets, `connect` otherwise) a failure on a sent, unaborted request without a response sets `egress.connectPhase = true`; for a pool lease it calls `noteConnectFailure()` (cooldown `failureCooldownMs`). Pool calls also arm `connectTimeoutMs`; expiry destroys the request with `proxy connect timeout` and settles immediately even while the proxy handshake is still pending. Errors after connection never cool an entry. HTML 429 cooling (`noteThrottle`) and both connect rules run inside `clineRequest()`, so every keyed path reports entry health, but only the chat chain switches entries: catalog, quota, probe, validation and `/api/test` calls make one attempt and do not run `egressStep()`.
- **Account isolation.** A pool connect failure is classified `{ scope: 'proxy', evidence: 'proxy_pool_connect', failureClass: 'network' }` and settles with `healthAction: 'none'`, no error/retry rule evaluation, no account degrade/cooldown, and no provider circuit; a pending half-open owner is released. Pool HTML 429 follows the gateway contract above with the pool-specific `Retry-After`. Neither marks the account.
- **Per-client-key scope.** One global pool; the top-level `proxyPoolClientKeys` decides per downstream client key (`legacy` plus `clientKeys[].id`, never the upstream account key) whether that key's accounts use it. Effective mode = own override, else `default`; absent field = `{ default: 'on', overrides: {} }` = the previous global behavior. An account that uses the pool behaves exactly as before (entries, cooldown, egress retry, D10 fallback); an account that does not behaves exactly as if the pool were disabled (account proxy or direct, account HTML-429 backoff with one same-egress retry, no `poolFallback`, not counted by the pool). Every keyed path (chat, quota, catalog, probe, validation, `/api/test`, `/api/accounts/test`) follows the owner because the decision lives in `resolveEgress()`; a call without a saved account (e.g. `/api/accounts/test` with a temporary credential) follows Legacy's mode (`account?.clientKeyId ?? 'legacy'`). Explicit-URL `/api/accounts/proxy-test` and pool-level `/api/proxy-pool/test` are unaffected. Ownership is exclusive, so a pre-stream account replacement inside one client request never changes the owner.
- **Configuration lifecycle.** Startup, `POST /api/accounts` and reload all normalize strictly; `proxyPool` and `proxyPoolClientKeys` are in `ACCOUNT_CONFIGURATION_FIELDS`, so they participate in `configurationRevision()` (an absent field is dropped by `JSON.stringify`, keeping old revisions) and a stale `expectedConfigurationRevision` returns `409`. `applyProxyPoolConfig(previous, next)` runs at startup, after every published account/reload save, and after client-key create/delete: configure runtime settings; disabled → stop FloppyData and `replaceEntries([])`; manual → stop FloppyData and `replaceEntries(entries)` (key scope does not matter, no cost); FloppyData with no key effectively `on` (`!anyClientKeyUsesProxyPool()`) → stop FloppyData and retire the batch (`replaceEntries([])`), and late batches are dropped by the `onBatch` guard; FloppyData newly enabled, newly used by a key, or not running → stop, retire current entries, start (immediate import); FloppyData identity field changed (`apiKey`, `apiBase`, `type`, `country`, `state`, `city`, `protocol`, `rotation`, `count`) → restart and retire the old batch; only `refreshIntervalMs` changed → reschedule. Switching modes never invalidates account quota, bindings, circuits, RPM or probe cells.
- **FloppyData import.** One batch makes `count` calls to `POST {apiBase}/v2/proxy/rotating/connections` with `X-Api-Key`, at most 8 concurrent, each with a 15 s timeout and a unique alphanumeric `session` = `cps` + base36 epoch ms + 2 random base36 chars + call index. `connection.connectionString` must pass strict `normalizeProxyUrl` and match the requested protocol (`socks5` accepts `socks5:`/`socks5h:`); otherwise `invalid_response`. 401/403 → `unauthorized` and 402 → `insufficient_balance` abort the rest of the batch; 429 → `rate_limited`; other non-2xx → `upstream_error`; transport/timeout → `network`. A batch with at least `ceil(count/2)` unique URLs atomically replaces the pool and schedules the next import after `refreshIntervalMs`; a smaller batch keeps the current entries and retries after `min(30000 × 2^(failures-1), refreshIntervalMs)`. Refresh is single-flight (manual refresh joins the running batch). `stop()` cancels timers and in-flight calls only; retiring entries is the caller's `replaceEntries([])`. A batch that arrives after the source was switched or disabled is ignored. FloppyData calls are direct management traffic, never through the pool or an account proxy, and status/errors carry only enums and counts.
- **Management routes.** The status projection contains no URL, username, password or key. `test` samples at most 50 active entries (8 concurrent, 15 s each) and sends the `/api/accounts/proxy-test` empty-messages body through an ephemeral agent built by `createPoolProxyAgent()` with **no** Authorization, lease or RPM permit; any HTTP status counts as `ok: true`, while a transport failure (including a rejected CONNECT) is `ok: false` with `timeout`/`proxy`. It never touches entry cooldown or entry RPM. `balance` calls `GET {apiBase}/v2/account/balances` only on demand and projects bytes, GB (two decimals) and the earliest expiry. The console renders all of these through enum labels only.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| `proxyPool` absent, or present with `enabled: false` | `resolveEgress()` is exactly `account.proxyUrl || direct`; gateway backoff/retry, attribution and config bytes unchanged |
| Pool enabled, account's client key effectively `off` | same as pool disabled for that account: `account.proxyUrl || direct`, `poolFallback: false`, no pool counters, account HTML-429 backoff |
| `proxyPoolClientKeys` invalid (non-object, extra field, `default` not on/off, override for an unknown id, override value not on/off) | startup fails / `400` / reload refused; no write; message has the field path (or a known id) only, never an unknown key or a secret |
| Every key `off` with the FloppyData source | no import; entries retired; `refresh` → `409` |
| Pool enabled, entries available | every keyed call (chat, `/api/test`, probe, validation, periodic probe, `/api/accounts/test`, quota, catalog) uses a pool entry; account proxy and direct receive nothing |
| Pool empty (first FloppyData import pending/failed), all cooling, or all RPM-full | D10 fallback to the account egress for that call with `poolFallback: true`; the fallback counter increments |
| Pool entry HTML 429 / connect-phase failure in chat before first byte | entry cooled; switch entry within `egressRetries` without waiting; exhausted → 429 with pool `Retry-After` 1-60 or the existing 502; never an extra account-egress attempt |
| Error after the tunnel/TLS is established, or client abort | no entry cooldown; ordinary transport/upstream classification |
| FloppyData batch below half, 401/402/429/5xx/network/invalid response | keep the current entries; status `state: 'error'` with the enum; bounded backoff |
| `/api/proxy-pool/*` with a query string / wrong method | `400` / `405` |
| `refresh` while pool disabled or source is manual | `409`; no API call |
| `balance` without a saved `apiKey` | `409` with `code: 'unauthorized'`; FloppyData failure → `502` with an enum code, never the response body |
| `test` body is not `{}` / `{ sample }` with integer 1-50 | `400`; no proxy traffic |

### 5. Good / Base / Bad Cases

- **Good:** three manual entries in round-robin serve six requests A, B, C, A, B, C; random covers every entry over 60 requests.
- **Good:** entry A answers HTML 429; the same request moves to B at once and returns 200; the trace shows two `pool:` IDs, A is skipped until its cooldown ends, and the account has no backoff or degrade.
- **Good:** a FloppyData swap retires the old batch while an SSE stream on an old entry finishes normally; the old agent is destroyed afterwards.
- **Base:** all entries cooling → the next request goes through the account's fixed proxy (or direct) with `poolFallback: true`; pool off restores the account egress immediately after save or SIGHUP.
- **Bad:** retrying a failed pool entry directly or through the account proxy in the same attempt; applying account HTML-429 backoff to pool traffic; letting a pool connect failure degrade the account or open a provider circuit; persisting FloppyData entries to `config.json`.

### 6. Tests Required

`test/proxy-pool.test.js` (normalization defaults/strict paths without secret echo, entry IDs, `Retry-After`, round-robin/random, exclude/`hasAvailable`/`retryAt`, RPM reserve/commit/refund, replace/retire/sweep, collisions, credential-free status and seeds). `test/floppydata-source.test.js` (unique sessions and bounded concurrency, half-batch rule and backoff, 401/402 abort, error enum, timeout, single-flight, stop, reconfigure, balance projection, secret-free status). `test/proxy-pool-config.test.js` (legacy byte stability, strict API/startup validation and revision, round-robin override and fallback, SIGHUP toggle, handshake failure and connect timeout cooling, FloppyData start/stop). `test/proxy-pool-config.test.js` also covers `proxyPoolClientKeys` byte stability, strict 400/startup/reload rejection, revision, SIGHUP and client-key deletion pruning. `test/proxy-pool.integration.test.js` (per-client-key egress/backoff/quota/probe/status with two keys, FloppyData stop/retire/re-import by key scope, 68c6158-image preservation of `proxyPoolClientKeys`, HTML 429 switch without account backoff, refused entry, exhausted 429 `Retry-After`, `maxRpmPerProxy` fallback, quota/catalog through the pool, credential-free logs/metadata/APIs and `proxyHealth` attribution, random coverage, authenticated HTTP CONNECT and 407 conversion, SSE-safe batch swap, HEAD-image rollback compatibility). `test/proxy-pool-ui.test.js` covers the console card. All fixtures use local fake upstreams, proxies and FloppyData API (`test/proxy-pool-fixture.js`); none contact `api.cline.bot` or `api.floppydata.net`. Run the full environment-scrubbed `npm test` and `git diff --check`.

### 7. Wrong vs Correct

```js
// Wrong: on a pool failure, "help" the request by trying the account egress or direct.
catch (error) { if (egress.kind === 'pool') return clineRequest(url, { ...opts, proxyUrl: account.proxyUrl }); }

// Correct: exclude the failed entry and let egressStep pick another entry or stop.
const next = egressStep(result, attempt); // adds egress.url to egressExclude
if (next === 'retry') { index--; continue; } // same provider, new entry, no wait
if (next === 'stop') break;                  // final 429 (pool Retry-After) or 502
```

D10 fallback is a selection outcome (`pickEntry()` returned no entry), not a failure-recovery path.
