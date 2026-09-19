# Backend Quality Guidelines

> Executable contracts for account routing, upstream transport, and administrative APIs in the zero-dependency Node server.

---

## Scenario: Account-bound chat routing and trust boundaries

### 1. Scope / Trigger

Use this contract when changing `handleChat`, account selection, provider failover, session identity, the native Cline transport, account error actions, or any authenticated management endpoint in `server.js`.

The safety property is two-level routing: select and lease an account first, then run that account's provider chain. Provider failure must not implicitly select another account.

### 2. Signatures

```js
extractSessionIdentity(req, body)
forwardHeadersFor(req, body)
acquireAccountLease(identity, { excludeIds = new Set(), allowOverflow = true })
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
commitStatistics({ ts, globalError, usage, segments, clientDisconnect })
healthProjection(account, now)
quotaProjection(accountId, now)
buildPipelineGroups(accounts)
acquirePipelineAccountLease(identity, options)
refreshQuota(account)
scheduleQuotaRefresh()
```

Chat endpoints:

```text
POST /chat/completions
POST /v1/chat/completions
POST /api/v1/chat/completions
```

Management endpoints relevant to routing:

```text
GET  /api/accounts
POST /api/accounts
GET  /api/statistics
POST /api/accounts/recover
POST /api/accounts/proxy-test
GET  /api/models?accountId=<account id>
POST /api/config
POST /api/test
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
- `ignore` or an unmatched non-429 status continues the provider chain on the same account. For 429, account rules are consulted only after conservative classification proves `scope=account`; provider/unknown 429 never receives an account action and continues on the same Authorization.
- `cooldown` and `ban` stop that account's chain. `handleChat()` permits one replacement account only when either action occurs before `chain.started`. The replacement starts its own health-planned provider route. The two-iteration account loop forbids a third account.

Session identity values are validated, HMACed with `META.routingSecret`, and never logged or persisted. Trusted parent identifiers precede child identifiers. Codex checks parent thread metadata/header before `prompt_cache_key`, session, and thread values; Claude checks parent-agent information before session/agent values. Generic parent headers precede generic current-session fields. `X-Client-Request-Id` alone never establishes affinity. The fallback HMAC input contains only the first system/developer message and first user message (each capped at 4096 characters); if neither is extractable, selection falls back to round-robin.

#### Account-level model routing

The implemented account-level model-routing field is `accounts[].perModel`; there is no `modelRouting` field in the persisted or API schema.

```js
resolveModelConfig(account, modelId)
// own account.perModel[modelId] -> complete account route
// otherwise                         -> config.perModel[modelId] or {}
```

Presence is tested with `hasOwnProperty`; even `{}` is a complete account override. There is no field merge with the global route. A normalized route has exactly:

```js
{ upstream, upstreams, exclude, pinMode, sort, maxRetries }
```

`maxRetries: null` runs all built provider attempts; an integer `n` permits the first attempt plus at most `n` additional outer attempts. The cap is applied after health/cooldown planning.

#### Single-provider attempt planning and health

- Configured `upstreams` are the authoritative provider order. Without a configured order, the stable discovered `META.models[modelId].upstreams` order is used.
- Exclusions are applied before health routing. A known list that becomes empty after exclusion returns a safe no-provider error and never falls back to auto.
- Providers with `cooldownUntil > now` are skipped. All other providers retain source order regardless of `ok`, `degraded`, or `unknown` labels. An expired cooldown returns to its original position for a half-open request.
- If every allowed provider is cooling, exactly one provider fails open: smallest `cooldownUntil`, then source priority. If no provider is known at all, exactly one `auto`/unattributed attempt is allowed.
- Every named attempt injects exactly one provider through `providerOptions.gateway.only` (planner), `provider.only` (direct), or the same singleton in both shapes for an unknown pipeline. `order` is removed even if supplied downstream. `preferred` remains a persisted UI/config mode but its fallback is switcher-managed outer retry.
- A 429 is account-scoped only with a fresh complete 100%-used quota snapshot or explicit structured account/subscription/plan quota-exhaustion semantics. Routing/final-provider or structured provider fields make it provider-scoped. HTML and other ambiguous 429 responses are unknown.
- Provider and unknown 429 update only the named model/provider health entry and continue the same account. Valid delta-seconds or HTTP-date `Retry-After` is clamped to 1 second-30 minutes; otherwise rate-limit cooldown starts at 60 seconds with bounded exponential backoff.
- 5xx/network/proxy/timeout failures use 15-second bounded backoff capped at 2 minutes. Unsupported/unpinnable providers cool for one hour. Success clears failures/cooldown immediately. Account/auth/request/client-disconnect outcomes never penalize provider health.
- Provider health is keyed by `(modelId, provider)` and intentionally shared across accounts. An unattributed auto attempt never creates a named health entry.

#### Header and credential boundary

Protocol allowlists are exclusive:

- Codex: `Originator`, `Session_id`, `Thread_id`, `Session-Id`, `Thread-Id`, `X-Client-Request-Id`, `User-Agent`, `X-Codex-Beta-Features`, `X-Codex-Turn-State`, `X-Codex-Turn-Metadata`, `X-Codex-Window-Id`, `X-Codex-Parent-Thread-Id`, `X-OpenAI-Subagent`, `X-OpenAI-Memgen-Request`, `X-ResponsesAPI-Include-Timing-Metrics`, `X-OpenAI-Internal-Codex-Responses-Lite`.
- Claude: `X-Claude-Code-Session-Id`, `X-Claude-Code-Agent-Id`, `X-Claude-Code-Parent-Agent-Id`, `X-Stainless-Arch`, `X-Stainless-Lang`, `X-Stainless-Os`, `X-Stainless-Package-Version`, `X-Stainless-Retry-Count`, `X-Stainless-Runtime`, `X-Stainless-Runtime-Version`, `X-Stainless-Timeout`, `User-Agent`, `X-App`, `Anthropic-Beta`, `Anthropic-Dangerous-Direct-Browser-Access`, `Anthropic-Version`.
- Generic: `Session-Id`, `Session_id`, `Thread-Id`, `Thread_id`, `X-Http-Session-Id`, `X-Session-ID`, `X-Session-Affinity`, `X-Slot-Session-Id`, `X-Conversation-Id`, `X-Thread-Id`, `X-Parent-Session-ID`, `X-Parent-Session-Affinity`, `User-Agent`, `X-Client-Request-Id`, `HTTP-Referer`, `X-Title`.

Always reject downstream `Authorization`, `Proxy-Authorization`, `Cookie`, `Host`, client `Content-Length`, hop-by-hop headers, `X-Codex-Installation-Id`, and `X-OAI-Attestation`. Account custom Headers are merged after the protocol allowlist and before the system-owned `Content-Type` and `Authorization`. Their names/values are strictly bounded, and credential/session/device/hop-by-hop names are rejected case-insensitively. Custom Headers never participate in session identity extraction. `responseHeadersFor()` always overwrites Authorization with `Bearer ${account.key}`. The native `http`/`https` transport is required for chat forwarding so a missing client `User-Agent` stays missing.

Account keys, proxy URLs/authentication, Header values, and notes are intentionally static account configuration in `config.json` and are returned only through authenticated account administration. They must not appear in `metadata.json`, JSONL logs, traces, error bodies, or diagnostic headers. Raw session values, HMAC fingerprints, and message text must not be persisted; only `sessionSource` and applied safe Header names may be recorded.

#### Account proxy and model alias boundary

- Empty `proxyUrl` means native direct transport. `http:`/`https:` use `HttpsProxyAgent`; `socks5:`/`socks5h:` use `SocksProxyAgent`. The pinned agent versions preserve Node >=18.
- The account proxy applies to account-bound Cline chat/probe/validation/test traffic only. Public catalog/document fetching and management APIs remain direct.
- A configured proxy failure is a proxy/network attempt failure and never retries the same request without an agent.
- `requestedModel` is preserved for diagnostics. `resolvedModel = modelAliases[requestedModel] || requestedModel` replaces outbound `body.model` and owns global/account `perModel` lookup. Aliases are not chained.
- `/v1/models` exposes the de-duplicated union of original visible models and aliases so old clients remain compatible.

#### Abort and SSE lifecycle

- A client socket close aborts the active upstream request.
- The stream path buffers at most the first 64 KiB while waiting for a complete first SSE event. A pre-response error event is normalized and may still trigger provider/account failover.
- After a valid SSE response is exposed (`started: true`), the request is never replayed. Clean completion recovers the named provider; a later classified SSE error updates future provider/account state only, while client disconnect updates neither.
- The account lease stays held until normal stream flush, upstream error, or downstream close. Stream finalization and lease release are idempotent.

#### Usage, statistics, and health

- One request-scoped idempotent finalizer owns statistics commit. Each accepted chat increments the global request aggregate once, and each participating account ID appears at most once in that request's account segments.
- Only explicit normalized upstream usage counts. `0` is known; a missing/invalid field is `null`; input, output, total, cache, or cache ratios are never inferred from another field.
- Non-stream JSON reads its terminal usage object. Streaming retains only the last cumulative usage snapshot while incrementally observing SSE events. Each event is bounded to 64 KiB; an oversized event is discarded through its CRLF/LF boundary, then observation resumes for later events.
- Management, probe, model-catalog, and quota traffic never enters chat statistics or health.
- Health records at most one terminal result per account segment: success `0`, auth `10`, rate-limit `7`, network/proxy/timeout `6`, server 5xx `4`, and other terminal errors `5` penalty units. Ordinary parameter 4xx and client disconnects produce no health result.
- The 24-hour score is `100 - penaltyUnits / (10 * results) * 100`. Fewer than five results or incomplete recent coverage is `insufficient`; otherwise scores are `available >= 80`, `degraded >= 50`, or `unhealthy < 50`. Ban, cooldown, disablement, and missing coverage remain explicit states.
- `GET /api/statistics` is authenticated and returns projected global/account lifetime and 1,440-minute aggregates, coverage-labelled usage/cache metrics, health, quota, and a separately labelled legacy migration baseline. It returns no credentials, raw events, messages, sessions, or raw quota responses.

#### Quota refresh and account pipeline

- Quota refresh calls only `/users/me/plan/usage-limits` in the background, uses the account's proxy without direct fallback, allows at most two concurrent refreshes, caps the body at 256 KiB, and never waits in chat selection.
- Accepted quota rows are only `five_hour`, `weekly`, and `monthly`, each with finite `percentUsed` in 0-100 and an optional canonical ISO reset time. A routing snapshot is fresh only when all three windows belong to the latest successful, non-error attempt and are no older than 15 minutes.
- Account/key/proxy changes and disabling quota routing advance a generation so a stale in-flight completion cannot write or route. Failures retain safe category/timestamps, make routing quota unknown, and retry on a bounded backoff.
- `accountPipeline` has exactly four booleans: `quotaPool`, `excludeUnhealthy`, `healthSort`, and `sticky`. When all are false, `acquireAccountLease()` calls the unchanged legacy selector.
- Enabled pipelines first apply mandatory account eligibility. Optional unhealthy filtering uses deterministic best-score fallback instead of starving all candidates; then quota groups are `hot`, `warm`, `unknown`, `reserve`, followed by health groups `available-or-insufficient`, `degraded`, `unhealthy`.
- Pipeline affinity is applied once before the configured six-mode selector. Capacity fallback may advance to a lower group but cannot bypass mandatory eligibility, and provider retries remain bound to the selected account.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Chat JSON is malformed or not an object | `400`; no upstream request |
| Chat `model` is missing, blank, non-string, or over 300 characters | `400` |
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
| HTTP 200 error envelope has a recognized status/message | normalize and classify before applying account/provider actions; otherwise `502` |
| Ambiguous or non-JSON HTML 429 from Cline | `scope=unknown`; do not cool the account; continue the next named provider on the same Authorization |
| Explicit account quota 429 with a configured removal action | stop that provider chain, do not penalize provider health, and replace the account at most once |
| Every known provider is excluded | no upstream request; safe `503`; never auto-bypass exclusions |
| Error output/history contains a configured key, Bearer token, or request message | replace with `[REDACTED]`; retain the complete structured error reason without substring-corrupting short-message redaction |
| `/api/accounts` mode/wait/rules/id/name/key/capacity/route is invalid | `400`; do not save |
| `/api/accounts.accountPipeline` is missing on an older client | preserve the current server value |
| `/api/accounts.accountPipeline` is non-object, incomplete, has unknown keys, or non-booleans | `400`; do not save |
| Usage field is absent/invalid while another usage field is valid | keep the absent field unknown; count only explicit valid fields |
| A streaming SSE event exceeds 64 KiB | discard that event only; resume at its CRLF/LF terminator and observe later usage |
| A fixed statistics counter exceeds `Number.MAX_SAFE_INTEGER` | persist `null` plus the exact `overflowFields` marker; never wrap or clamp |
| Health input is an ordinary 4xx or client disconnect | no result/penalty unit is recorded |
| Quota body exceeds 256 KiB or its schema/time/percentage is invalid | safe failure category; quota routing becomes unknown; no raw payload persists |
| Quota completion belongs to an old key/proxy/config generation | discard without mutating quota state |
| All four pipeline flags are false | use the legacy six-mode selection path without extra sorting/filtering |
| `/api/config` scope/action/account/model/route is invalid | `400`; do not save |

### 5. Good / Base / Bad Cases

- **Good:** sticky identity leases account A; provider `first` fails and `second` succeeds; both upstream requests use account A's Authorization.
- **Good:** account A receives an explicit account-quota 429 matching configured `429 -> cooldown` before output; its state is persisted without penalizing the provider, its lease is released, and account B starts from B's own first health-planned provider. A second removal action returns an error without selecting account C.
- **Good:** account A receives an HTML 429 from named provider `first`; the error remains unknown, `first` cools, and `second` is attempted with A's unchanged Authorization.
- **Good:** an alias request logs both names, applies the resolved target's account route, and returns the internal request ID used by request/error logs.
- **Good:** a SOCKS/HTTPS-proxied account reaches Cline through its Agent; a bad proxy produces no direct request.
- **Good:** a streaming request receives fragmented events and one oversized event, then commits the final later cumulative usage exactly once.
- **Good:** every account is unhealthy, so `excludeUnhealthy` deterministically retains only the best-score tie set instead of returning no account.
- **Good:** an old quota request finishes after credential rotation; its generation mismatch prevents any state write.
- **Base:** no account-specific `perModel[model]` exists, so the global route is used unchanged.
- **Base:** no identity is extractable, so sticky deliberately behaves as round-robin.
- **Bad:** calling account selection inside the provider-attempt loop; this breaks request-level account affinity.
- **Bad:** forwarding the downstream Authorization or relying on `fetch` for chat transport; either leaks proxy credentials or creates synthetic client headers.
- **Bad:** replaying an SSE request after the first valid event has been written.

### 6. Tests Required

`test/integration.test.js` is the required black-box boundary suite. Changes in this scenario must assert:

- repeated session, parent/child identities, and stable opening messages select the same account; request-id-only requests use round-robin;
- HRW rank is independent of account input order, and removing one account remaps only sessions that ranked that account first;
- planner/direct/unknown-pipeline named attempts use singleton `only`, contain no `order`, keep identical Authorization, preserve configured order among non-cooling providers, and apply `maxRetries` after health planning;
- discovered providers become named attempts, no-known-provider uses one unattributed auto attempt, all-excluded sends none, active cooldowns are skipped, expired cooldowns recover in place, and all-cooling fails open only the earliest provider;
- unknown/provider 429 continues within A, while explicit account 429 can switch A to B without provider penalty; a second removal action cannot select C, and banned accounts leave the candidate set;
- provider health tests cover valid/missing Retry-After, 5xx/transport/unsupported cooldowns, model isolation, success recovery, restart persistence, and late SSE updates without replay;
- account override reports `configSource: "account"`; `action: "inherit"` restores `"inherited"`;
- real allowed and safe account Headers arrive, prohibited Headers do not, downstream Authorization is replaced, and no synthetic User-Agent appears;
- HTTP, HTTPS, SOCKS5, and SOCKS5H proxies create real local tunnels; bad proxy tests prove no direct fallback and no credential leakage;
- old three modes plus least-connections, weighted proportions, priority full-tier fallback/cooldown/recovery behave deterministically and all `activeCount` values return to zero;
- aliases rewrite outbound model/routing lookup, reject conflicts, preserve originals in `/v1/models`, and log requested/resolved names;
- log API request IDs, strict filters, projections and sensitive-value absence satisfy `logging-guidelines.md`;
- sticky capacity overflows temporarily, all-full returns `429` plus `Retry-After`, and all `activeCount` values return to zero;
- fragmented first-event SSE errors are normalized before output; valid SSE contains data and `[DONE]`;
- a wrapped error after SSE output starts updates the existing provider trace and future account state without replaying or adding a pseudo-attempt;
- downstream disconnect before or after SSE starts aborts the upstream request, stops supplier failover, and releases capacity;
- oversized clients receive prompt `413` before request end while request buffering remains bounded;
- persisted history contains no account key or raw session value;
- non-stream and fragmented/oversized streaming responses count only explicit usage, preserve known zero versus missing, and finalize once across success, failure, and disconnect;
- health penalty classes, minimum coverage, score thresholds, incomplete coverage, and one-result-per-account-segment behavior are deterministic;
- all-false pipeline output is equivalent to each legacy mode, while enabled filters/groups/sticky/capacity fallback preserve eligibility and lease release;
- quota projection rejects oversized/malformed/non-canonical responses, never uses a stale generation, stays outside the chat path, and applies bounded retry/concurrency;
- `/api/statistics` is authenticated, coverage-labelled, bounded, stable-ID keyed, and contains no sensitive/raw provider data.

The current integration suite directly covers stable identities, provider/account failover, capacity overflow, valid SSE, fragmented pre-response SSE errors, wrapped post-start SSE errors without replay, non-streaming and post-start SSE downstream disconnects, prompt oversized-body rejection, HRW input-order independence, minimal remapping after account removal, missing usage, oversized CRLF SSE recovery, statistics corruption rejection, and quota generation invalidation.

Run `node --check server.js`, `npm test`, and `git diff --check` after changing this boundary.

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
