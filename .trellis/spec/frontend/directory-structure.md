# Frontend Directory Structure

> The console is one server-served static document with native browser APIs and no build step.

---

## Runtime Layout

```text
public/index.html          HTML structure, CSS, DOM state, and browser behavior
test/ui-contract.test.js  static DOM/accessibility/contract assertions
test/account-draft.test.js
                           production-script VM tests for account/raw/quota state
test/detailed-log-ui.test.js
                           production-script VM tests for detailed-log state
test/model-provider-ui.test.js
                           production-script VM tests for model/Provider statistics state
server.js                 authenticated JSON APIs consumed by the console
```

There is no React/Vue/Svelte component tree, custom-hook layer, TypeScript source, CSS module system, asset pipeline, or frontend dependency. `server.js` serves `public/index.html` directly.

## Organization Inside `public/index.html`

Keep the existing order:

1. document metadata and the single `<style>` block;
2. semantic HTML for login, top navigation, console/statistics/log/detail panels, dialogs, and drawer;
3. one inline `<script>` containing state owners, rendering, API calls, validation, and event handlers.

The top-level UI has six mutually exclusive sections controlled by `switchSection()` (console, statistics, request logs, error logs, detailed logs, model/Provider statistics). Native elements are preferred: `<button>`, `<input>`, `<select>`, `<textarea>`, `<details>`, and `<dialog>`. Wide tables use `.table-wrap` rather than shrinking content or overflowing the page.

## State and Feature Placement

State remains close to the feature that owns it:

- `DATA`, `ACCS`, and `ALIASES` hold server snapshots.
- `BULK_SELECTION` owns account object-reference selection.
- `RAW_SCHEDULING` owns only the open raw-editor snapshot.
- `STATISTICS_*`, `MODEL_PROVIDER_*`, `LOG_*`, and `DETAIL_*` generations/controllers prevent stale cross-section updates.

Do not add a second generic store or reconstruct complete account objects from visible table cells. New browser behavior should reuse `api()`, existing snapshots, and the relevant generation owner.

If the console eventually needs a build system, that is an explicit architecture migration. Do not introduce framework/component/hook files for one feature while production still serves one unbundled HTML file.

## Naming Conventions

- JavaScript functions and local variables use lower camel case: `loadStatistics()`, `quotaRefreshSummary()`.
- Long-lived state owners/constants use uppercase snake case: `STATISTICS_VISIT_ID`, `DETAIL_CURSOR`.
- DOM IDs use lower camel case and describe ownership: `statisticsRefresh`, `rawSchedulingDialog`.
- CSS classes use lowercase kebab-case: `.table-wrap`, `.drawer-backdrop`.
- Test names describe observable behavior, not implementation internals.

## Rendering and API Boundaries

All server-controlled text interpolated into HTML passes through `escapeHtml()`; JavaScript arguments use `jsArg()`. Prefer `textContent` or textarea `.value` for arbitrary diagnostic text. Do not render raw provider/config objects merely because an authenticated API returned them.

The shared `api()` helper owns authentication headers, 401/login behavior, JSON/text reads, and optional abort signals. Keep its existing call compatibility when extending it.

## Examples and Anti-Patterns

**Good:** add statistics lifecycle logic beside `loadStatistics()` and bind it to `STATISTICS_VISIT_ID`.

**Good:** execute the real inline script in a Node VM test, then separately use static UI contracts and manual Chrome evidence for accessibility/layout claims.

**Bad:** split production browser logic into files that `server.js` never serves, or add a browser dependency without an explicit loading/build migration.

**Bad:** assign server text directly to `innerHTML`, share one generation counter between statistics and logs, or call `loadAll()` when opening a diagnostic panel.

## Verification

```bash
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
node --test test/ui-contract.test.js test/account-draft.test.js test/detailed-log-ui.test.js test/model-provider-ui.test.js
npm test
git diff --check
```

VM/static tests are not browser automation. Keyboard, focus, native dialogs, clipboard fallback, live-region quality, and responsive scrolling require real-browser evidence when changed.
