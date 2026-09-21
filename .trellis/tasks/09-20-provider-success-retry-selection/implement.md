# Implementation Plan

## 1. Preconditions

- [ ] Confirm scoped-error-rules-success-rate child is merged and Provider success/state APIs are stable.
- [ ] Run existing singleton/provider health/retry integration baseline.
- [ ] Freeze current `ignore/degrade/cooldown/hard-quarantine` state, log and success-sample deltas for account/non-stream/pre-stream/post-start SSE paths.

## 2. Action/sample contract

- [ ] Generalize existing direct-health sampling so degrade/cooldown/hard-quarantine each contribute one failure sample in the declared scope; ignore contributes none.
- [ ] Keep Provider-model sampling per named real attempt and account sampling request/account-deduplicated with failure precedence.
- [ ] Preserve cooldown/quarantine persistence while updating Provider failure timestamps/classification exactly once; do not double count provider-circuit cooldown.
- [ ] Cover retry-success, account replacement, post-start SSE finalization, cancellation, auto attempts, stale generation and idempotent finalizers.

Checkpoint: action matrix has exact sample/state deltas and no cross-scope or sensitive-data regression.

## 3. Incremental planner

- [ ] Separate stable candidate source/filter facts from per-attempt selection.
- [ ] Implement strict-first and retry-health ordering with attempted exclusion.
- [ ] Implement preferred health-first ordering and one compat auto only for truly empty source.
- [ ] Apply maxRetries to actual outer attempts and preserve deterministic tie order.

Checkpoint: configured/discovered/excluded/hard/cooling/null/tie/no-known matrices.

## 4. Transport and control flow

- [ ] Reuse singleton injectPrefs for planner/direct/unknown pipeline; assert no order/multi-only.
- [ ] Wire provider/account action scope to same-account retry/account replacement boundaries.
- [ ] Preserve Authorization/proxy/affinity and circuit generation behavior.
- [ ] Preserve pre-stream retry, post-start no replay, cancel no-side-effect and finalizer exactly-once.

Checkpoint: non-stream, pre/post SSE, account replacement cap and model isolation.

## 5. UI/diagnostics

- [ ] Update strict/preferred descriptions and safe strategy/source/attempt projections.
- [ ] Render provider success/state without reordering the static configuration list.
- [ ] Verify ordinary logs contain no health buckets, raw rule inputs, sessions or secrets.

## 6. Documentation and final gate

- [ ] Update README/config example/specs for strict-first/health retry.
- [ ] Run focused tests and full parent gate.
- [ ] Trellis check, commit, archive; do not deploy.

Rollback: revert selector only; never restore gateway multi-provider order.
