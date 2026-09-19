# Current contract and gap analysis

## Scope

Read-only analysis for the planning task. Sources inspected: `server.js`, backend routing/error specs, README/config examples, and the archived `09-19-cline-429-upstream-retry` and `09-17-improve-cache-hit-scheduling` task artifacts.

## Confirmed current behavior

### Error rules and account state

- Account status rules are keyed by one exact normalized HTTP status and support only `ignore`, `cooldown`, and `ban` (`server.js:309-318`).
- Ordered content rules support one case-insensitive literal `contains`, optional inclusive status range, and the same three actions. They are capped at 100 entries / 64 KiB and the first match wins (`server.js:224-245`, `server.js:2285-2310`).
- Rule input is a bounded, flattened, redacted failure string. Response Header values are not available to the generic matcher. `Retry-After` is parsed separately for built-in Provider health handling (`server.js:2180+`, `server.js:2258-2269`).
- `cooldown` and `ban` persist under `META.accountStates[account.id]`; `ignore` writes no account state (`server.js:2312-2323`).
- Available-account hard filtering already removes disabled, banned, and currently cooling accounts before the optional scheduling pipeline (`server.js:593-601`).

### Account health versus Provider health

- Account health is a rolling 24-hour weighted terminal-result aggregate, with at most one result per participating account per chat request (`server.js:1319-1415`, `server.js:2515-2518`).
- Provider health is already keyed by `(resolvedModel, provider)` in `META.models[modelId].upstreamStatus[provider]` and is intentionally shared across accounts (`server.js:1127-1170`; `.trellis/spec/backend/quality-guidelines.md`, “Single-provider attempt planning and health”).
- Provider health currently has built-in classification/backoff behavior rather than operator-scoped rules. Account/auth/request/cancel outcomes do not poison Provider health; Provider/unknown 429, 5xx, network, timeout, and unsupported outcomes may do so (`server.js:2258-2278`, `server.js:2349-2370`).
- Therefore the requested “channel + model” dimension has an existing state owner, but not the requested unified rule/action contract.

### Single-Provider attempt semantics

- The repository already implements the requested strict-pinning invariant: each named HTTP attempt injects exactly one Provider in a singleton `only`; any incoming multi-Provider `order` is deleted (`server.js:2017-2058`).
- Configured `upstreams` order is authoritative. Non-cooling Providers retain user order, and `maxRetries` is applied after durable health planning (`server.js:2061-2083`).
- Both persisted `strict` and `preferred` currently use the same Switcher-managed outer sequential retry path. The earlier gateway-side multi-Provider fallback was deliberately removed by archived task `09-19-cline-429-upstream-retry`.
- Thus requirement R4 is primarily a preservation/regression requirement, not a missing implementation.

### “Gateway intelligent selection” gap

- If configured or discovered Providers exist, the Switcher creates named single-Provider attempts in stable order.
- If no Provider is known, there is exactly one unattributed `auto` request and no named outer retry plan (`server.js:2061-2069`).
- `sort` (`cost`, `ttft`, `tps`) is injected inside a singleton Provider attempt; it does not construct a cross-Provider strategy order (`server.js:2019-2057`).
- There is currently no distinct “gateway intelligent selection” mode that computes a repeatable cross-Provider order while still sending only one Provider per HTTP request. Product strategy semantics must be defined.

### Cache pool

- `accountPipeline.cachePoolSize` is a fixed configured integer. The effective active set is recomputed from current eligible accounts but its size never grows automatically (`server.js:720-723`, `server.js:784-803`).
- Active membership excludes explicit account `unhealthy` and quota `reserve`, then uses account priority and stable ID. Available/insufficient/degraded and hot/warm/unknown do not reorder membership.
- Capacity behavior is fixed: try active accounts, wait `concurrencyWaitMs` when all active accounts are full, then overflow to a standby account for that request. Standby overflow does not promote the account into a larger durable active set (`server.js:821-858`).
- The requested grow-only dynamic pool therefore needs a new membership-state contract, but it should extend this owner rather than add a second scheduler.

## Compatibility and safety constraints

- Account selection and lease happen before the Provider attempt loop. Provider errors must not silently select a new account; only an explicit account-removal action may replace the account, at most once and only before client-visible stream output.
- Stream replay after output starts is forbidden. Client cancellation creates no account/Provider health mutation.
- Ordinary logs and metadata may contain only bounded rule IDs/enums/times; raw body, matched text, Header values, credentials, request messages, proxy details, and sessions remain forbidden.
- New config fields require shared server normalization/strict validation, persistence migration/round trip, browser draft preservation, focused tests, README/config example updates, and spec updates.

## External design evidence

- Retry reset handling in comparable routers consistently distinguishes transient cooldown from permanent quarantine, treats `Retry-After` case-insensitively, and avoids retrying before an authoritative future reset. Relevant examples inspected:
  - OmniRoute `providerErrorRules.ts`: status/Header/body-aware rules with explicit model/provider/connection scope.
  - CLIProxyAPI issue 4874: conservative credential-wide cooldown from authoritative retry/reset headers.
- These sources reinforce two design constraints rather than define this project’s product behavior: ambiguous signals should not widen scope, and permanent quarantine must have an explicit recovery path.

## Gaps requiring product decisions

1. Whether sample scope `credential` maps one-to-one to the existing account (one account owns one key), or introduces another identity layer.
2. Permanent-versus-manual recovery semantics for `hard-quarantine` on both scopes.
3. Exact Header matcher grammar and whether multiple `when` conditions are ANDed.
4. `degrade` score/recovery semantics for account and `(model, provider)` state.
5. Dynamic-pool pressure signal, promotion step, configured maximum, and restart persistence.
6. Cross-Provider strategy definition for “gateway intelligent selection”.

## Recommended task decomposition after decisions converge

- Child A: unified scoped error-policy schema, matching, state transitions, projections, UI, migration, and security tests.
- Child B: grow-only dynamic cache-pool membership and capacity tests, depending on Child A’s hard-eligibility projection.
- Child C: intelligent single-Provider strategy planning plus regression coverage that strict mode remains user ordered and singleton-only.
- Parent: source requirements, compatibility contract, cross-child integration tests, spec/docs, and final review.
