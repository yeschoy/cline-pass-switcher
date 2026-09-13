# Frontend Quality Guidelines

> Executable UI contracts for the static Cline Pass administration console.

---

## Scenario: Responsive account administration and diagnostic views

### 1. Scope / Trigger

Use this contract when changing `public/index.html` account management, presets, the account drawer, model aliases, or request/error logs.

The console is a single static HTML file with authenticated JSON calls. Server validation remains authoritative, while the browser must preserve hidden account state and prevent accidental destructive changes.

### 2. Signatures

```js
loadAll()
renderAccounts()
collectAccounts()
openAccountDrawer(index, returnButton)
closeAccountDrawer(force)
saveDrawer()
previewPreset()
applyPreset()
generateAliases()
saveAliases()
switchSection(section)
loadLogs(nextPage)
clearLogs()
```

Relevant APIs:

```text
GET/POST /api/accounts
POST     /api/accounts/proxy-test
GET/POST /api/model-aliases
GET      /api/logs/{requests|errors}
DELETE   /api/logs/{requests|errors}
```

### 3. Contracts

#### Responsive layout

- The page uses the available desktop width up to 1800px; it must not restore the old 1200px cap.
- Wide tables live in `.table-wrap { overflow-x: auto }` rather than squeezing fields until unusable.
- Account names have at least a 240px desktop column and a full-value `title`. Common email-style names remain inspectable.
- At widths below 600px, page/drawer padding decreases, but controls remain reachable and tables scroll horizontally.

#### Account table and drawer

The main table is a status summary. Full name, note, Key, capacity, weight, priority, proxy URL, custom Header map, and account-route summary are edited in the right-side account drawer.

The drawer:

- is a labelled `role="dialog"` with `aria-modal="true"`;
- moves focus into the form and returns focus to the opening control;
- closes on Escape/backdrop/Close only after confirming dirty drafts;
- masks account Key and proxy URL by default;
- resets the Key visibility control and input type on every open, while excluding visibility-only state from the dirty-draft snapshot;
- keeps proxy/error feedback in an `aria-live` region;
- saves into the local complete account snapshot, then requires the explicit account-config save for persistence.

`collectAccounts()` must preserve every hidden field:

```js
{
  id, name, note, key, enabled,
  maxConcurrent, weight, priority,
  proxyUrl, headers, perModel
}
```

Filtering by name/note changes rendering only; it must not change account indexes, active-account identity, or the submitted full list.

#### Presets

The six presets produce an editable draft and a current-to-next preview. They may change only `accountMode`, `concurrencyWaitMs`, `maxConcurrent`, `weight`, `priority`, and status-specific `accountErrorRules`. They never mutate names, Keys, enablement, proxy, Header maps, or model routes.

Cancel discards the draft. Confirm submits through the ordinary complete account save, so the server applies the same validation as manual edits. No persistent “selected preset” state exists.

#### Model aliases

The alias editor uses one `alias = cline-pass/target` pair per line. Batch generation removes `cline-pass/` and applies the optional common prefix/suffix. Duplicate/malformed rows are rejected in the browser for feedback, and the complete object is still validated by the server.

After successful save, reload the server snapshot. Do not optimistically claim aliases that the server rejected.

#### Top-level sections and logs

The top navigation exposes three mutually exclusive sections: console, request logs, and error logs. The active native button uses `aria-pressed="true"`; the other buttons are false. Selecting a log section hides the complete console panel and shows the shared log panel immediately below the navigation. Do not implement log navigation with anchors, `scrollIntoView()`, or a duplicate log page/DOM.

Request and error sections share one bounded filter, table, cursor, and clear implementation. `switchSection()` selects the type, updates the visible title/status, invalidates pending log reads, and starts a first-page load. `loadLogs()` ignores a response whose query generation or selected type is stale. “Next” sends only the server-provided cursor. Changing a filter or type resets the cursor. Clear captures the selected type before awaiting deletion, requires explicit confirmation naming that type, and reloads only if the same log section is still visible.

Render only projected log fields. Never render raw request/response bodies, Header values, proxy URLs, account notes, or credential-like data in a log detail.

#### Rendering safety

Every server-controlled value inserted via `innerHTML` passes through `escapeHtml()`; JavaScript string arguments use `jsArg()`. Prefer `textContent` for drawer/status text. Authentication failures continue to show the login overlay rather than rendering partial sensitive state.

### 4. Validation & Error Matrix

| UI condition | Required behavior |
|---|---|
| Drawer Header JSON is malformed | keep drawer open, show error, do not mutate account draft |
| Name/note/number/proxy/Header fails server validation | keep/reload prior server state and show safe error |
| Drawer is dirty and user presses Escape/backdrop/Close | ask before discarding |
| Proxy test on unsaved account | explain that the account must be saved first |
| Preset is cancelled | no account or global field changes |
| Preset is confirmed | submit a complete account snapshot through normal API |
| Alias row lacks `=` or duplicates an alias | block save and identify the row/alias |
| Top section changes while a log query is pending | invalidate the old query; it must not update hidden or newly selected log state |
| Log filter changes | reset cursor before querying |
| Clear log selected | confirm with the captured type, delete only that type, and reload only if that same section remains visible |
| API returns `401` | show login overlay and reject the operation |
| Narrow viewport | maintain usable controls and horizontal table scrolling |

### 5. Good / Base / Bad Cases

- **Good:** open an account by its original table index after filtering, edit proxy/Header values, save the draft and full list, then reload without losing `id` or `perModel`.
- **Good:** preview “保守防封”, inspect the capacity/rule changes, cancel, and observe an unchanged account snapshot.
- **Good:** switch rapidly from request logs to errors and then console; only the current section remains visible and stale responses cannot replace its state.
- **Base:** an old account shows weight 1, priority 100, direct proxy status, and empty note/Header fields.
- **Base:** no log records renders an empty-state row and disables next page.
- **Bad:** rebuild account objects from visible table cells; hidden routes/proxy/Header fields will be erased.
- **Bad:** put raw server JSON into a log `<pre>`; future fields could expose secrets.
- **Bad:** encode preset logic in the backend and UI independently; values will drift.

### 6. Tests Required

`test/ui-contract.test.js` provides static executable checks for:

- 1800px responsive container, table wrappers, and account-name width;
- six bounded presets and forbidden-field absence from preset drafts;
- labelled modal/drawer semantics, Escape handling, focus return, dirty confirmation, and `aria-live` feedback;
- account snapshot preservation for new hidden fields;
- three mutually exclusive top sections with one shared log DOM, explicit active state, and no anchor/scroll shortcut;
- log query invalidation, filters/pagination, captured-type clear controls, and model-alias batch controls.

Manual browser review remains required for visual width, narrow-screen scrolling, focus order, keyboard-only drawer use, password masking, preview readability, and log/alias interaction. Static string tests must not be reported as visual browser automation.

Run the embedded script syntax check used by the test suite, `npm test`, and `git diff --check` after changing the console.

### 7. Wrong vs Correct

#### Wrong

```js
const accounts = visibleRows.map(readVisibleColumns);
```

#### Correct

```js
const accounts = ACCS.accounts.map((account, index) => ({
  ...account,
  enabled: readEnabled(index)
}));
```

Treat the server snapshot as the complete object owner. A filtered/status table is a projection, not the source of truth.
