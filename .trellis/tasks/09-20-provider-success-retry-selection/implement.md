# Implementation Plan

## 1. Preconditions

- [ ] Confirm scoped-error-rules-success-rate child is merged and Provider success/state APIs are stable.
- [ ] Run existing singleton/provider health/retry integration baseline.

## 2. Incremental planner

- [ ] Separate stable candidate source/filter facts from per-attempt selection.
- [ ] Implement strict-first and retry-health ordering with attempted exclusion.
- [ ] Implement preferred health-first ordering and one compat auto only for truly empty source.
- [ ] Apply maxRetries to actual outer attempts and preserve deterministic tie order.

Checkpoint: configured/discovered/excluded/hard/cooling/null/tie/no-known matrices.

## 3. Transport and control flow

- [ ] Reuse singleton injectPrefs for planner/direct/unknown pipeline; assert no order/multi-only.
- [ ] Wire provider/account action scope to same-account retry/account replacement boundaries.
- [ ] Preserve Authorization/proxy/affinity and circuit generation behavior.
- [ ] Preserve pre-stream retry, post-start no replay, cancel no-side-effect and finalizer exactly-once.

Checkpoint: non-stream, pre/post SSE, account replacement cap and model isolation.

## 4. UI/diagnostics

- [ ] Update strict/preferred descriptions and safe strategy/source/attempt projections.
- [ ] Render provider success/state without reordering the static configuration list.
- [ ] Verify ordinary logs contain no health buckets, raw rule inputs, sessions or secrets.

## 5. Documentation and final gate

- [ ] Update README/config example/specs for strict-first/health retry.
- [ ] Run focused tests and full parent gate.
- [ ] Trellis check, commit, archive; do not deploy.

Rollback: revert selector only; never restore gateway multi-provider order.
