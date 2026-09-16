# Current Pipeline Flow and Change Constraints

## Source map

- Configuration default and startup normalization: `server.js:41`, `server.js:240-252`, `server.js:363-364`.
- Mandatory account eligibility: `server.js:432-450`.
- Existing six account-mode ranking and leases: `server.js:452-568`.
- Fixed pipeline planning/selection: `server.js:569-651`.
- Session identity/HRW input: `server.js:1125-1209`.
- Account API validation/save: `server.js:2243-2300`.
- Visible controls/load/raw draft/save: `public/index.html:213`, `public/index.html:481-486`, `public/index.html:838-906`.
- Existing integration coverage: `test/integration.test.js:728-739`, `test/integration.test.js:979-998`.
- Existing production-script UI coverage: `test/account-draft.test.js:76-85`, `test/account-draft.test.js:150-290`.

## Current semantics

The runtime always filters missing-key, disabled, banned, cooling and request-excluded accounts first. If any pipeline boolean is true, it then applies unhealthy exclusion, quota grouping, health grouping and optional/implicit sticky in one fixed order. Quota groups are outer priority, health groups inner priority. Sticky chooses an HRW primary only from the first group. Final lease behavior differs by account mode; provider retries remain on one leased account and only pre-output cooldown/ban may re-enter selection once.

All-false pipeline configuration bypasses this path and calls the unchanged legacy selector. `accountMode=sticky` supplies implicit affinity even when `accountPipeline.sticky` is false.

## Confirmed new semantics

The operator requires all four optional stages to be freely reorderable. Earlier enabled stages have higher priority; later stages refine candidates without crossing existing priority groups. Mandatory eligibility remains outside the sortable list and always runs first. The final account mode remains outside the sortable list.

A practical plan representation is an ordered list of candidate groups. Quota and health stages split every existing group in stable order. Sticky with an identity splits each group into HRW-ordered singleton groups, so placing it early intentionally dominates later grouping. Unhealthy exclusion removes unhealthy entries while preserving prior groups; if every candidate would be removed, fallback is restricted to the earliest prior group and keeps its highest-score ties, preserving earlier-stage priority and the existing global fallback when exclusion is first.

## Compatibility constraints

- Missing persisted order must normalize to the current order: `excludeUnhealthy`, `quotaPool`, `healthSort`, `sticky`.
- All four step IDs remain present in the stored order even when disabled.
- An older management client that submits all four booleans but omits order must preserve the server's current order.
- Explicit order must be an exact permutation; unknown, duplicate or missing IDs are invalid.
- If mode is sticky and the sticky flag is false while another pipeline stage is enabled, affinity is injected once at the end for compatibility. If the sticky flag is true, its configured position applies and no implicit duplicate is added.
- Four false booleans continue to use the legacy selector regardless of stored order.

## UI constraints

The existing `ACCS` snapshot and live scheduling controls remain the only draft owner. Reordering changes DOM/draft state only until the existing “保存账号配置” action. The raw scheduling editor must expose the same order and participate in stale-snapshot comparison. Native drag/drop needs native-button keyboard equivalents and an `aria-live` announcement; no dependency or second state store is needed.
