# Implementation Plan

## 1. Preconditions

- [ ] Confirm scoped-error-rules-success-rate child is merged and Provider success/state APIs are stable.
- [ ] Run existing singleton/provider health/retry integration baseline.
- [ ] Freeze current `ignore/degrade/cooldown/hard-quarantine` state, log and success-sample deltas for account/non-stream/pre-stream/post-start SSE paths.
- [ ] Freeze current retry behavior for normalized 4xx/5xx, HTTP-200 envelopes, pre/post-start SSE, account replacement, cancellation and maxRetries.

## 2. Action/sample contract

- [ ] Generalize existing direct-health sampling so degrade/cooldown/hard-quarantine each contribute one failure sample in the declared scope; ignore contributes none.
- [ ] Keep Provider-model sampling per named real attempt and account sampling request/account-deduplicated with failure precedence.
- [ ] Preserve cooldown/quarantine persistence while updating Provider failure timestamps/classification exactly once; do not double count provider-circuit cooldown.
- [ ] Cover retry-success, account replacement, post-start SSE finalization, cancellation, auto attempts, stale generation and idempotent finalizers.

Checkpoint: action matrix has exact sample/state deltas and no cross-scope or sensitive-data regression.

## 3. Retry policy configuration

- [ ] Add strict `normalizeRetryRules()` with missing-default compatibility, exact schema/size/count/ID/status/body validation and startup corruption preservation.
- [ ] Round-trip retryRules through authenticated accounts API, old-client omission preservation, config persistence/restart, browser snapshot, full save and raw scheduling editor.
- [ ] Implement ordered first-match `matchRetryRule()` using normalized status plus existing bounded/redacted failure text; project only rule ID/decision/matchedBy enums.
- [ ] Wire stop into `runChatChain()` after attempt settlement so it blocks remaining Provider attempts and outer account replacement while preserving terminal response.
- [ ] Add the paired system-message preset that previews/applies retry stop plus provider-model health ignore atomically and preserves custom rules.
- [ ] Cover exact `502 + system message must have content`, status-only/body-only misses, case-insensitive body ANY, HTTP-200 envelope/pre-stream SSE forms, post-start no-replay, cancel, auto and maxRetries.

Checkpoint: deterministic request errors produce one real attempt, no account replacement and no health penalty; unrelated 502 behavior stays compatible.

## 4. Incremental planner

- [ ] Separate stable candidate source/filter facts from per-attempt selection.
- [ ] Implement strict-first and retry-health ordering with attempted exclusion.
- [ ] Implement preferred health-first ordering and one compat auto only for truly empty source.
- [ ] Apply maxRetries to actual outer attempts and preserve deterministic tie order.
- [ ] Recompute remaining eligible candidates after each attempt, but never override a retry stop decision.

Checkpoint: configured/discovered/excluded/hard/cooling/null/tie/no-known/maxRetries/retry-stop matrices.

## 5. Transport and control flow

- [ ] Reuse singleton injectPrefs for planner/direct/unknown pipeline; assert no order/multi-only.
- [ ] Wire provider/account action scope to same-account retry/account replacement boundaries.
- [ ] Preserve Authorization/proxy/affinity and circuit generation behavior.
- [ ] Preserve pre-stream retry, post-start no replay, cancel no-side-effect and finalizer exactly-once.

Checkpoint: non-stream, pre/post SSE, account replacement cap, retry stop and model isolation.

## 6. UI/diagnostics

- [ ] Update strict/preferred descriptions and safe strategy/source/attempt projections.
- [ ] Add retry rule visual/advanced draft and paired preset without creating a generic second store or losing account/error rule drafts.
- [ ] Render provider success/state without reordering the static configuration list.
- [ ] Verify ordinary logs contain no health buckets, retry needles/matched fragments, raw rule inputs, sessions or secrets.

## 7. Documentation and final gate

- [ ] Update README/config example and backend/frontend specs for action samples, retryRules and strict-first/health retry.
- [ ] Run server/lib syntax, production inline-script compilation, focused account/UI/integration tests, then the full project gate.
- [ ] Run full-scope Trellis check, commit, archive; do not deploy.

Rollback: revert selector/retry matcher while preserving config backup; never restore gateway multi-provider order or clear existing health/state.
