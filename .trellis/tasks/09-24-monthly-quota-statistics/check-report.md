# Monthly quota statistics — check report (2026-09-24)

## Contract and review

- The operator confirmed all current accounts belong to the same Cline Pass subscription. The $10/$25/$50 window caps remain screenshot-derived community reference estimates, not API balances, official limits or actual bills. No persisted plan field, new upstream quota job, routing rule or production change was introduced.
- Monthly reference total includes enabled accounts with a recent successful monthly snapshot even when 5h/weekly windows are missing; immediate reference total includes only fresh three-window snapshots and takes the minimum of each window's *own* dollar equivalent per account. The two sums have independent included/excluded/unknown counts. Missing and failed data do not become numeric zero, but known zero remains zero. +2h/+8h/+24h forecasts restore only a validated reset within the horizon and label incomplete resets as lower-bound estimates.
- Independent check fixed an invalid-generatedAt rendering edge so the page says `未知`, not `Invalid Date`, and added explicit account units to incomplete-reset counts. Existing account drafts, quota refresh generation/controller and routing status stay under their previous owners.

## Executed verification

- `node --test test/ui-contract.test.js test/account-draft.test.js test/detailed-log-ui.test.js`: 46/46.
- `node --check server.js`; `for file in lib/*.js; do node --check "$file"; done`; compile the production inline script using `vm.Script`: passed.
- `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT -u CLINE_PASS_ADMIN_BOOTSTRAP -u CLINE_PASS_ADMIN_INIT_CODE -u CLINE_PASS_ADMIN_INITIAL_PASSWORD -u CLINE_PASS_ADMIN_PROXY_TOKEN npm test`: 258/258.
- `task.py validate 09-24-monthly-quota-statistics` and `git diff --check`: passed; large context specs issue truncation warnings, so the relevant sections were read directly.
- Real local Chrome headless at 390 CSS px loaded the production HTML from a local file; a synthetic monthly-only snapshot rendered `当月剩余：约 $20.00` and `当前可用：无可用数据`, and its +2h monthly reset displayed `$50.00`. The document width equalled the 390px viewport, four cards were 340px wide, the 1500px table scrolled within a 340px wrapper, the refresh button accepted focus and keyboard Enter invoked one synthetic refresh. This is a layout/keyboard smoke with synthetic data; not an authenticated end-to-end browser, screen-reader announcement or production verification.

No production account, real credential, paid upstream or production deployment was used. Existing production `c35cd74` does **not** contain this new display until separately authorized deployment of a later committed main release.
