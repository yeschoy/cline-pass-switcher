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
resolveModelConfig(account, modelId)
runChatChain(req, body, modelId, cfg, account, forwardedHeaders,
  { stream = false, attemptTimeoutMs = 120000 })
clineRequest(url, { headers = {}, body, signal, timeoutMs = 120000 })
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
POST /api/accounts/recover
GET  /api/models?accountId=<account id>
POST /api/config
POST /api/test
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
- `runChatChain()` receives one explicit `account`; every provider attempt in that invocation uses that account's Authorization.
- `ignore` or an unmatched status continues the provider chain on the same account. `cooldown` and `ban` stop that account's chain.
- `handleChat()` permits one replacement account only when `cooldown` or `ban` occurs before `chain.started`. The replacement starts its own model route from the first provider. The two-iteration account loop forbids a third account.

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

`maxRetries: null` runs all built provider attempts; an integer `n` permits the first attempt plus at most `n` additional outer attempts.

#### Header and credential boundary

Protocol allowlists are exclusive:

- Codex: `Originator`, `Session_id`, `Thread_id`, `Session-Id`, `Thread-Id`, `X-Client-Request-Id`, `User-Agent`, `X-Codex-Beta-Features`, `X-Codex-Turn-State`, `X-Codex-Turn-Metadata`, `X-Codex-Window-Id`, `X-Codex-Parent-Thread-Id`, `X-OpenAI-Subagent`, `X-OpenAI-Memgen-Request`, `X-ResponsesAPI-Include-Timing-Metrics`, `X-OpenAI-Internal-Codex-Responses-Lite`.
- Claude: `X-Claude-Code-Session-Id`, `X-Claude-Code-Agent-Id`, `X-Claude-Code-Parent-Agent-Id`, `X-Stainless-Arch`, `X-Stainless-Lang`, `X-Stainless-Os`, `X-Stainless-Package-Version`, `X-Stainless-Retry-Count`, `X-Stainless-Runtime`, `X-Stainless-Runtime-Version`, `X-Stainless-Timeout`, `User-Agent`, `X-App`, `Anthropic-Beta`, `Anthropic-Dangerous-Direct-Browser-Access`, `Anthropic-Version`.
- Generic: `Session-Id`, `Session_id`, `Thread-Id`, `Thread_id`, `X-Http-Session-Id`, `X-Session-ID`, `X-Session-Affinity`, `X-Slot-Session-Id`, `X-Conversation-Id`, `X-Thread-Id`, `X-Parent-Session-ID`, `X-Parent-Session-Affinity`, `User-Agent`, `X-Client-Request-Id`, `HTTP-Referer`, `X-Title`.

Always reject downstream `Authorization`, `Proxy-Authorization`, `Cookie`, `Host`, client `Content-Length`, hop-by-hop headers, `X-Codex-Installation-Id`, and `X-OAI-Attestation`. `responseHeadersFor()` sets JSON content type and overwrites Authorization with `Bearer ${account.key}`. The native `http`/`https` transport is required for chat forwarding so a missing client `User-Agent` stays missing.

Account keys are intentionally persisted only as static account configuration in `config.json` and are returned by the authenticated account editor API. They must not appear in `metadata.json`, history, traces, error bodies, or diagnostic headers. Raw session values, HMAC fingerprints, and message text must not be persisted; only `sessionSource` may be recorded.

#### Abort and SSE lifecycle

- A client socket close aborts the active upstream request.
- The stream path buffers at most the first 64 KiB while waiting for a complete first SSE event. A pre-response error event is normalized and may still trigger provider/account failover.
- After a valid SSE response is exposed (`started: true`), the request is never replayed. A later SSE error may update future cooldown/ban state only.
- The account lease stays held until normal stream flush, upstream error, or downstream close. Stream finalization and lease release are idempotent.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Chat JSON is malformed or not an object | `400`; no upstream request |
| Chat `model` is missing, blank, non-string, or over 300 characters | `400` |
| Request body exceeds 50 MiB | Reject promptly with `413` as soon as the limit is crossed, even if the client pauses before request end; discard/drain the remaining body without buffering or destroying the socket |
| No statically available account | `503` with a redacted error |
| Accounts exist but required capacity is unavailable after waiting | `429`, `Retry-After` integer clamped to 1-30 seconds |
| Explicit `/api/test.accountId` is unknown / unavailable | `400` / `409` |
| Forwardable header is blank, over 2048 characters, or contains a control byte | omit it |
| Session identity is over 512 characters or invalid | ignore it and continue identity fallback |
| Upstream has an HTTP 4xx/5xx status | preserve it as `upstreamStatus` and normally as `normalizedStatus` |
| HTTP 200 error envelope has a recognized status/message | normalize before applying `accountErrorRules`; otherwise `502` |
| Error output/history contains a configured key or Bearer token | replace with `[REDACTED]`; truncate safe reasons to 200 characters |
| `/api/accounts` mode/wait/rules/id/name/key/capacity/route is invalid | `400`; do not save |
| `/api/config` scope/action/account/model/route is invalid | `400`; do not save |

### 5. Good / Base / Bad Cases

- **Good:** sticky identity leases account A; provider `first` fails and `second` succeeds; both upstream requests use account A's Authorization.
- **Good:** account A receives a configured `429 -> cooldown` before output; its state is persisted, its lease is released, and account B starts from B's own first provider. A second removal action returns an error without selecting account C.
- **Base:** no account-specific `perModel[model]` exists, so the global route is used unchanged.
- **Base:** no identity is extractable, so sticky deliberately behaves as round-robin.
- **Bad:** calling account selection inside the provider-attempt loop; this breaks request-level account affinity.
- **Bad:** forwarding the downstream Authorization or relying on `fetch` for chat transport; either leaks proxy credentials or creates synthetic client headers.
- **Bad:** replaying an SSE request after the first valid event has been written.

### 6. Tests Required

`test/integration.test.js` is the required black-box boundary suite. Changes in this scenario must assert:

- repeated session, parent/child identities, and stable opening messages select the same account; request-id-only requests use round-robin;
- HRW rank is independent of account input order, and removing one account remaps only sessions that ranked that account first;
- provider attempts have identical Authorization and occur in configured order; `maxRetries` caps the attempt count;
- cooldown/ban can switch from A to B, a second removal action cannot select C, and banned accounts leave the candidate set;
- account override reports `configSource: "account"`; `action: "inherit"` restores `"inherited"`;
- real allowed headers arrive, prohibited headers do not, downstream Authorization is replaced, and no synthetic User-Agent appears;
- sticky capacity overflows temporarily, all-full returns `429` plus `Retry-After`, and all `activeCount` values return to zero;
- fragmented first-event SSE errors are normalized before output; valid SSE contains data and `[DONE]`;
- a wrapped error after SSE output starts updates the existing provider trace and future account state without replaying or adding a pseudo-attempt;
- downstream disconnect before or after SSE starts aborts the upstream request, stops supplier failover, and releases capacity;
- oversized clients receive prompt `413` before request end while request buffering remains bounded;
- persisted history contains no account key or raw session value.

The current integration suite directly covers stable identities, provider/account failover, capacity overflow, valid SSE, fragmented pre-response SSE errors, wrapped post-start SSE errors without replay, non-streaming and post-start SSE downstream disconnects, prompt oversized-body rejection, HRW input-order independence, and minimal remapping after account removal.

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
