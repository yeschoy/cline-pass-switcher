# Align multi-only provider routing with ClinePassBridge

## Goal

Align gateway outbound pinning and actual-channel detection with [ClinePassBridge](https://github.com/xiao-qiu-qiu/ClinePassBridge): one planner/gateway request carries the full configured `only` + `order`, and responses (including streams and failures with embedded routing) populate response-evidenced actual provider — never invent from the plan.

## Confirmed facts

- Bridge: one POST; `providerOptions.gateway.only` and `.order` = configured providers; fold top-level `provider` into gateway; no local per-provider walk.
- Bridge actual: `finalProvider` > `resolvedProvider`; snake/camel namespaces; delta/message roots; error-message regex; SSE stickiness; candidates never count; missing → 「未知」.
- Local today: singleton `only`, delete `order`, local sequential retry; `parseRouting` weak; SSE observer bounded and misses stream actual (production: stream successes ≈ 100% null `actualProvider`, non-stream known).
- Error rows omit `actualProvider` today; success rows null when stream parsing misses evidence.

Research: `research/bridge-multi-only-order.md`, `research/bridge-actual-provider-detection.md`, `research/local-gaps.md`.

## Decisions

1. **Outbound = A** — One HTTP attempt with full gateway `only` + `order`; no local per-provider sequential walk on that path. Account replacement remains separate.
2. **Pipeline = planner/gateway only** — OpenRouter direct keeps singleton `provider.only` + existing local retry (out of scope).
3. **Detection = full Bridge parity** — Including stream observation with stickiness, error-text recovery, and writing actual on error rows when response evidence exists.

## Requirements

1. On **planner** (and dual-unknown treated as gateway-capable) paths, inject the allow-list once as `providerOptions.gateway.only` and `.order` (same ordered list after local exclude / hard-quarantine filter). Do not emit singleton-only loops for that list.
2. Fold conflicting inbound top-level `provider` / gateway only|order per Bridge-style prepare: config-owned injection wins for this product (strip client only/order, inject configured list) unless a later task adds `provider_policy`.
3. **Direct** pipeline unchanged: singleton `provider.only`, local sequential retry, existing specs for that path.
4. Collapse gateway-path `runChatChain` provider attempts to **one** named upstream HTTP call when a non-empty allow-list is injected; `pinMode` / health may only **reorder** the `order`/`only` arrays before send, not open a second provider HTTP attempt.
5. Provider-model cooldown / quarantine still filters membership of the injected list on **subsequent** requests; a failed one-shot attempt may still apply rules to evidenced actual provider or to planned pins per existing scope rules (design must not invent provider from plan for logging).
6. **Actual detection** matches Bridge field priority and locations; SSE must be able to learn actual across the stream (not only a head that permanently misses routing); stickiness: final > resolved > bare provider.
7. Request log `actualProvider` and error-log actual (new/allowed field) stay response-evidenced; UI「未知」when absent; never copy plan into actual.
8. Update backend/frontend specs that currently forbid emitting `order` / mandate singleton-only for the gateway path; keep “preferred ≠ inventing gateway order semantics in UI copy” honest — after this change, gateway `order` **is** the priority hint (document clearly).

## Acceptance Criteria

- [ ] Planner/gateway chat with ≥2 configured upstreams: a single upstream POST body contains matching `providerOptions.gateway.only` and `.order` arrays (post exclude/quarantine filter); no second provider slug attempt in the same account hop solely to walk the list.
- [ ] Direct-pipeline tests still use singleton `provider.only` and local multi-attempt behavior.
- [ ] Non-stream and **stream** successes populate `actualProvider` when upstream reports `finalProvider` or `resolvedProvider` (snake or camel, including delta/message); production-class regression: stream success must not be systematically null when metadata is present.
- [ ] Bare top-level `provider` must not overwrite an already-sticky `finalProvider` / `resolvedProvider`.
- [ ] Failure responses with routing only inside `error.message` text can recover actual via Bridge-equivalent regex; error UI may show that actual when stored; still「未知」with no evidence.
- [ ] Plan columns / `targetProviders` remain the allow-list; actual never filled from plan alone.
- [ ] Specs + contract tests updated; focused + full gate green.

## Out of scope

- Changing OpenRouter direct multi-`only` semantics.
- Adding Bridge `provider_policy: client|config` knob (default remains config-owned injection).
- Redesigning account selection / workflow / proxy assignment.
- Guaranteeing gateway honors `order` (hint only, same as Bridge).

## Notes

- Complex task: `design.md` + `implement.md` required before `task.py start`.
