# Implementation Plan

## 1. Preconditions

- [ ] Confirm scoped-error-rules-success-rate child is merged and its three-step pipeline/state projections pass.
- [ ] Run cache-pool, sticky identity, healthSort, capacity and account-draft focused baseline tests.
- [ ] Freeze current sticky-only HRW, healthSort-only, cache-pool active/standby and pipeline-order matrices.

## 2. Schema and metadata

- [ ] Add strict `cachePoolMaxSize`, legacy default=max=min and complete round-trip validation.
- [ ] Add `sessionBindingExplicitTtlMs=7200000`, `sessionBindingFallbackTtlMs=900000`, `sessionBindingMaxEntries=50000` with bounds/cross-field validation and old-client omission preservation.
- [ ] Add bounded metadata target normalization, operator clamp/reset and restart persistence; never persistbinding entries.
- [ ] Update config/API/UI/raw scheduling/preset draft ownership for all fields.

Checkpoint: old config remains inert until relevant combination is enabled; malformed values no write; explicit operator changes deterministic.

## 3. Session binding owner

- [ ] Add one process-local Map/LRU owner using existing HMAC fingerprint and explicit/fallback confidence; no raw identity projection or periodic timer.
- [ ] Implement sliding 2h/15m expiry, 50,000 cap, lazy expiry/LRU eviction and restart-empty behavior.
- [ ] Implement provisional entry after lease, confirmation at native attempt commit and owner/generation-safe cleanup/update.
- [ ] Cover concurrent first requests for one session, stale finalizers, no-attempt cancellation and account replacement.

Checkpoint: explicit and message_hmac sessions bind safely without raw/HMAC leakage; same-session concurrent misses converge on one account.

## 4. Conditional hit/miss pipeline

- [ ] Compile the four toggle combinations so sticky-only preserves stateless HRW, health-only sorts every request, and combined mode uses binding hit before miss stages.
- [ ] In combined mode remove sticky from linear miss stages while preserving quotaPool/healthSort relative order and final HRW tie behavior.
- [ ] Validate hit only against current active/hard/quota eligibility; keep bindings across success-rate and hot/warm/unknown changes.
- [ ] Invalidate on delete/disable/key-proxy rotation/cooldown/quarantine/active exit/reserve/exhausted; expose one seam for the later quota task.

Checkpoint: old modes byte/selection compatible outside the combined toggle; hit skips healthSort, miss uses active-only rate ordering.

## 5. Capacity growth and overflow

- [ ] Refactor membership to consume effective target without storing member IDs.
- [ ] Replace timeout standby overflow with recheck + atomic grow-one + recompute + lease where configured max allows.
- [ ] For binding hit capacity full, wait existing deadline then temporary active fallback without rebind.
- [ ] Bind a miss to a standby only after that account is formally grown/promoted/replacement-active.
- [ ] Preserve unlimited semantics, hard eligibility, reserve, quota routing and idempotent release.

Checkpoint: one/all full, capacity wake, timeout, no standby, max reached, concurrent triggers, stream/cancel release, temporary overflow return-to-binding.

## 6. Diagnostics and UI

- [ ] Project min/max/target/roles and safe binding enabled/size plus bounded hit/miss/invalidated/overflow facts.
- [ ] Split UI wording into “会话命中条件门” and sortable “未命中调度步骤”; explain sticky-only HRW versus combined binding semantics.
- [ ] Add TTL/maxEntries controls and update raw scheduling/presets/full-save preservation.
- [ ] Assert no candidate/session/fingerprint/hash-prefix/credential leakage and no binding entry list API.

## 7. Documentation and final gate

- [ ] Update README/config example/backend/frontend specs for dynamic growth and conditional binding.
- [ ] Run syntax, production inline-script compilation, focused identity/cache-pool/account-draft/UI tests and full parent gate.
- [ ] Run Trellis check, commit, archive; do not deploy.

Rollback: set max=min or disable healthSort/sticky combination; code rollback/restart clears the in-memory map and requires pre-change JSON backup for new config fields.
