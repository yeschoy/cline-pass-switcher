# Bulk Concurrency Design

## Boundary and Order

First implementation child of the parent task. Application changes should be limited to `public/index.html` plus focused tests. No server API/schema changes are needed. Source evidence: `research/account-draft-flow.md`.

This child owns the shared draft-preserving rendering fix. The raw scheduling editor must land after it and reuse the resulting behavior; do not build two draft stores.

## Draft Ownership

Keep the existing owners:

- `ACCS.accounts`: complete account draft objects, including hidden fields.
- Existing mode/wait/rules/pipeline DOM controls: scheduling draft.
- `ACCS.active`: active account index, unrelated to batch selection.

Move scheduling-control initialization out of `renderAccounts()` into the existing `loadAll()` hydration boundary. Do not parse or normalize error-rule JSON during an ordinary table redraw: even temporarily invalid text must survive search, drawer apply, and bulk application. Render the radio using live mode rather than stale `ACCS.mode`; mode changes redraw without resetting `ACCS.active`.

All callers (load, search, add, delete, drawer apply, bulk apply) use this same rendering behavior. Existing `collectAccounts()`/`saveAccounts()` retain their payload and explicit-save responsibilities. Avoid collecting/serializing all accounts just to apply one bulk value.

## Interaction and Selection

Add one labelled selection column and a small bulk toolbar in the account card:

- Native row checkboxes separate from both the active radio and enabled checkbox.
- “Select all current search results” with checked/indeterminate/disabled state derived from visible rows; deselection affects only these rows.
- Integer input, `min=0`, `max=100000`, `step=1`; explain `0 = unlimited`.
- A persistent names/count summary and draft-only explanation; an apply button disabled for no targets.

Use a transient `Set` of current account object references. Names and current filtered indexes are not identities; unsaved rows without IDs remain selectable. Rendering retains original row indexes for existing drawer/radio handlers.

Selection transitions:

| Event | Selection | Draft |
|---|---|---|
| Row/select-all toggle | Update intended visible objects | Unchanged |
| Search condition changes | Clear | Preserve all fields, including invalid temporary rule text |
| Bulk apply | Retain currently visible targets | Update only their `maxConcurrent` |
| Redraw after rename/note edit | Prune removed/hidden targets | Preserve |
| Delete | Prune deleted target; never transfer it by index | Existing delete behavior |
| Add | New row starts unselected | Existing add behavior |
| Successful save/reload | Clear old object references | Hydrate server snapshot |

At apply time, derive targets again from the intersection of selection, current account objects, and current matches. Displayed names/count must use this same target set. Do not silently include a target hidden since the last render.

## Atomic Local Application

Read and trim the input; require non-empty, finite integer 0–100000 using strict numeric checks (not `parseInt` or `Number(value) || 0`). Validate the entire target set and value before the mutation loop. An empty selection or invalid value changes nothing.

Then set only `account.maxConcurrent = value` on target objects, redraw the table, and announce “草稿已更新，尚未生效；请保存账号配置”. No `api()`, `fetch()`, `saveAccounts()`, or `loadAll()` call is allowed from apply/search/selection.

The ordinary explicit save remains server-validated. API errors leave the page draft available for correction; do not claim server activation merely because the local operation succeeded.

## Accessibility and Display

Use native inputs/buttons, full account names escaped in the summary/labels, and a bounded scrolling names area when necessary. Keep wide tables in the existing scroll wrapper. Expose select-all's mixed state with native `indeterminate`, and use `aria-live` for errors and draft updates. Do not rely on color or the existing eight-second message alone to explain save semantics.

## Validation and Rollback

Extend static UI contracts only for necessary new structure, and add executable production-script tests in `test/account-draft.test.js` using Node `vm` plus minimal DOM/network stubs; do not duplicate the bulk implementation inside the tests.

Test a full account fixture with hidden fields, selected/unselected/filtered accounts, new rows, duplicate names, pending mode/wait/rules/pipeline edits, invalid temporary JSON, and active radio. Assert exact changes and zero persistence calls before explicit save. Reuse integration fixtures for the ordinary full-list round trip.

Manual browser checks cover keyboard/indeterminate selection and narrow widths; VM tests are not browser automation. If validation fails, fix this child before starting the raw editor. Rollback removes only this child's reviewed application diff; never reset unrelated untracked planning files or persisted account configuration.
