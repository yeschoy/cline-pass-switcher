# Implementation Plan

## 1. Add the forecast presentation

- Add minimal responsive card styles beside existing statistics/card styles in `public/index.html`.
- Add the labelled four-card region between the existing statistics summary and account table.
- Keep all explanatory text explicit about account quota points, exclusions, conservative lower bounds, and the no-new-consumption assumption.

## 2. Add deterministic projection logic

- Reuse one strict quota reset timestamp validator for both existing row rendering and forecasts.
- Add a pure statistics quota forecast helper for eligibility, current totals, future reset projection, capacity, exclusion counts, and incomplete-reset counts.
- Add a renderer that writes only bounded numeric/constant text into the static card/status elements.
- Call the renderer only from an accepted `loadStatistics()` response; do not add API calls or state owners.

## 3. Add focused tests

- Extend `test/account-draft.test.js` with fixed-time fixtures for exact current/+2h/+8h/+24h totals, reset boundaries, exclusions, missing reset times, 0%/100%, and no eligible data.
- Extend the existing statistics visit test to confirm an accepted snapshot updates the forecast panel without changing request or draft ownership.
- Extend `test/ui-contract.test.js` with four-card labels, accessibility/status markers, truthful units, assumptions, and responsive layout contracts.

## 4. Validate

Run in order:

```bash
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/account-draft.test.js test/ui-contract.test.js
npm test
git diff --check
```

Review the final diff to confirm:

- only `public/index.html`, the two focused tests, and task artifacts changed;
- no API, persistence, quota request, routing, account draft, or refresh lifecycle behavior changed;
- server-controlled account values are not added to the new `innerHTML` path;
- the panel remains readable at narrow width by CSS wrapping (real-browser layout evidence if available; otherwise report it as unverified).

## Rollback Point

Before implementation, retain the current diff. If focused tests reveal a statistics lifecycle or data-truthfulness regression, revert only the forecast presentation/helper/test changes; no production data rollback is required.
