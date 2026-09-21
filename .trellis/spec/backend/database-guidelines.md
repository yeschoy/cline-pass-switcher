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
atomicWriteJson(file, obj)
normalizeRouteConfig(route)
normalizePerModelMap(map)
normalizeAccount(account, index, previousById, previousByName)
normalizeProxyUrl(value, { strict = false })
validateAndNormalizeHeaders(value, { strict = false })
normalizeModelAliases(value)
normalizeAccountPipeline(value, { strict = false })
normalizeErrorRules(value, { strict = false })
validateStatistics(statistics)
normalizeStatistics()
normalizeAccountQuotas()
parseQuotaPayload(json, fetchedAt)
normalizeConfigAndMeta({ persist = false })
saveConfig() // atomicWriteJson(CONFIG_PATH, config)
saveMeta()   // atomicWriteJson(META_PATH, META)
```

Paths and environment:

```text
DATA_DIR        optional; defaults to the server directory and owns both JSON paths
CLINE_PASS_KEY  optional runtime account override with a deterministic HMAC-derived ID
PROXY_KEY       optional runtime proxyKey override
PUBLIC_BASE_URL optional runtime publicBaseUrl override
PORT            optional runtime port override
BIND_HOST       optional listen address only; not persisted by startup normalization
config.json     DATA_DIR/config.json
metadata.json   DATA_DIR/metadata.json
```

### 3. Contracts

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
    maxConcurrent, weight, priority,
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
  accountErrorRules: {},        // legacy compatibility projection only
  accountContentErrorRules: [], // legacy compatibility projection only
  accountPipeline: {
    quotaPool: boolean,
    healthSort: boolean,
    sticky: boolean,
    order: ("quotaPool" | "healthSort" | "sticky")[],
    cachePoolSize: integer // 0-100000; 0 disables the cache-focused active pool
  },
  modelAliases: { [clientAlias]: "cline-pass/<known model>" },
  detailedLogging: boolean,      // default false; full detailed capture
  errorDetailLogging: boolean,   // default false; failed chat attempts only
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
- add and persist stable account IDs, `maxConcurrent: 0`, `weight: 1`, `priority: 100`, empty `note/proxyUrl/headers`, and `perModel: {}`;
- accept all six account modes; old `single/roundrobin/sticky` retain their previous behavior;
- normalize `proxyUrl` only to HTTP, HTTPS, SOCKS5, or SOCKS5H and normalize account Header names/values through the shared security validator;
- normalize `modelAliases` only to known `cline-pass/*` targets without alias/original-name collisions;
- normalize legacy `upstream` into `upstreams` while retaining `upstream` as the first-item compatibility mirror;
- normalize global and account routes with the same functions; missing/invalid persisted `providerCooldownMs` becomes 0, while strict saves accept only integer 0-300000;
- default an invalid/missing wait to 2000 ms;
- treat `errorRules` as the only authoritative ordered array, capped at 100 entries / 64 KiB with strict stable IDs, scopes, actions, applicability, conditions, Header names and reset durations; persisted canonical invalidity fails startup without rewriting bytes;
- when canonical rules are absent, migrate legacy content rules in original order before exact legacy status rules, map `ban` to account hard quarantine, persist canonical rules, and retain only lossless legacy API/config mirrors;
- clamp `activeAccount` to the persisted account list;
- normalize the pipeline to `quotaPool`, `healthSort`, `sticky`; recognized legacy four-step input folds `excludeUnhealthy:true` into health sorting and removes the duplicate step;
- normalize a missing/invalid `accountPipeline.cachePoolSize` to `0`; strict management saves accept only integer values from 0 through 100000, while an older client that omits only this field preserves the current server value.

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
      updatedAt
    }
  },
  routingSecret,
  models,
  history,                 // compatibility-only persisted array
  catalog, catalogFetchedAt,
  orModelsFetchedAt, orModelList,
  officialModelsFetch,
  statistics: {
    version: 4,
    lifetime: { global: Aggregate, accounts: { [accountId]: Aggregate } },
    minuteBuckets: [{
      minute,
      global: Aggregate,
      accounts: { [accountId]: Aggregate },
      health: { [accountId]: LegacyHealthDelta }, // retained, no longer written
      models: { [resolvedModelId]: Aggregate },
      accountHealth: { [accountId]: SuccessDelta },
      providerHealth: { [resolvedModelId]: { [provider]: SuccessDelta } }
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
      providerHealthIncompleteAt: { [resolvedModelId]: { [provider]: minute } }
    },
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

`routingSecret` is generated once and persisted so HRW mapping survives restart. `accountStates` entries for removed accounts are deleted; the deterministic environment-account ID remains valid while `CLINE_PASS_KEY` is present. Expired, non-banned cooldown entries are deleted when candidates are read. Ban/cooldown state persists until expiry or `POST /api/accounts/recover` removes it.

Provider state is durable runtime metadata keyed by resolved model and Provider, never by account. Legacy `upstreamStatus` facts normalize additively; explicit `cooldownUntil`, `hardQuarantined`, safe `ruleId`/status/time facts are independent from success data. Hard quarantine survives success/restart and clears only by exact recovery or Provider identity cleanup. A rule action must never copy the rule needle, Header value, response body, credential, or request content into this map.

`metadata.json` must not contain account keys, proxy credentials, custom Header values, account notes, raw session values, HMAC fingerprints, message text, or identity-source labels. Bounded identity-source labels such as `message_hmac` belong only to ordinary request-log projections. Reasons written to metadata are redacted and flattened; bounded model/provider health notes may be truncated, while complete redacted structured provider reasons belong to the separate error JSONL stream.

`Aggregate` retains the existing request/usage/routing counters. `SuccessDelta` has only `successes`, `degrades`, and exact overflow markers. Statistics v4 retains at most 1,440 minute buckets, 50,000 union `(minute, accountId)` cells, 50,000 model aggregate cells, and an independent 50,000 `(minute, resolvedModelId, provider)` success cells. Account and Provider success tracking each have truthful migration starts and cell-loss coverage. v1/v2/v3 weighted health is retained as legacy bytes but is never converted into direct success samples or threshold labels. Any counter overflow becomes `null` with its exact marker.

Legacy name-keyed `stats` is migration input only. It moves once into the separately labelled `migration` baseline and never fabricates exact chat, token, cache, recent-window, or health facts. Unknown newer statistics versions, malformed aggregates, unordered buckets, excess cells, invalid IDs, and malformed quota snapshots fail startup before any save.

Quota state is keyed by stable account ID and stores only projected percentages, canonical ISO reset times, `lastAttemptAt`, `lastSuccessAt`, and a safe error enum. Upstream reset times accept RFC3339 timestamps with an optional 1–9 digit fractional second and mandatory `Z` or numeric offset, reject impossible Gregorian calendar dates, and normalize through `Date#toISOString()` to millisecond UTC before persistence. A successful partial snapshot replaces the complete prior snapshot and is cacheable without becoming routing-fresh; a failed attempt retains the last-good snapshot while recording only its safe category/time. It never stores keys, Headers, proxy values, credential-bearing URLs, raw provider payloads, page-owner tokens, routing epochs, generations, queues or success-version counters. Account deletion prunes account statistics, health coverage, state and quota while retaining global history. Credential/proxy changes clear quota but retain local statistics; disabling an account retains last-good quota for diagnostic display while preventing refresh/publication.

Durable request/error diagnostics no longer grow `metadata.history`; they are separate bounded JSONL streams under `DATA_DIR/logs/` and follow `logging-guidelines.md`. The legacy history array remains compatibility-only.

Opt-in detailed content belongs only to the independent `DATA_DIR/detailed-logs/` store described in `logging-guidelines.md`; metadata exclusions above remain unchanged. `detailedLogging` selects full capture and `errorDetailLogging` selects failed-chat-attempt capture; both default off and full wins when both are enabled. `POST /api/logs/settings` accepts a non-empty exact subset of those two boolean fields, so legacy `{ detailedLogging: boolean }` remains valid. Persist the complete candidate config with `atomicWriteJson(CONFIG_PATH, { ...config, ...candidate })` **before** changing either runtime mode. Failed writes return a safe 500 with both prior runtime values/file intact; rejected payloads return 400 without a write. The settings must not reuse destructive account saves or reload account drafts. Missing/invalid persisted values are off, not truthy enablement.

#### Atomic write and file mode

`atomicWriteJson()` writes formatted JSON to a unique temporary file in the same directory and then calls `renameSync()` over the destination. The temporary file is removed in `finally`.

- A newly created JSON file uses mode `0600`.
- An existing destination's mode is preserved; the implementation does **not** force a pre-existing permissive file to `0600`.
- A non-`ENOENT` read or stat error is fatal.
- A malformed existing JSON file makes startup fail before migration saves anything. It is never replaced by defaults.

### 4. Validation & Error Matrix

| Input/state | Persisted result or error |
|---|---|
| Missing file (`ENOENT`) | use fallback; persist only if normalization becomes dirty or a later save occurs |
| Malformed existing JSON | throw `cannot read <file>: ...`; process exits; original bytes remain |
| Missing legacy account fields | generate/persist `id`, `maxConcurrent: 0`, `perModel: {}` |
| Unknown account state after account deletion | remove state on normalization/account save |
| `concurrencyWaitMs` outside 0-30000 at startup | normalize to 2000 |
| Management API wait outside 0-30000 | `400`; no write |
| `maxConcurrent` outside 0-100000 through management API | `400`; no write |
| `weight` or `priority` outside integer 1-100 | `400`; no write |
| Note exceeds 500 characters or contains forbidden controls | `400`; no write |
| Proxy URL has an unsupported scheme/host/port/path/query/hash | `400`; no write |
| Account Header map exceeds count/value/total limits or contains a forbidden credential/session/hop-by-hop name | `400`; no write |
| Model alias is invalid, duplicated, collides with an original ID, or targets an unknown/non-Cline model | `400`; no write |
| Route has over 20 upstreams, over 50 exclusions, invalid slug/mode/sort, `maxRetries` outside 0-20, or `providerCooldownMs` outside integer 0-300000 | `400`; no write |
| Canonical rules are non-array/over 100/over 64 KiB, have invalid/duplicate IDs, unknown fields, empty/duplicate scopes, no active condition, invalid status/body/Header/applicability, or invalid reset format/duration | `400`; no write |
| A POST omits `errorRules` and changes either legacy mirror | `409`; preserve canonical rules and file bytes; unchanged/missing mirrors are accepted |
| Canonical `accountPipeline` lacks any of the three booleans, has unknown fields, invalid cache size, or non-permutation order | `400`; no write; complete recognized legacy four-step input is normalized, and older omission of order/size preserves current values |
| Legacy provider health lacks new fields | normalize to bounded defaults while preserving safe status/note/timestamps |
| Invalid provider-health timestamp/count/status | normalize to zero/unknown/bounded values; never copy raw payload data |
| Valid statistics v1/v2/v3 | validate each old exact field set, migrate through model/routing versions, then add empty v4 account/provider success owners and independent tracking starts without converting legacy weighted health |
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
- **Base:** `errorRules: []`, all-false canonical `accountPipeline` with `cachePoolSize: 0`, and `maxConcurrent: 0` preserve no-action/legacy-routing/unlimited behavior.
- **Base:** a missing metadata file creates a routing secret and owner-only metadata on first migration save.
- **Bad:** catching JSON parse failure and saving defaults; this destroys operator configuration.
- **Bad:** using account name or key as the state-map key; renaming or credential rotation would orphan state.
- **Bad:** assuming all existing JSON files are mode `0600`; only new files get that default.

### 6. Tests Required

Persistence changes must use a temporary `DATA_DIR` and assert:

- malformed `config.json` causes non-zero startup, reports `cannot read config.json`, and retains the exact original bytes;
- legacy accounts gain non-empty stable IDs, `maxConcurrent: 0`, `weight: 1`, `priority: 100`, empty note/proxy/Header fields, and `perModel`, then retain IDs across restart;
- all new account fields, model aliases, and all 24 pipeline order permutations survive an authenticated save/restart round trip without erasing account routes;
- missing legacy pipeline order and cache-pool size migrate to the compatibility defaults, old-client saves preserve the current order/size, valid cache-pool sizes survive restart, and malformed explicit values fail without changing file bytes;
- invalid proxy/Header/note/weight/priority/alias payloads return `400` and preserve the previous file bytes;
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

The same fail-closed rule applies to quota snapshots and overflow metadata.
