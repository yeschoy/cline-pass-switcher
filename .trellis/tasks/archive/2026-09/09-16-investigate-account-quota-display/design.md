# Design: Statistics Quota Forecast Panel

## Scope and Boundary

This is a frontend-only projection over the existing authenticated `GET /api/statistics` response. The change stays in `public/index.html` plus focused tests in `test/account-draft.test.js` and static contracts in `test/ui-contract.test.js`.

No backend route, quota fetch, persisted field, configuration, scheduler, account selection, or API contract changes are needed. `loadStatistics()` remains the single owner of the accepted statistics snapshot and renders the new panel together with the existing summary and account table.

## Data Source and Eligibility

For each `accounts[]` row returned by `/api/statistics`, include it only when:

1. `enabled === true`;
2. `quota.status === "fresh"`;
3. `five_hour`, `weekly`, and `monthly` each have a finite numeric `percentUsed` in `[0, 100]`.

The browser validates these values even though the server projection is authoritative. Every other account is excluded and counted. This prevents disabled, stale, failed, partial, or unknown data from increasing the displayed total.

## Calculation

For quota types `five_hour`, `weekly`, and `monthly`:

```text
currentRemaining = 100 - percentUsed
accountAvailable(target) = min(projectedRemaining(type, target))
totalAvailable(target) = sum(accountAvailable(target))
maximum = includedAccounts * 100
```

Targets are current, `generatedAt + 2h`, `generatedAt + 8h`, and `generatedAt + 24h`.

For current, always use `currentRemaining`.

For a future target, a quota window becomes 100% available only when its reset timestamp is a valid canonical ISO value and:

```text
generatedAt < resetsAt <= target
```

Otherwise retain its current remaining value. A missing, invalid, or already-past reset timestamp is conservative and increments the account-level “reset time incomplete” count once, regardless of how many windows are missing. The forecast assumes no consumption after `generatedAt`; it does not attempt to infer a second reset after the one timestamp supplied by upstream.

Calculations retain numeric precision. Rendering rounds total, maximum, and percentage to one decimal place. When no account is eligible, render “无可用数据” rather than a meaningful-looking numeric zero.

## UI

Insert one labelled forecast region between `statisticsSummary` and the existing account table:

- heading: “总可用额度预测”;
- four responsive cards: 当前、未来 2h、未来 8h、未来 24h;
- each card: `可用 X / Y 账号额度点（Z%）`;
- metadata: included/excluded account counts and accounts with incomplete reset times;
- help text: one account has at most 100 quota points, values are not Token/request/money limits, the future forecast assumes no new consumption, and incomplete reset times produce a conservative lower bound.

Use static DOM IDs and `textContent` for numeric projections. The region uses semantic heading/text and `aria-live="polite"`; status is conveyed in text rather than color alone. CSS uses `repeat(auto-fit, minmax(...))` so cards wrap on narrow screens.

## Existing Owners Reused

- `loadStatistics()` accepts the current statistics generation and calls the new projection renderer.
- Existing statistics visit/query generations continue to fence stale responses.
- Existing `quotaLimit()` timestamp validation is moved to/reuses a small adjacent timestamp helper so row rendering and forecast calculation cannot drift.
- Existing `/api/statistics` and quota refresh lifecycle remain unchanged.

No additional browser store, timer, request, cursor, or backend helper is introduced.

## Validation

Production-script VM tests cover:

- exact current/+2h/+8h/+24h totals with a fixed `generatedAt`;
- account-internal minimum before cross-account sum;
- reset boundary behavior and 0%/100% values;
- exclusion of disabled, non-fresh, partial, and invalid rows;
- conservative carry-forward and incomplete-reset count;
- no-data output and accepted-snapshot rendering.

Static UI contracts cover labelled four-card markup, unit/assumption wording, live status, and responsive class presence. Existing statistics lifecycle tests prove that entry/manual/timer refresh uses the same accepted snapshot and preserves draft owners.

## Rollback

Rollback is limited to removing the forecast markup/styles/helpers/render call and its focused assertions. Because there is no API or persistence change, rollback requires no data migration or configuration restoration.
