# Persistence Guidelines

> This project has no database or ORM. Durable state is stored as JSON under `DATA_DIR`.

---

## Scenario: Configuration and runtime metadata migration

### 1. Scope / Trigger

Use this contract when adding configuration fields, account state, routing metadata, startup migration, or any save path for `config.json` and `metadata.json`.

The persistence boundary must survive process interruption without replacing a valid file with a partial write, and startup must not overwrite a malformed operator-owned file.

### 2. Signatures

```js
loadJson(file, fallback)
atomicWriteJson(file, obj, { pretty = true } = {}) // config/admin formatted; metadata compact
normalizeRouteConfig(route)
normalizePerModelMap(map)
normalizeAccount(account, index, previousById, previousByName)
normalizeProxyUrl(value, { strict = false })
validateAndNormalizeHeaders(value, { strict = false })
normalizeModelAliases(value)
normalizeAccountPipeline(value, { strict = false, fallbackOrder, fallbackCachePoolSize,
  fallbackCachePoolMaxSize, fallbackCachePoolLowQuotaSize = 0, fallbackSessionBindingExplicitTtlMs,
  fallbackSessionBindingFallbackTtlMs, fallbackSessionBindingMaxEntries })
normalizeErrorRules(value, { strict = false })
normalizeRetryRules(value, { strict = false })
normalizeCachePoolTarget(pipeline = config.accountPipeline)
cachePoolTargetFor(pipeline = config.accountPipeline, value = META.cachePoolTargetSize)
validateStatistics(statistics)
normalizeStatistics()
normalizeAccountQuotas()
normalizeAccountStates()
reconcileQuotaDisposition(id, snapshot)
parseQuotaPayload(json, fetchedAt)
normalizeConfigAndMeta({ persist = false })
saveConfig() // atomicWriteJson(CONFIG_PATH, config)
saveMeta()   // atomicWriteJson(META_PATH, META, { pretty: false })
```

Paths and environment:

```text
DATA_DIR        optional; defaults to the server directory and owns config, metadata and admin-auth JSON paths
CLINE_PASS_KEY  optional runtime account override with a deterministic HMAC-derived ID
PROXY_KEY       optional runtime proxyKey override
PUBLIC_BASE_URL optional runtime publicBaseUrl override; also the exact HTTPS Origin expected for remote admin login behind a trusted private proxy
CLINE_PASS_ADMIN_PROXY_TOKEN  private 64-character lowercase hex secret shared with the TLS reverse proxy; it must replace X-Cline-Pass-Proxy-Token on forwarded requests
CLINE_PASS_RAW_BODY_READY  process-only '1' after separate raw backup/rollback/load approval; also requires detected memory >= 2 GiB; never auto-set by rawBodyLogging
CLINE_PASS_TEST_RAW_MEMORY_BYTES  only NODE_ENV=test; bounded fixture override for the runtime memory-admission test, never a production override
PORT            optional runtime port override
BIND_HOST       optional listen address only; not persisted by startup normalization
CLINE_PASS_ADMIN_BOOTSTRAP  explicit '1' only to create missing admin state
CLINE_PASS_ADMIN_INIT_CODE  independent private initialization code, >=16 characters
CLINE_PASS_ADMIN_INITIAL_PASSWORD  required nonempty bootstrap seed when effective client key is empty
admin-auth.json  DATA_DIR/admin-auth.json (salted scrypt verifier + initialized flag only; never config/metadata)
config.json     DATA_DIR/config.json
metadata.json   DATA_DIR/metadata.json
```

### 3. Contracts

#### Process-only HTTP/1.1 connection and SSE settings

These are evaluated once from environment by `boundedEnv()`/`runtimeDuration()`; they are **not** `config.json` or `metadata.json` fields and are not echoed by account/config saves. Each value is an unsigned canonical decimal safe integer (no signs, spaces, decimals, exponent, or guessed seconds). Missing, malformed, unsafe or out-of-range values fall back to the listed default; the unit is always milliseconds (`_MS`) or socket counts. `runtimeDuration()` reads the production key first and applies the matching `CLINE_PASS_TEST_*` override **only** with `NODE_ENV=test`, using the same bounds (invalid test input keeps the already selected production value).

| Environment key | Default | Inclusive bounds / effect |
|---|---:|---|
| `CLINE_PASS_INBOUND_KEEP_ALIVE_MS` | 95000 | 100–120000; `server.keepAliveTimeout`, with `headersTimeout = value + 5000` |
| `CLINE_PASS_SSE_FIRST_EVENT_MS` | 120000 | 100–120000; stream first-data wall deadline including headers/prelude |
| `CLINE_PASS_SSE_STREAM_IDLE_MS` | 360000 | 200–600000; native upstream socket idle after accepted first data |
| `CLINE_PASS_SSE_HEARTBEAT_MS` | 25000 | 0–60000; 0 disables downstream SSE comments |
| `CLINE_PASS_DIRECT_MAX_SOCKETS` | 256 | 1–1024; each process-wide HTTP/HTTPS Agent |
| `CLINE_PASS_DIRECT_MAX_FREE_SOCKETS` | 32 | 1–64; effective value `min(configured free, effective direct max sockets)` |
| `CLINE_PASS_PROXY_MAX_SOCKETS` | 32 | 1–128; each cached/disposable HTTP(S)/SOCKS proxy Agent |
| `CLINE_PASS_PROXY_MAX_FREE_SOCKETS` | 2 | 1–16; effective value `min(configured free, effective proxy max sockets)` |

Only the four duration keys support `CLINE_PASS_TEST_INBOUND_KEEP_ALIVE_MS`, `CLINE_PASS_TEST_SSE_FIRST_EVENT_MS`, `CLINE_PASS_TEST_SSE_STREAM_IDLE_MS`, and `CLINE_PASS_TEST_SSE_HEARTBEAT_MS`. Agent options also set `keepAlive: true`, `scheduling: 'lifo'`, and 60000 ms socket timeout; at most 128 persisted proxy URLs enter the cache, with disposable agents for draft tests and cache overflow. No new persisted migration is required. Target Node >=18 APIs; the archived `09-21-newapi-chat-keepalive/check-report.md` records an official SHA256-verified Node 18.20.8 `darwin-arm64` full 241/241 test run. The parent cross-feature check additionally ran on Node 26; neither run verifies a Docker container or the real New API topology.

#### Static `config.json`

```js
{
  port,                 // default 3123
  apiKey,               // legacy single-key compatibility input
  proxyKey,
  publicBaseUrl,
  exposeCatalog,
  upstreamBase,
  knownModels,
  accounts: [{
    id, name, note, key, enabled,
    maxConcurrent, maxRpm, weight, priority,
    proxyUrl, headers,
    perModel: { [modelId]: RouteConfig }
  }],
  accountMode: "single" | "roundrobin" | "sticky" |
               "least-connections" | "weighted-roundrobin" | "priority-failover",
  activeAccount,
  concurrencyWaitMs,
  errorRules: [{
    id,
    scope: "account" | "provider-model",
    action: "ignore" | "degrade" | "cooldown" | "hard-quarantine",
    providers?, models?,
    when: { statuses?, body_contains?, header? },
    reset? // cooldown only: explicit Header format + strict fallback/max duration
  }],
  quotaProtection: { monthlyThresholdUsd: 0.20 }, // $0.01–$50.00, two decimal places, community $50 reference cap
  retryRules: [{
    id,
    decision: "stop",
    when: { statuses: integer[], body_contains: string | string[] } // both required; status AND body
  }],
  accountErrorRules: {},        // legacy compatibility projection only
  accountContentErrorRules: [], // legacy compatibility projection only
  accountPipeline: {
    quotaPool: boolean,
    healthSort: boolean,
    sticky: boolean,
    order: ("quotaPool" | "healthSort" | "sticky")[],
    cachePoolSize: integer,        // 0-100000; initial/minimum size; 0 disables the cache-focused active pool
    cachePoolMaxSize: integer,     // 0-100000; grow-only upper bound; must be >= cachePoolSize
    cachePoolLowQuotaSize: integer, // 0-100000; fixed low target, <= cachePoolSize; 0 disables role-aware routing
    sessionBindingExplicitTtlMs: integer, // 60000-604800000; explicit-identity sliding TTL (default 7200000)
    sessionBindingFallbackTtlMs: integer, // 60000-604800000; message_hmac sliding TTL (default 900000)
    sessionBindingMaxEntries: integer     // 1-100000; process-local LRU cap (default 50000)
  },
  modelAliases: { [clientAlias]: "cline-pass/<known model>" },
  detailedLogging: boolean,      // default false; full detailed capture
  errorDetailLogging: boolean,   // default false; failed chat attempts only
  rawBodyLogging: boolean,       // default false; opt-in unredacted detail bodies for future captures only
  perModel: { [modelId]: RouteConfig }
}

RouteConfig = {
  upstream, upstreams, exclude,
  pinMode: "strict" | "preferred",
  sort: null | "cost" | "ttft" | "tps",
  maxRetries: null | integer,
  providerCooldownMs: integer // 0-300000; 0 disables runtime provider circuit state
}
```

Account `id` is the stable join key for runtime state; names are editable and keys are not identifiers. `key` is intentionally durable static configuration. Do not copy it into metadata, history, status reasons, or routing diagnostics.

Startup normalization preserves legacy behavior while making the schema explicit:

- if the account list is empty and legacy `apiKey` is set, create a default single account;
- add and persist stable account IDs, `maxConcurrent: 0`, `maxRpm: 0`, `weight: 1`, `priority: 100`, empty `note/proxyUrl/headers`, and `perModel: {}`;
- normalize account-level `maxRpm` to a canonical integer `0..100000` where `0` means unlimited (`MAX_RPM_LIMIT`, `rpmLimit()`). A legacy or absent field becomes `0`; a complete account save that omits `maxRpm` for an existing stable `id` preserves the previous value (`normalizeAccount()` reads `previous.maxRpm`); a genuinely new account without it becomes `0`. Non-strict normalization (`normalizeMaxRpm()`) maps `undefined`/`null`/negative/non-numeric/non-integral values to `0` (a numeric string such as `"10"` becomes `10` through `Number()`) and truncates a value above the cap; the strict management save accepts only a real JavaScript number satisfying `Number.isInteger(a.maxRpm) && a.maxRpm >= 0 && a.maxRpm <= 100000`, so a numeric string such as `"10"` is rejected. **This strictness is deliberate**: it intentionally differs from `maxConcurrent`/`weight`/`priority`, which string-coerce through `Number()`. Do not "unify" it by adding `Number()` coercion. An invalid value returns `400` before any write and leaves the exact `config.json` bytes unchanged;
- accept all six account modes; old `single/roundrobin/sticky` retain their previous behavior;
- normalize `proxyUrl` only to HTTP, HTTPS, SOCKS5, or SOCKS5H and normalize account Header names/values through the shared security validator;
- normalize `modelAliases` only to known `cline-pass/*` targets without alias/original-name collisions;
- normalize legacy `upstream` into `upstreams` while retaining `upstream` as the first-item compatibility mirror;
- normalize global and account routes with the same functions; missing/invalid persisted `providerCooldownMs` becomes 0, while strict saves accept only integer 0-300000;
- default an invalid/missing wait to 2000 ms;
- treat `errorRules` as the only authoritative ordered array, capped at 100 entries / 64 KiB with strict stable IDs, scopes, actions, applicability, conditions, Header names and reset durations; persisted canonical invalidity fails startup without rewriting bytes;
- treat `retryRules` as the only authoritative ordered request-level stop array, capped at 100 entries / 64 KiB. Each entry requires a stable unique ID, `decision: "stop"`, and both `when.statuses` (non-empty unique safe integers 100-599) and `when.body_contains` (a non-empty string or a 1-20 element control-byte-free needle array with no case-insensitive duplicates). Unknown fields, a non-`stop` decision, duplicate IDs, missing conditions, out-of-range statuses, empty/oversized needles and oversize arrays are strict `400` at the management boundary and fail startup from a persisted canonical value without rewriting bytes. A missing/invalid legacy field normalizes to `[]`; the manual console preset is never auto-seeded or auto-migrated, and an older client that omits the field preserves the current server value;
- when canonical rules are absent, migrate legacy content rules in original order before exact legacy status rules, map `ban` to account hard quarantine, persist canonical rules, and retain only lossless legacy API/config mirrors;
- clamp `activeAccount` to the persisted account list;
- normalize the pipeline to `quotaPool`, `healthSort`, `sticky`; recognized legacy four-step input folds `excludeUnhealthy:true` into health sorting and removes the duplicate step;
- normalize a missing/invalid `accountPipeline.cachePoolSize` to `0`; strict management saves accept only integer values from 0 through 100000, while an older client that omits only this field preserves the current server value. Legacy four-step input that omits it defaults the pool off.
- normalize `cachePoolMaxSize` as an integer 0-100000 with `cachePoolMaxSize >= cachePoolSize`. A missing field (legacy file or older client) falls back to the current server value, or to `cachePoolSize` when there is none, so an upgrade never enables automatic growth. Non-strict normalization clamps an explicit max below the minimum up to the minimum; strict saves return `400` instead.
- normalize `cachePoolLowQuotaSize` as an integer 0-100000 with `0 <= low <= cachePoolSize <= cachePoolMaxSize`. Legacy absence defaults to `0` (including a new size-zero installation); an older management client omitting the field preserves the current server value. Explicit `0` disables role-aware membership/selection even for a positive pool. Non-strict invalid input falls back to `0` and an excessive low target clamps to the minimum; strict saves reject either without writing. A positive cache preset explicitly drafts `1`, never auto-migrate existing positive pools to `1`.
- normalize `sessionBindingExplicitTtlMs`/`sessionBindingFallbackTtlMs` as integers 60000-604800000 and `sessionBindingMaxEntries` as an integer 1-100000. A missing/invalid value falls back to the current in-range server value, then to `7200000`/`900000`/`50000`; non-strict normalization caps a fallback TTL above the explicit TTL at `Math.min(900000, explicitTtlMs)`.

Account-level RPM runtime state is deliberately process-local and is never persisted. `server.js` keeps one rolling-window owner per account (`rpmWindows`, `RPM_WINDOW_MS` = 60 s; only the test environment may shrink it through `CLINE_PASS_TEST_RPM_WINDOW_MS`) holding committed native chat start times plus uncommitted reservations. It clears on restart, is independent per process/replica, and is explicitly not a cross-process hard cap. Account deletion and key/proxy identity rotation clear that account's window, and `maxRpm: 0` disables the limit and drops the state; ordinary disable/re-enable keeps already-committed in-window facts (POST `/api/accounts` calls `clearRpmState()` only on deletion, key/proxy rotation, or a limit that becomes `0`). `metadata.json` must never contain the timestamps array, the `head` cursor, the reservation count, or the `rpmWindows` map.

#### Dynamic `metadata.json`

```js
{
  models: {
    [modelId]: {
      upstreams,
      upstreamStatus: {
        [provider]: {
          status: "ok" | "limited" | "degraded" | "bad" | "unknown",
          checkedAt, lastSuccessAt, lastFailureAt,
          consecutiveFailures, cooldownUntil,
          failureClass: null | "rate_limit" | "auth" | "server" |
                        "network" | "timeout" | "unsupported" | "other",
          note
        }
      }
    }
  },
  accountStates: {
    [accountId]: {
      banned,             // compatibility mirror of hardQuarantined
      hardQuarantined,
      cooldownUntil,
      statusCode,
      reason, ruleId,
      updatedAt,
      quotaDisposition: null | "waiting-refresh" | "quota-exhausted",
      quotaDispositionAt, // positive safe integer when held, otherwise 0
      quotaRetryAt,       // 0 for waiting-refresh/no valid future reset; otherwise safe timestamp
      quotaReason: null | "account-degrade" | "known-exhausted",
      protectionMonthlyAt: number, // 0 or positive manual-release ban timestamp
      protectionShortAt: number, // 0 or positive confirmed 5h/week exhaustion timestamp
      protectionShortWindows: null | ("five_hour" | "weekly")[],
      protectionRetryAt: number // earliest valid future reset, or 0
    }
  },
  routingSecret,
  cachePoolTargetSize,     // grow-only cache-pool target, integer clamped by cachePoolSize..cachePoolMaxSize
  models,
  history,                 // compatibility-only persisted array
  catalog, catalogFetchedAt,
  orModelsFetchedAt, orModelList,
  officialModelsFetch,
  statistics: {
    version: 5,
    lifetime: { global: Aggregate, accounts: { [accountId]: Aggregate } },
    minuteBuckets: [{
      minute,
      global: Aggregate,
      accounts: { [accountId]: Aggregate },
      health: { [accountId]: LegacyHealthDelta }, // retained, no longer written
      models: { [resolvedModelId]: Aggregate },
      accountHealth: { [accountId]: SuccessDelta },
      providerHealth: { [resolvedModelId]: { [provider]: SuccessDelta } },
      modelFinal: { [resolvedModelId]: { successes, failures, cancelled, overflowFields } },
      providerUsage: { [resolvedModelId]: { [providerOrEmptyForUnknown]: Aggregate } },
      valuation: { [resolvedModelId]: { [providerOrEmptyForUnknown]: { [priceVersion]: { pricedRequests, lowPicoUsd, highPicoUsd, overflowFields } } } }
    }],
    recentCoverage: {
      droppedAccountMinuteCells,
      accountIncompleteAt: { [accountId]: minute },
      modelTrackingStartedMinute,
      droppedModelMinuteCells,
      modelIncompleteAt: { [resolvedModelId]: minute },
      routingTrackingStartedMinute,
      accountHealthTrackingStartedMinute,
      accountHealthIncompleteAt: { [accountId]: minute },
      droppedProviderHealthMinuteCells,
      providerHealthTrackingStartedMinute,
      providerHealthIncompleteAt: { [resolvedModelId]: { [provider]: minute } },
      usageTrackingStartedMinute, droppedUsageMinuteCells,
      usageIncompleteAt: { [resolvedModelId]: minute }, usageGlobalIncompleteAt,
      droppedValuationMinuteCells, valuationIncompleteAt: { [resolvedModelId]: minute }, valuationGlobalIncompleteAt
    },
    priceVersions: { [internalVersion]: PriceSnapshot }, // at most 8 immutable snapshots; valuation cells reference their original version
    // v1 PriceSnapshot: exact { version, collectedAt, effectiveAt: null, source, currency: 'USD', models: { [pricedModel]: { tier, rates: [[input,output,cachedRead], ...] } } }; integer thousandths USD/1M
    // v2 PriceSnapshot: same top-level keys plus rateScale: 10000; models: { [pricedModel]: { tier, rates: [[input,output,cachedRead,cachedWriteOrNull], ...], source } }; integer ten-thousandths USD/1M
    migration: {
      legacyStatsMigratedAt,
      legacyRequests,
      accountLegacyRequests: { [accountId]: requests },
      ambiguousNames,
      unmappedNames
    }
  },
  accountQuotas: {
    [accountId]: {
      snapshot: null | {
        limits: {
          five_hour?: { percentUsed, resetsAt? },
          weekly?: { percentUsed, resetsAt? },
          monthly?: { percentUsed, resetsAt? }
        },
        fetchedAt
      },
      lastAttemptAt,
      lastSuccessAt,
      errorCategory: null | "auth" | "rate_limit" | "server" | "http" |
                     "proxy" | "network" | "timeout" | "json" | "schema"
    }
  }
}
```

`routingSecret` is generated once and persisted so HRW mapping survives restart. `cachePoolTargetSize` is the single persisted cache-pool target: it is normalized by `normalizeCachePoolTarget()` to `clamp(stored, cachePoolSize, cachePoolMaxSize)`, defaults to the minimum when absent (and to `0` when the minimum is `0`), and is rewritten only by startup normalization when the effective value changed, by an explicit operator save that clamps it, or by one successful `growCachePoolOne()` increment. It is never reset by pressure drop, and it must not be accompanied by a persisted member list, session→account map or binding entry. Cache-pool membership is always re-derived from the target, quota-role eligibility (when low > 0), priority and stable ID; high/low/unknown member counts and IDs are never persisted. The session-binding table is process-local and clears on restart. Automatic growth writes only `metadata.json` through `saveMeta()` and never rewrites operator `config.json`/`accountPipeline`. `accountStates` entries for removed accounts are deleted; the deterministic environment-account ID remains valid while `CLINE_PASS_KEY` is present. Expired rule cooldown fields are cleared when candidates are read; an independent quota disposition is never deleted with them. Rule ban/cooldown persists until expiry or `POST /api/accounts/recover` clears only the rule dimension. `waiting-refresh`/`quota-exhausted` persist across restart and remain independent of operator enablement and rule quarantine. The independent monthly protection ban survives restart, ordinary recovery, quota refresh/reset and key/proxy rotation; only exact manual quota recovery or account deletion clears it. Confirmed 5h/week protection survives restart, but key/proxy rotation clears it; only a new successful full three-window snapshot (all used <100%) may automatically release it. The process-local provisional verification hold and confirmed monthly ban's pending-persistence marker are never persisted. A failed atomic monthly-ban write leaves the in-process ban active and reports `quota.protectionPersistence: 'pending'` in authenticated projections until the existing quota timer retries a successful META write; a restart before that success cannot reconstruct the uncommitted ban from disk. The pending marker survives credential/proxy rotation or disablement but not account deletion or a successfully persisted explicit release. A successful quota job alone may clear the quota dimension; a disable/re-enable retains it, whereas key/proxy identity rotation or deletion removes the affected quota state. Legacy account-state entries gain canonical null/zero quota fields on startup.

Provider state is durable runtime metadata keyed by resolved model and Provider, never by account. Legacy `upstreamStatus` facts normalize additively; explicit `cooldownUntil`, `hardQuarantined`, safe `ruleId`/status/time facts are independent from success data. Hard quarantine survives success/restart and clears only by exact recovery or Provider identity cleanup. A rule action must never copy the rule needle, Header value, response body, credential, or request content into this map.

`metadata.json` must not contain account keys, proxy credentials, custom Header values, account notes, raw session values, HMAC fingerprints, message text, or identity-source labels. Bounded identity-source labels such as `message_hmac` belong only to ordinary request-log projections. Reasons written to metadata are redacted and flattened; bounded model/provider health notes may be truncated, while complete redacted structured provider reasons belong to the separate error JSONL stream.

`Aggregate` retains the existing request/usage/routing counters. `SuccessDelta` has only `successes`, `degrades`, and exact overflow markers. Statistics v5 retains at most 1,440 minute buckets, 50,000 union `(minute, accountId)` cells, 50,000 model aggregate cells, and an independent 50,000 `(minute, resolvedModelId, provider)` success cells. It adds separate 50,000 provider-usage minute cells, 50,000 version-keyed valuation minute cells and at most eight persisted reference-price snapshots. Each new cell loss and pre-v5 tracking start is represented by independent per-model/global coverage, and exact numeric overflow is `null` with markers. `providerUsage` holds final-success usage only, including explicit unknown (`""`) Provider; a named Provider uses the same bounded slug grammar as Provider health (`[a-z0-9][a-z0-9._/-]{0,199}`), including `/` and `.`, so a valid attribution cannot make persisted v5 state fail on restart. Model/Provider IDs such as `toString` must use own-property checks for reference-price lookup, coverage reads/writes and health cells, including capacity eviction; an unpriced prototype-named model remains valid statistics data, never a failed finalizer or malformed coverage on restart. `modelFinal` counts terminal successes/failures/cancellations independently. Frozen picodollar amounts are never recomputed from the currently published table. Persisted v1 rate triples, source, schema and frozen amounts stay unchanged when v2 becomes current; v2 strictly validates its extra `rateScale`, each bounded rate quadruple and per-model source. A `null` cached-write tariff means the table has no listed write rate, not that a write count was measured at zero. Every current-version snapshot is checked against its exact built-in price facts on startup; malformed/foreign/extra-key snapshots fail without overwriting metadata. A v2 model with priced Cached Write or unknown context band cannot be valued from existing usage. Only v2 single or peak/off-peak no-write rows with explicit consistent input/output/cache-read yield amounts using BigInt rate units × 100 picodollars per token; historical v1 cells use their original × 1000 units. DeepSeek amounts remain a range. The community monthly $50 quota projection is separate and never offset by model valuation. v1–v4 migration creates empty v5 cells and never backfills historical Provider usage or valuations. Account and Provider success tracking each have truthful migration starts and cell-loss coverage. v1/v2/v3 weighted health is retained as legacy bytes but is never converted into direct success samples or threshold labels. Any counter overflow becomes `null` with its exact marker.

Legacy name-keyed `stats` is migration input only. It moves once into the separately labelled `migration` baseline and never fabricates exact chat, token, cache, recent-window, or health facts. Unknown newer statistics versions, malformed aggregates, unordered buckets, excess cells, invalid IDs, and malformed quota snapshots fail startup before any save.

Quota snapshots are keyed by stable account ID and store only projected percentages, canonical ISO reset times, `lastAttemptAt`, `lastSuccessAt`, and a safe error enum. The separate `accountStates` quota dimension stores only the validated disposition/timestamps/reason enum, not quota percentages or raw payloads. Persisted active dispositions require a positive safe `quotaDispositionAt`, safe nonnegative `quotaRetryAt`, and the matching reason (`waiting-refresh` → `account-degrade` with retryAt 0; `quota-exhausted` → `known-exhausted`). An absent/null disposition requires zero/null companion values. Unknown quota-prefixed fields or inconsistent combinations fail startup before any rewrite, preserving original metadata bytes. An old entry without quota fields is normalized to null/zero. Upstream reset times accept RFC3339 timestamps with an optional 1–9 digit fractional second and mandatory `Z` or numeric offset, reject impossible Gregorian calendar dates, and normalize through `Date#toISOString()` to millisecond UTC before persistence. A successful partial snapshot replaces the complete prior snapshot and is cacheable without becoming routing-fresh; a failed attempt retains the last-good snapshot while recording only its safe category/time. It never stores keys, Headers, proxy values, credential-bearing URLs, raw provider payloads, page-owner tokens, routing epochs, generations, queues or success-version counters. Account deletion prunes account statistics, health coverage, state and quota while retaining global history. Credential/proxy changes clear quota but retain local statistics; disabling an account retains last-good quota for diagnostic display while preventing refresh/publication.

Durable request/error diagnostics no longer grow `metadata.history`; they are separate bounded JSONL streams under `DATA_DIR/logs/` and follow `logging-guidelines.md`. The legacy history array remains compatibility-only.

Opt-in detailed content belongs only to the independent `DATA_DIR/detailed-logs/` store described in `logging-guidelines.md`; metadata exclusions above remain unchanged. `detailedLogging` selects full capture and `errorDetailLogging` selects failed-chat-attempt capture; both default off and full wins when both are enabled. `POST /api/logs/settings` accepts a non-empty exact subset of those two boolean fields and `rawBodyLogging`, so legacy `{ detailedLogging: boolean }` remains valid. `rawBodyLogging` defaults off for legacy files and is effective only after independent administrator initialization and when a full/error capture switch is enabled; no existing sanitized manifest silently changes profile. Persist the complete candidate config with `atomicWriteJson(CONFIG_PATH, { ...config, ...candidate })` **before** changing either runtime mode. Failed writes return a safe 500 with both prior runtime values/file intact; rejected payloads return 400 without a write. The settings must not reuse destructive account saves or reload account drafts. Missing/invalid persisted values are off, not truthy enablement.

#### Independent administrator state

`admin-auth.json` has the exact schema `{ version: 1, salt: 64 lowercase hex, hash: 128 lowercase hex, initialized: boolean }`. Only a missing file with explicit `CLINE_PASS_ADMIN_BOOTSTRAP=1` and an independent nonempty >=16-character `CLINE_PASS_ADMIN_INIT_CODE` creates an uninitialized verifier from the effective downstream key (including `PROXY_KEY` environment override), or from a separately supplied nonempty `CLINE_PASS_ADMIN_INITIAL_PASSWORD` when that key is empty. No implicit fallback for a missing state file; without explicit opt-in all management requests remain 401. Existing valid state is never re-derived from the client key on restart or rotation. Startup fails closed if the effective nonempty client key (including an environment override) matches the initialized administrator password; operator must correct the client key without resetting the admin state. Wrong/malformed existing state, a symlink/non-regular file or a group/world-readable admin state fails startup without replacing its bytes; new state is owner-only 0600. Bootstrap requires password plus code and creates only a pending in-memory session; first password change atomically saves an independent verifier, marks initialized and revokes all sessions. Subsequent changes require the current admin password and revoke all sessions. No plaintext password, code, cookie/session token or CSRF token enters durable state. Operators must keep a private backup of this file and use trusted recovery if lost; see README onboarding and rollback.

#### Atomic write and file mode

`atomicWriteJson()` writes JSON to a unique temporary file in the same directory and then calls `renameSync()` over the destination. Configuration/admin state retains formatted JSON; `saveMeta()` encodes runtime metadata compactly (same JSON values, fewer bytes, same per-save atomic rename and fail-open chat behavior). Existing formatted metadata loads normally and is compacted on the next legitimate metadata save. The temporary file is removed in `finally`.

- A newly created JSON file uses mode `0600`.
- An existing destination's mode is preserved; the implementation does **not** force a pre-existing permissive file to `0600`.
- A non-`ENOENT` read or stat error is fatal.
- A malformed existing JSON file makes startup fail before migration saves anything. It is never replaced by defaults.

### 4. Validation & Error Matrix

| Input/state | Persisted result or error |
|---|---|
| Invalid or out-of-range process-only connection/SSE environment value | use its documented default without changing operator JSON; invalid `CLINE_PASS_TEST_*` in test mode retains the already-selected production value, and non-test mode ignores it |
| Missing file (`ENOENT`) | use fallback; persist only if normalization becomes dirty or a later save occurs |
| Malformed existing JSON | throw `cannot read <file>: ...`; process exits; original bytes remain |
| Missing legacy account fields | generate/persist `id`, `maxConcurrent: 0`, `perModel: {}` |
| Unknown account state after account deletion | remove state on normalization/account save |
| `concurrencyWaitMs` outside 0-30000 at startup | normalize to 2000 |
| Management API wait outside 0-30000 | `400`; no write |
| `maxConcurrent` outside 0-100000 through management API | `400`; no write |
| `maxRpm` is not a real JavaScript integer 0-100000 (numeric string such as `"10"`, fraction, negative, `null`) through the management API | `400`; no write; an older-client omission instead preserves the stable-`id` value, and a new account missing it becomes `0` |
| Account is deleted or its key/proxy identity rotates | clear that account's in-process RPM window; `maxRpm = 0` also drops it; ordinary disable/re-enable keeps committed in-window facts |
| `weight` or `priority` outside integer 1-100 | `400`; no write |
| Note exceeds 500 characters or contains forbidden controls | `400`; no write |
| Proxy URL has an unsupported scheme/host/port/path/query/hash | `400`; no write |
| Account Header map exceeds count/value/total limits or contains a forbidden credential/session/hop-by-hop name | `400`; no write |
| Model alias is invalid, duplicated, collides with an original ID, or targets an unknown/non-Cline model | `400`; no write |
| Route has over 20 upstreams, over 50 exclusions, invalid slug/mode/sort, `maxRetries` outside 0-20, or `providerCooldownMs` outside integer 0-300000 | `400`; no write |
| Canonical rules are non-array/over 100/over 64 KiB, have invalid/duplicate IDs, unknown fields, empty/duplicate scopes, no active condition, invalid status/body/Header/applicability, or invalid reset format/duration | `400`; no write |
| A POST omits `errorRules` and changes either legacy mirror | `409`; preserve canonical rules and file bytes; unchanged/missing mirrors are accepted |
| Missing `quotaProtection` | Default to `{ monthlyThresholdUsd: 0.20 }`; older account saves omitting it preserve the current value |
| Invalid `quotaProtection.monthlyThresholdUsd` or unknown setting | Reject startup or account save before rewriting/mutating operator JSON; require a real finite two-decimal number $0.01–$50.00 |
| Invalid protection timestamps, window enums or inconsistent short-window state | Fail startup without rewriting the malformed metadata bytes |
| A POST omits `retryRules` | preserve the current server value; never reset to `[]` or auto-seed the preset |
| `retryRules` is non-array/over 100/over 64 KiB, or an entry is missing `id`/`decision`/`when`, has an unknown field, a non-`stop` decision, a duplicate ID, empty/out-of-range/duplicate statuses, or a missing/empty/oversized/control-byte/case-insensitively duplicate `body_contains` | `400`; no write; persisted canonical invalidity fails startup without rewriting bytes |
| Canonical `accountPipeline` lacks any of the three booleans, has unknown fields, invalid `cachePoolSize`/`cachePoolMaxSize`, invalid binding TTL/entry bounds, or non-permutation order | `400`; no write; complete recognized legacy four-step input is normalized, and older omission of any field preserves current values |
| `cachePoolMaxSize` is below `cachePoolSize`, or `sessionBindingFallbackTtlMs` exceeds `sessionBindingExplicitTtlMs` | strict save `400`; non-strict normalization clamps to the minimum / `min(900000, explicit)` |
| Explicit `cachePoolLowQuotaSize` is a string, fraction, negative, above 100000 or above `cachePoolSize` | strict save `400` before any write; omitted older-client field retains the current value; legacy absence defaults to 0 |
| Persisted quota disposition has an unknown quota key/enum, missing or invalid timestamp, mismatched reason, or nonzero retryAt for `waiting-refresh` | fail startup without rewriting the malformed `metadata.json` bytes; do not silently normalize an inconsistent new state |
| Persisted `cachePoolTargetSize` is missing/non-integer/below min/above max | normalize the effect to `clamp(value, cachePoolSize, cachePoolMaxSize)`; do not fail startup and do not write a member list |
| Legacy provider health lacks new fields | normalize to bounded defaults while preserving safe status/note/timestamps |
| Invalid provider-health timestamp/count/status | normalize to zero/unknown/bounded values; never copy raw payload data |
| Valid statistics v1/v2/v3/v4 | validate each old exact field set, migrate through model/routing and v4 health versions, then add empty v5 final/Provider usage/valuation owners and independent tracking starts without converting legacy weighted health or backfilling past usage |
| Existing statistics version is missing/unknown or its structure exceeds account/model bounds | startup fails; original metadata bytes remain |
| Aggregate overflow marker and `null` field disagree | startup fails; original metadata bytes remain |
| Quota percentage is outside 0-100, persisted reset time is not canonical millisecond UTC, or a state field is unknown | startup fails; original metadata bytes remain |
| Upstream reset time has no timezone, over 9 fractional digits, or an impossible Gregorian date | refresh records safe `schema`; retain the complete last-good snapshot |
| Quota refresh fails after an earlier success | Retain the previous snapshot/last-success and persist only safe attempt/error metadata; routing treats it as unknown |
| Account key/proxy changes, is disabled, or is deleted during quota work | Runtime fences prevent stale publication; key/proxy/delete clear persisted quota, while disable retains last-good diagnostic state |
| Existing account ID is changed by management API | `400`; no write |
| Duplicate account IDs | `400`; no write |
| Rename/write fails | propagate the error; remove the temporary file when possible |

Startup normalization is permissive for legacy files; management APIs validate strictly before normalization and persistence.

### 5. Good / Base / Bad Cases

- **Good:** a legacy account without an ID starts once, receives an ID, and retains that same ID and cooldown state after restart.
- **Good:** an account route and global route both pass through `normalizeRouteConfig()`, so their persisted shapes stay identical.
- **Good:** a known counter overflow persists as `null` plus one matching `overflowFields` entry, and the statistics API renders it as unknown.
- **Good:** changing an account key invalidates its quota generation/state while retaining that stable ID's local usage history.
- **Good:** a config with `maxRpm: 7` round-trips through `GET/POST /api/accounts`; a complete save from an older client that omits the field keeps `7`, a new account without it becomes `0`, and the rolling window never appears in `metadata.json`.
- **Base:** `maxRpm: 0` means unlimited and keeps no window state.
- **Good:** `NODE_ENV=production` with a valid millisecond heartbeat override and a conflicting test-only override uses the production value; neither field enters `config.json`/`metadata.json`.
- **Bad:** saving `SSE_HEARTBEAT_MS` as account configuration, treating `25` as seconds automatically, or letting a test-only override affect production.
- **Base:** `errorRules: []`, `retryRules: []`, all-false canonical `accountPipeline` with `cachePoolSize: 0`, and `maxConcurrent: 0` preserve no-action/continue-retry/legacy-routing/unlimited behavior.
- **Base:** a missing metadata file creates a routing secret and owner-only metadata on first migration save.
- **Bad:** catching JSON parse failure and saving defaults; this destroys operator configuration.
- **Bad:** using account name or key as the state-map key; renaming or credential rotation would orphan state.
- **Bad:** assuming all existing JSON files are mode `0600`; only new files get that default.
- **Bad:** validating `maxRpm` with `Number(a.maxRpm)` like `maxConcurrent`, which would silently accept the numeric string `"10"`; or persisting `rpmWindows`/reservations into `metadata.json`.

### 6. Tests Required

Persistence changes must use a temporary `DATA_DIR` and assert:

- production duration overrides use literal milliseconds, a test-only override cannot change production heartbeat, invalid inputs use the bounded fallback, and process-only timing/socket-pool settings do not enter `config.json` or `metadata.json` after startup or account saves; `test/integration.test.js` covers the production/test heartbeat distinction, with other env boundaries to add as needed;
- malformed `config.json` causes non-zero startup, reports `cannot read config.json`, and retains the exact original bytes;
- legacy accounts gain non-empty stable IDs, `maxConcurrent: 0`, `weight: 1`, `priority: 100`, empty note/proxy/Header fields, and `perModel`, then retain IDs across restart;
- all new account fields, model aliases, and all 24 pipeline order permutations survive an authenticated save/restart round trip without erasing account routes;
- missing legacy pipeline order and cache-pool size migrate to the compatibility defaults, `cachePoolMaxSize` defaults to `cachePoolSize`, old-client saves preserve the current order/size/max/TTLs/entry cap, valid new values survive restart, and malformed explicit values fail without changing file bytes;
- a stored `cachePoolTargetSize` survives restart, is clamped into `[cachePoolSize, cachePoolMaxSize]`, is reset by an explicit operator save, and is the only pool fact written to `metadata.json`; no member IDs or `sessionBindings` key appear in the persisted bytes;
- `test/low-quota-pool.test.js` (`low slot configuration, legacy omission and invalid bounds preserve bytes`) covers legacy missing/old-client omission/explicit zero and invalid bounds, restart/round-trip, plus malformed persisted quota-state combinations failing startup with original metadata bytes intact; `expired rule cooldown and manual recovery clear only rule fields, not quota disposition` and `disable/re-enable retains both quota holds; key/proxy rotation and deletion prune only the affected identities` assert independent state owners;
- invalid proxy/Header/note/weight/priority/alias payloads return `400` and preserve the previous file bytes;
- `maxRpm` strict validation rejects numeric strings, fractions, negatives, `null` and values over 100000 with `400` while preserving the exact `config.json` bytes; a persisted value round-trips through save/restart, an old-client omission preserves the stable-`id` value, a legacy/absent value normalizes to `0`, and no window/reservation state ever appears in `metadata.json`; regression owner is `test/integration.test.js` (`account maxRpm round-trips through config and API, preserves old-client omission and rejects invalid values without writing bytes`, `RPM windows clear on restart and credential rotation but survive disable/re-enable; zero means unlimited`);
- `routingSecret`, account cooldown state, and model/provider health cooldowns survive restart; routing skips only still-cooling providers and keeps model isolation;
- legacy provider status rows gain bounded timestamps/count/class/cooldown fields without leaking secrets, while successful half-open attempts persist immediate recovery;
- newly created `metadata.json` has mode `0600` on POSIX;
- metadata serialization excludes known account keys and raw session values;
- legacy name-keyed request counts migrate only into the labelled baseline without fabricating exact usage;
- valid v1/v2 statistics migrate once to v3 without changing global/account/model request/token/cache facts; malformed/future statistics, inconsistent overflow markers, invalid quota timestamps, and more than 50,000 account-minute or model-minute cells fail before save while preserving exact bytes;
- upstream quota reset times with 1, 3, 6 and 9 fractional digits plus numeric offsets normalize to millisecond UTC, while missing timezone, over-precision and impossible dates fail as `schema` and retain the prior snapshot;
- partial quota success replaces older windows, failure retains last-good values, and metadata never persists owner/generation/queue/controller or raw quota state;
- key/proxy rotation clears stale quota, disable retains last-good display data without allowing stale publication, and pruning removes deleted-account statistics/quota state without deleting global history;
- pruning retains 1,440 minute buckets, independently caps account/model cells, and marks only the dropped account/model coverage incomplete;
- account removal deletes its `accountStates` entry;
- invalid canonical rule IDs/scopes/actions/applicability/status/body/Header/reset shapes and limits return `400` and preserve bytes; legacy rules migrate in content-before-status order, unchanged old-client mirrors preserve canonical rules, conflicting mirrors return `409`, and valid canonical order survives restart;
- `retryRules` strict validation rejects unknown fields, non-`stop` decisions, duplicate IDs, missing/oversized/out-of-range conditions and oversize arrays while preserving exact config bytes; a missing field defaults to `[]` without auto-seeding, an old-client omission preserves the stored value, and valid canonical entries round-trip through save and restart;
- both detailed switches default/type/unknown-field/restart tests, legacy one-field settings writes, two-field writes and injected atomic-write failure preserve previous config bytes/runtime modes; independent detail retention/recovery never changes ordinary logs or metadata.

The current integration suite directly covers malformed config preservation, legacy migration, metadata mode, routing-secret/cooldown restart, and session-value exclusion. Add focused assertions before relying on account-state cleanup or unchanged-file behavior after every validation branch.

### 7. Wrong vs Correct

#### Wrong

```js
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  config = DEFAULT_CONFIG;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config));
}
```

#### Correct

```js
const config = { ...DEFAULT_CONFIG, ...loadJson(CONFIG_PATH, {}) };
normalizeConfigAndMeta({ persist: true });

function saveConfig() {
  atomicWriteJson(CONFIG_PATH, config);
}
```

Fallback is only for `ENOENT`; malformed or unreadable existing data remains untouched and fails startup.

A statistics migration must validate before normalizing; it must not repair an unknown schema into apparently valid zeroes.

#### Wrong

```js
META.statistics = { ...createStatistics(), ...META.statistics };
```

#### Correct

```js
if (META.statistics === undefined) META.statistics = createStatistics();
else validateStatistics(META.statistics);
```

The same fail-closed rule applies to quota snapshots, the canonical quota disposition and overflow metadata. For example, do **not** repair `{ quotaDisposition: 'waiting-refresh', quotaRetryAt: 5 }` into a valid-looking hold: reject the existing metadata without overwriting it; only legacy absence receives defaults.
