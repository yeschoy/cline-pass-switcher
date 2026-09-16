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
previewErrorPreset()
applyErrorPreset()
loadStatistics(visitId, announce)
refreshStatisticsQuota(force, visitId)
startStatisticsVisit()
stopStatisticsVisit()
restoreStatisticsVisit()
generateAliases()
saveAliases()
switchSection(section)
loadLogs(nextPage)
clearLogs()
```

Relevant APIs:

```text
GET/POST /api/accounts
GET      /api/statistics
POST     /api/statistics/quota-refresh
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

#### Bulk concurrency controls

Bulk selection uses native row checkboxes with escaped account-name labels, separate from active/enabled controls. Current-search select-all exposes native checked/indeterminate/disabled state. A labelled number input has `min=0`, `max=100000`, and `step=1`; application still validates the complete input before mutation. Empty targets disable apply. A bounded scrolling `textContent` summary lists full selected names/count, and `aria-live` feedback announces errors and local application. Persistent guidance explains that changes remain a draft until “保存账号配置” and that changing search clears selection, not edits. Selection and hydration contracts are in `state-management.md`.

`test/ui-contract.test.js` checks these native/label/live-region markers; `test/account-draft.test.js` executes actual production logic. Keyboard-only row/select-all use, mixed-state announcement, stable focus after apply, full-name readability and desktop/narrow layouts still require browser review.

#### Raw scheduling modal

The raw scheduling entry opens a native `<dialog>` with `showModal()`, title/help associations, a labelled JSON textarea, native apply/cancel buttons, and separate `aria-live` error/draft feedback. Guidance must identify current-page draft state, pool-wide policy, reference-only full names, runtime eligibility constraints, and the separate “保存账号配置” persistence step. Use textarea `.value` and feedback `.textContent`, never interpolate raw JSON into HTML.

The modal focuses the textarea on open and returns focus to its opener after apply/close. Native `cancel` (Escape) is prevented and routed through dirty-text discard confirmation; declining keeps the editor open. Width/max-height/overflow and wrapped textarea text keep long names inspectable. Validation and stale errors preserve text for correction; see `state-management.md` for exact schema and draft ownership.

`test/ui-contract.test.js` checks native modal/label/live-region/wrapping markers; production VM tests check cancel routing and explicit focus calls, not actual browser focus containment. Keyboard open/apply/cancel/Escape, discard prompts, focus containment/return, long duplicate names and narrow viewport scrolling remain required manual browser checks.

#### Presets and pipeline controls

The four pipeline rows are native draggable elements with visible handles, current position numbers, independent enablement checkboxes, and native up/down button equivalents. Mouse drop and keyboard-operable buttons call the same DOM reorder owner, update first/last disabled states, and announce the draft-only result through `aria-live`. Disabled steps remain orderable and retain their positions; reordering never sends a request.

The six scheduling presets produce an editable draft and a current-to-next preview. They may change only `accountMode`, `concurrencyWaitMs`, `maxConcurrent`, `weight`, `priority`, and status-specific `accountErrorRules`. They never mutate names, Keys, enablement, proxy, Header maps, model routes, or the four pipeline toggles.

The separate five error-rule presets are `standard`, `fast`, `conservative`, `observe`, and `clear`. They parse the live JSON textarea at preview time and show preserve/add/modify/delete groups. Merge preserves custom statuses; replace may delete them; clear forces replace. Built-in 4xx entries are limited to `429`.

Cancel discards the relevant draft. Confirm submits through the ordinary complete account save, so the server applies the same validation as manual edits. No persistent “selected preset” state exists. Pipeline controls submit `quotaPool`, `excludeUnhealthy`, `healthSort`, and `sticky` plus `order`, which is read from the four existing DOM nodes as an exact permutation.

#### Model aliases

The alias editor uses one `alias = cline-pass/target` pair per line. Batch generation removes `cline-pass/` and applies the optional common prefix/suffix. Duplicate/malformed rows are rejected in the browser for feedback, and the complete object is still validated by the server.

After successful save, reload the server snapshot. Do not optimistically claim aliases that the server rejected.

#### Top-level sections, statistics, and logs

The top navigation exposes five mutually exclusive sections: console, statistics, request logs, error logs, and detailed logs. The active native button uses `aria-pressed="true"`; the other buttons are false. Selecting statistics or a log section hides the complete console panel. Do not implement navigation with anchors, `scrollIntoView()`, or duplicate section DOM.

The statistics panel owns an `aria-live` status, horizontally wrapped table, independent query/visit generations, one refresh controller/promise and one five-minute timer. Entry performs a prompt projection read, one cache-aware quota sweep and a follow-up read; the manual native button forces only the success-cache decision and coalesces while busy. Section changes and `pagehide` abort page ownership, while guarded `pageshow` restores one visible visit without duplicating an active timer. Stale success/catch/finally paths cannot update another visit.

Each quota window labels used and remaining percentages plus an available reset time. Known 0%/100% remain numeric; unconfigured, disabled, unknown, partial, failed and stale/last-known states remain explicit without color alone. The status shows last success/attempt and queued/fetching/due state separately from routing `fresh/unknown`. Viewing or refreshing never enables quota routing, mutates account/raw/bulk drafts, or imports unsaved accounts. Missing/overflowed statistics and zero coverage still render as no data. Account/provider text is escaped, and Keys, proxy/Header/note values, raw traces/messages/sessions, owner state and raw quota responses never render.

Request and error sections share one bounded filter, table, cursor, and clear implementation. The request view is labelled “最终请求结果（每个请求一条）”; the error view is labelled “上游失败尝试（同一请求可能多条）” and explicitly warns that attempt count is not failed-request count. `switchSection()` selects the type, updates the visible title/status/description, invalidates pending log reads, and starts a first-page load. `loadLogs()` ignores a response whose query generation or selected type is stale. “Next” sends only the server-provided cursor. Changing a filter or type resets the cursor. Clear captures the selected type before awaiting deletion, requires explicit confirmation naming that type, and reloads only if the same log section is still visible.

Request status renders `status / result` and offers the request-only `result` filter. Historical rows without `result` display `success` for 2xx/3xx or `legacy_failed` otherwise; this fallback does not rewrite or claim to correct historical JSONL. Error status continues to render attempt status/upstream status.

Ordinary request/error views render only projected log fields. Never render raw request/response bodies, Header values, proxy URLs, account notes, or credential-like data in those views. The independently opt-in detailed panel below is the only approved sanitized-body/header display exception.

#### Detailed log panel

`detailsPanel` has its own labelled fifth navigation button and never reuses ordinary `logPanel` state. Show persistent default-off/content/privacy warnings, 5 MiB per-body and seven-day/1 GiB limits, incomplete/crash-recovery guidance, and the actual `authRequired` result; an empty admin key must visibly warn that content is unprotected. The checkbox is disabled until settings load and while an independent settings POST is pending. Failure restores the last confirmed mode without touching account drafts.

The list shows metadata only. `selectDetail(requestId)` loads headers, attempt metadata and body descriptors into `textContent`; `loadDetailBody()` loads one sanitized `text/plain` body into a labelled readonly textarea. Body buttons identify client/attempt request/response, completeness and captured/observed byte counts. Do not automatically load every body on a page. Use escaping/`jsArg()` for button/table HTML and text nodes or textarea `.value` for arbitrary captured content.

Copy uses only `DETAIL_BODY_TEXT` obtained from the authenticated body API, is disabled until loading completes, announces failure and focuses/selects the readonly text as fallback. Clear explicitly names detailed logs and preserves ordinary logs. Filter edits invalidate stale results/cursors and ask for refresh; Next stays disabled during pending/invalidated queries. Draft/navigation ownership is in `state-management.md`.

`test/detailed-log-ui.test.js` executes production-script VM coverage for safe text/copy, settings rollback, stale list/selection/body/clear and filter invalidation, and bulk/raw/account draft preservation. It does not prove browser clipboard permissions, keyboard focus, announcements, responsive layout or visual readability; those remain manual acceptance items.

#### Rendering safety

Every server-controlled value inserted via `innerHTML` passes through `escapeHtml()`; JavaScript string arguments use `jsArg()`. Prefer `textContent` for drawer/status text. Authentication failures continue to show the login overlay rather than rendering partial sensitive state.

### 4. Validation & Error Matrix

| UI condition | Required behavior |
|---|---|
| Drawer Header JSON is malformed | keep drawer open, show error, do not mutate account draft |
| Name/note/number/proxy/Header fails server validation | keep/reload prior server state and show safe error |
| Drawer is dirty and user presses Escape/backdrop/Close | ask before discarding |
| Proxy test on unsaved account | explain that the account must be saved first |
| Scheduling or error-rule preset is cancelled | no account, rule, pipeline, or global field changes |
| Error-rule textarea is invalid during preview | show an error; do not open/apply a stale preset draft |
| Rule preset merge/replace/clear is confirmed | submit the live computed draft through the normal complete API |
| Scheduling preset is confirmed | submit a complete account snapshot without changing pipeline flags |
| Statistics request resolves after section change | ignore it by generation/visibility check |
| Quota refresh resolves after navigation/pagehide or a newer visit starts | Ignore stale success/catch/finally; do not mutate the hidden/new visit or its button |
| Statistics is restored after pagehide | Start one visible visit only when no timer is active; repeated pageshow does nothing |
| Quota data is disabled, partial, failed, stale or missing a reset | Keep explicit last-known/unknown labels and times; never infer zero/freshness |
| Statistics coverage is zero or a field/ratio is `null` | render no data rather than numeric zero |
| Alias row lacks `=` or duplicates an alias | block save and identify the row/alias |
| Top section changes while a log query is pending | invalidate the old query; it must not update hidden or newly selected log state |
| Log filter changes | reset cursor before querying |
| Clear log selected | confirm with the captured type, delete only that type, and reload only if that same section remains visible |
| API returns `401` | show login overlay and reject the operation |
| Detailed settings save fails | Restore confirmed checkbox; keep account/bulk/raw drafts unchanged |
| Detail body missing/expired or read rejected | Announce safe missing state; no stale body/copy content |
| Details filter changes during a read | Invalidate list/selection; reset cursor and disable Next until refreshed |
| Clipboard write fails | Announce failure; select loaded sanitized text for manual copy |
| Narrow viewport | maintain usable controls and horizontal table scrolling |

### 5. Good / Base / Bad Cases

- **Good:** open an account by its original table index after filtering, edit proxy/Header values, save the draft and full list, then reload without losing `id` or `perModel`.
- **Good:** preview “保守防封”, inspect the capacity/rule changes, cancel, and observe an unchanged account snapshot.
- **Good:** merge a rule preset into a live custom status, observe the custom status in “preserved,” then cancel without changing the textarea.
- **Good:** switch rapidly from statistics to request logs, errors, and console; only the current section remains visible and stale responses cannot replace its state.
- **Good:** keyboard entry/manual refresh announces progress and preserves a pending account note, bulk selection and invalid scheduling-rule draft; a 500px viewport scrolls the wide table without document overflow.
- **Base:** a disabled account shows retained quota/time or unknown and is never queried by page refresh.
- **Base:** an old account shows weight 1, priority 100, direct proxy status, and empty note/Header fields.
- **Base:** no log records renders an empty-state row and disables next page.
- **Bad:** rebuild account objects from visible table cells; hidden routes/proxy/Header fields will be erased.
- **Bad:** put raw server JSON into a log `<pre>`; future fields could expose secrets.
- **Bad:** encode preset logic in the backend and UI independently; values will drift.

### 6. Tests Required

`test/ui-contract.test.js` provides static executable checks for:

- 1800px responsive container, table wrappers, and account-name width;
- six bounded scheduling presets plus five live-draft error-rule presets, merge/replace/clear diffs, cancel behavior, and forbidden-field absence;
- labelled modal/drawer semantics, Escape handling, focus return, dirty confirmation, and `aria-live` feedback;
- account snapshot preservation for new hidden fields and all four pipeline booleans;
- five mutually exclusive top sections with one statistics panel, one shared ordinary-log DOM, one independent details panel, explicit active state, and no anchor/scroll shortcut;
- statistics stale-response guards, escaped server text, unknown/known-zero rendering, table wrapping, and forbidden sensitive fields;
- statistics entry/manual/timer coalescing, abort and pageshow restoration ownership; used/remaining/reset plus disabled/partial/error/stale states; draft preservation and routing-independent refresh;
- log query invalidation, filters/pagination, captured-type clear controls, request-only result filtering, safe historical fallback, explicit final-request versus failed-attempt wording, and model-alias batch controls;
- independent detailed settings/privacy/retention/auth warnings, safe metadata/text and on-demand copy/clear controls; production VM tests must verify stale reads, cursor reset and no account-draft mutation.

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
const accountPipeline = {
  quotaPool: pipelineQuotaPool.checked,
  excludeUnhealthy: pipelineExcludeUnhealthy.checked,
  healthSort: pipelineHealthSort.checked,
  sticky: pipelineSticky.checked
};
```

Treat the server snapshot as the complete object owner. A filtered/status table is a projection, not the source of truth. Do not render `Number(value) || 0` for coverage-sensitive statistics; test coverage first and preserve the difference between unknown and known zero.
