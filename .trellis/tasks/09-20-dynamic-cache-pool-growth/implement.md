# Implementation Plan

## 1. Preconditions

- [ ] Confirm scoped-error-rules-success-rate child is merged and its three-step pipeline/state projections pass.
- [ ] Run cache-pool focused baseline integration/UI tests.

## 2. Schema and metadata

- [ ] Add strict `cachePoolMaxSize`, legacy default=max=min and complete round-trip validation.
- [ ] Add bounded metadata target normalization, operator clamp/reset and restart persistence.
- [ ] Update config/API/UI/raw scheduling/preset draft ownership.

Checkpoint: old config inert; malformed values no write; explicit operator changes deterministic.

## 3. Capacity growth

- [ ] Refactor membership to consume effective target without storing member IDs.
- [ ] Replace timeout standby overflow with recheck + atomic grow-one + recompute + lease.
- [ ] Preserve unlimited semantics, hard eligibility, reserve, quota routing and idempotent release.
- [ ] Apply account rate sorting only within active candidates.

Checkpoint: one/ all full, capacity wake, timeout, no standby, max reached, concurrent triggers, stream/cancel release.

## 4. Diagnostics and UI

- [ ] Project min/max/target/roles and bounded expansion facts.
- [ ] Update help/status labels and remove misleading one-shot fallback wording.
- [ ] Assert no candidate/session/credential leakage.

## 5. Documentation and final gate

- [ ] Update README/config example/specs for dynamic growth.
- [ ] Run focused tests and full parent gate.
- [ ] Trellis check, commit, archive; do not deploy.

Rollback: set max=min or size=0; code rollback requires pre-change JSON backup.
