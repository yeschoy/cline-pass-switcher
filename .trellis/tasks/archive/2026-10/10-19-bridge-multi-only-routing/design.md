# Design: Bridge-aligned multi-only + actual provider

## Overview

Two coupled changes on the **planner/gateway** path only:

1. **Outbound:** one HTTP attempt injects full `providerOptions.gateway.only` + `.order`.
2. **Inbound evidence:** Bridge-parity routing parse for JSON + SSE + error text → `actualProvider` / headers / stats.

Direct OpenRouter path stays on today’s singleton `provider.only` + local walk.

## Outbound (gateway)

```
configured upstreams
  → filter exclude + hardQuarantine (+ optional active cooldown for next-request membership)
  → optional reorder by pinMode/health (strict: source order; preferred: rate order)
  → injectPrefs once: gateway.only = gateway.order = list
  → single native POST
```

| Piece | Behavior |
|---|---|
| `injectPrefs` | Planner/unknown-vercel: set multi `only`+`order`; delete inbound only/order; fold/delete top-level `provider` when writing gateway (Bridge fold). Direct: unchanged singleton. |
| `runChatChain` | If gateway multi-list path: one provider HTTP attempt (`maxAttempts` effectively 1 for provider walk). Account failover unchanged. |
| `pinMode` / `maxRetries` | Gateway: `pinMode` only affects list order before send; `maxRetries` does not open additional provider HTTP attempts on that path (document in UI/spec). Direct: existing meaning. |
| Trace / logs | `targetProviders` = injected list; one attempt row with outbound plan; `actualProvider` from response evidence only. |

Unknown pipeline that currently dual-injects: prefer gateway multi when list length ≥ 1 and not classified direct-only; do not also send conflicting singleton `provider.only` that disagrees with gateway.

## Actual detection

Port Bridge rules into `parseRouting` / shared `observeRoutingMetadata` used by non-stream unwrap and `createSseObserver`:

1. Walk roots: response root, each `choices[i].delta`, each `choices[i].message`.
2. Read `provider_metadata` and `providerMetadata` → `gateway.routing` → prefer `finalProvider`, else `resolvedProvider`.
3. Weaker: top-level string `provider` (slugify).
4. Stickiness when updating: once source is `*.finalProvider`, ignore later non-final; once `*.resolvedProvider`, ignore later bare `provider`.
5. Error path: regex on `error.message` for `"finalProvider"|"resolvedProvider"`; do not overwrite a better sticky value.
6. Never treat `fallbacksAvailable` / candidate lists as actual.

### Streaming gap (production)

Today `createSseObserver` only applies weak `parseRouting` and can miss routing for the entire stream (`stream:true` ⇒ `actualProvider` null in production samples). Fix:

- Use the shared observer on **every** parsed SSE JSON event (not only until byte cap discards events), **or** keep a separate unbounded-for-routing scan that only retains routing/usage/error fields (not full content) so large streams still learn `finalProvider`.
- Do not let bare `provider` overwrite sticky final/resolved (current bug risk at observer lines that set `provider` after routing).

Byte-cap for content/error capture can remain; routing observation must not be permanently starved by the cap.

### Error log rows

When appending error attempts, if routing evidence was observed for that attempt, persist `actualProvider` (and optional `actualProviderSource` if cheap). UI already shows「未知」when absent — extend renderer to prefer stored actual on error rows without inventing from `targetProvider`.

## Spec impact

- `.trellis/spec/backend/quality-guidelines.md` — rewrite singleton-only / delete-order contract for **gateway** path; document one-shot multi only+order; keep direct singleton; document parseRouting Bridge parity + stream observation.
- `.trellis/spec/backend/logging-guidelines.md` — error rows may carry response-evidenced `actualProvider`.
- `.trellis/spec/frontend/quality-guidelines.md` / `state-management.md` — actual column for errors; clarify gateway `order` is priority hint after this change; still never fill actual from plan.

## Risks

| Risk | Mitigation |
|---|---|
| Gateway ignores `order` | Same as Bridge — hint only; AC does not require honor |
| Losing local per-provider cooldown granularity mid-request | Accept for gateway; cooldown still shapes **next** request’s list |
| Dual-pipeline unknown models | Prefer gateway multi; tests for planner vs direct fixtures |
| Observing full SSE for routing increases CPU | Field-only scan / early sticky stop once `finalProvider` locked |

## Test strategy

- Unit/contract: injectPrefs multi only+order; fold provider; direct singleton unchanged.
- Integration: one upstream POST for multi-list planner; body shape assertion.
- parseRouting / SSE fixtures: final vs resolved, camelCase, delta, stickiness, error regex.
- Stream success log gets `actualProvider` when fixture emits routing mid/late stream.
- UI contract: error actual column; no plan→actual.
- Full `npm test` gate.
