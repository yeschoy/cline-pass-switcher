# Research: Local gaps vs Bridge (multi only/order + actual provider)

- **Query**: Current local behavior for building only/order, retry loops, actualProvider logging; concrete gaps vs Bridge and change points
- **Scope**: mixed (local `server.js` / libs / specs vs Bridge research)
- **Date**: 2026-10-19

## Findings

### Files Found

| File Path | Description |
|---|---|
| `server.js` | `injectPrefs`, `buildProviderPlan`, `selectProviderAttempt`, `runChatChain`, `parseRouting`, `createSseObserver`, `recordChat` |
| `lib/detailed-log-capture.js` | Attempt `provider` from outbound `only`/`order` arrays |
| `lib/jsonl-log-store.js` | Request columns include `actualProvider`, `targetProviders` |
| `.trellis/spec/backend/quality-guidelines.md` | Documents singleton-only / delete-order contract |
| `.trellis/spec/frontend/state-management.md` | UI must not describe preferred as gateway `order` |
| `.trellis/tasks/10-19-bridge-multi-only-routing/research/bridge-multi-only-order.md` | Bridge outbound |
| `.trellis/tasks/10-19-bridge-multi-only-routing/research/bridge-actual-provider-detection.md` | Bridge detection |

### Local behavior (as implemented)

#### Outbound only/order

`injectPrefs(body, modelId, { upstream, sort })` (`server.js` ~4789):

- Deletes inbound `provider.only` / `provider.order` / `gateway.only` / `gateway.order`
- If pipeline is planner or unknown: sets `providerOptions.gateway.only = [upstream]` (singleton)
- If pipeline is direct or unknown: sets `provider.only = [upstream]` (singleton)
- Never sets `order`
- Optional `sort` mapped into gateway/provider `sort` for the already-chosen provider

Spec explicitly locks this:

> Every named attempt injects exactly one provider … `injectPrefs()` deletes any incoming `provider.order`/`gateway.order` and never emits one.  
> (`.trellis/spec/backend/quality-guidelines.md`)

#### Retry loop

`runChatChain` (`server.js` ~5305+):

- Builds `buildProviderPlan` from configured `upstreams` (or discovered) with `pinMode` strict/preferred, `maxRetries`, cooldowns
- Loop: `selectProviderAttempt` → `injectPrefs` with **one** `upstream` → HTTP attempt
- On failure (subject to retry rules / circuits / account scope), tries next provider **locally**
- `source === 'auto'` → single attempt with `upstream: null` (no only injection)

This is the inverse of Bridge: Bridge sends multi-only once; local sends singleton-only many times.

#### Actual provider detection / logging

`parseRouting(json)` (`server.js` ~3003):

```javascript
const rt = msg?.provider_metadata?.gateway?.routing || d?.provider_metadata?.gateway?.routing || {};
const direct = typeof d?.provider === 'string' ? d.provider : null;
// finalProvider: rt.finalProvider || slugify(direct)
// fallbacks: rt.fallbacksAvailable
```

Gaps vs Bridge in this helper:

- No `providerMetadata` (camelCase) namespace
- No `resolvedProvider`
- No walk of `choices[0].delta` / nested locations beyond message/root `provider_metadata`
- No regex recovery from `error.message` embedded routing JSON
- No `ProviderSource` path string

SSE: `createSseObserver` (`server.js` ~4617) uses `parseRouting` then may overwrite with top-level `raw.provider` (slugify) — weaker field can replace stronger routing without Bridge’s final/resolved stickiness.

Request log: `recordChat` → `actualProvider: info.provider` (`server.js` ~3738); response headers `X-Cline-Actual-Upstream: routing.finalProvider || 'unknown'`. Trace attempts store **intended** `upstream` (target), not response-evidenced provider per attempt.

Detail capture (`lib/detailed-log-capture.js` ~499) records outbound `only`/`order` targets as attempt `provider` arrays — plan side, not actual.

### Concrete gaps vs Bridge

| # | Gap | Bridge | Local |
|---|---|---|---|
| 1 | Multi-provider outbound | One request: `gateway.only` + `gateway.order` = full list | One slug per HTTP attempt; local sequential retry |
| 2 | `order` emission | Always paired with configured list when injecting | Explicitly deleted; never emitted |
| 3 | Body channel | Fold top-level `provider` into `providerOptions.gateway` only | Dual inject: gateway and/or top-level `provider` by pipeline |
| 4 | Client vs config policy | `provider_policy: client\|config` | Switcher owns plan; inbound only/order stripped each attempt |
| 5 | Actual field coverage | `finalProvider` / `resolvedProvider`, snake+camel, delta/message, error-text regex, source path | Mostly `finalProvider` + direct top-level `provider` |
| 6 | Stickiness | final > resolved > bare `provider` across SSE frames | SSE can overwrite with bare `provider` |
| 7 | Attempt logging | Per-attempt `Provider` + `ProviderSource` from response | Trace `upstream` = requested pin; `actualProvider` only at request final |
| 8 | Spec lock-in | N/A | quality-guidelines + frontend state-management encode singleton-only semantics |

### Recommended change points (file + function)

These are alignment hooks for implement (not edits in this research pass):

1. **`server.js` → `injectPrefs`**  
   Optional path: when aligning with Bridge multi-hint, emit `providerOptions.gateway.only` + `.order` as the full allow-list (and decide whether to keep or retire local per-provider loop). Today this function is the singleton enforcer.

2. **`server.js` → `runChatChain` / `buildProviderPlan` / `selectProviderAttempt`**  
   If multi-only is gateway-owned, collapse named attempts to one HTTP call when list length > 1 (or add a pinMode/policy that means “gateway order”). Account-level retry remains separate.

3. **`server.js` → `parseRouting` (+ `createSseObserver`)**  
   Port Bridge `responseRoutingProvider` / `observeMetadata` rules: camelCase namespace, `resolvedProvider`, delta/message roots, final/resolved stickiness, stop bare-provider overwrite of final.

4. **`server.js` → `unwrap` / error classify paths**  
   Add Bridge-style `routingFacts` regex on error message for actual provider on failures; wire into `recordChat` / `X-Cline-Actual-Upstream` / statistics.

5. **`.trellis/spec/backend/quality-guidelines.md` (+ frontend state-management)**  
   Spec currently forbids emitting `order` and mandates singleton only — any Bridge-aligned product change must update these contracts and UI copy (`preferred` ≠ gateway `order`) before/with code.

6. **`lib/detailed-log-capture.js` → attempt start**  
   Keep outbound targets separate from actual; if Bridge-like `provider_source` is desired, add a response-side field rather than overloading attempt `provider`.

### Related Specs

- `.trellis/spec/backend/quality-guidelines.md` — injectPrefs singleton + parseRouting finalProvider/direct
- `.trellis/spec/frontend/state-management.md` — preferred must not be described as gateway `order`
- `.trellis/spec/frontend/quality-guidelines.md` — `actualProvider` never filled from plan alone
- `.trellis/spec/backend/logging-guidelines.md` — `targetProviders` / `actualProvider` columns

## Caveats / Not Found

- Local also supports OpenRouter **direct** pipeline (`provider.only`) which Bridge folds away; any alignment must define whether dual-pipeline inject remains.
- Bridge default `provider_policy` is `config`; local has no identical knob — closest knobs are per-model `upstreams` / `pinMode` / `maxRetries`.
- This file documents gaps and change points required by the task; it does not claim a chosen product design.
