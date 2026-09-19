# Implementation Plan

## 1. Baseline and validators

- [ ] Run baseline syntax/focused integration/UI tests and snapshot dirty state.
- [ ] Add strict duration/reset and canonical errorRules normalization with unit-level integration cases.
- [ ] Add startup legacy conversion and old-client compatibility comparison/409 before runtime consumers change.

Checkpoint: malformed config bytes preserved; valid legacy order round-trips.

## 2. Dynamic states and matcher

- [ ] Add bounded attempt context (status/body/header/model/provider) and first-match engine.
- [ ] Add conservative unmatched default classifier.
- [ ] Extend account/provider-model state normalization, persistence and manual recovery APIs.
- [ ] Wire pre-stream/post-start/cancel behavior without duplicating account/provider retry ownership.

Checkpoint: scope isolation, restart, recovery, identity cleanup, secret absence.

## 3. Statistics and projections

- [ ] Upgrade statistics schema with empty vNext account/provider health owners and truthful tracking starts.
- [ ] Extend request finalizer for account-dedup and per-named-attempt samples.
- [ ] Add 24h aggregation, coverage/cell-cap/overflow validation and API projections.
- [ ] Remove threshold-derived account/provider health routing inputs.

Checkpoint: 0/null, one sample, aging, model isolation, multiple provider attempts, cancellation.

## 4. Pipeline and UI

- [ ] Migrate four-step pipeline input to canonical three-step execution and stable account success sorting.
- [ ] Replace unified UI rule draft, visual rows, advanced JSON and presets with errorRules.
- [ ] Render success rate/sample/coverage plus independent states and Provider recovery.
- [ ] Preserve full account payload, hidden routes and stale editor generations.

Checkpoint: account-draft/ui-contract/real-browser interactive evidence where needed.

## 5. Documentation and final gate

- [ ] Update config example/README and backend/frontend specs for this child scope.
- [ ] Run focused tests, then full project gate from parent plan.
- [ ] Run full-scope Trellis check, commit, archive; do not deploy.

Rollback points: before canonical config save; before statistics version write; before removing legacy UI controls.
