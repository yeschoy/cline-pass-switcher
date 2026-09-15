# Account Draft Flow Evidence

Baseline: branch `main`, HEAD `dd3cfc0`; inspected during planning. No application changes or tests have been run for this task.

## Existing owners and call sites

- `public/index.html:442-456`: `loadAll()` obtains models/accounts/security/meta/aliases, assigns `ACCS = accs`, then calls `render()` and `renderAccounts()`. This is the existing server-snapshot hydration boundary.
- `public/index.html:745-748`: `renderAccounts()` also resets mode, wait, error-rule text, and the four pipeline checkboxes from `ACCS`. This is not merely rendering.
- Callers include search (`public/index.html:173`), initial/reload hydration (`:453`), add (`:762`), delete (`:763`), and drawer apply (`:768`). A bulk redraw or raw-edit redraw would therefore erase unsaved scheduling controls unless this shared reset is removed from the rendering path.
- `public/index.html:749-757`: filtering projects `{a, i}` from the complete array; the row radio changes `ACCS.active`, and enabled checkboxes change the account object. The radio is not a batch-selection control.
- `public/index.html:759`: `collectAccounts()` preserves `id`, `name`, `note`, `key`, `enabled`, `maxConcurrent`, `weight`, `priority`, `proxyUrl`, `headers`, and `perModel`; it reads live mode/pipeline controls but not wait/rules.
- `public/index.html:760`: `saveAccounts(payload)` fills wait from the live DOM and rules from the live textarea unless rules already exist in the supplied payload; success reloads all state. Existing presets depend on this shape (`:771-778`). A raw draft can avoid changing this API by applying validated scheduling values to the existing controls rather than calling `saveAccounts(payload)`.
- `public/index.html:766-768`: drawer applies to the page draft, explicitly requiring the account save afterward. `accMsg` feedback currently disappears after eight seconds (`:818-824`), so the new bulk/raw controls should keep persistent explanatory draft-only text.

## Server boundary

- `server.js:206-223`: accounts carry stable IDs; names are display values, not stable keys. New local rows do not yet have IDs.
- `server.js:1995-2003`: GET accounts adds runtime/health/quota fields to persisted configuration.
- `server.js:2004-2052`: POST is a destructive full-list save. It validates account IDs and concurrency (integer 0–100000), mode, wait (integer 0–30000), rules, pipeline, and hidden account fields before replacing the account list. `maxConcurrent: 0` means unlimited (`.trellis/spec/backend/quality-guidelines.md`).
- `server.js:224-252`: error-rule and pipeline validators remain authoritative. The raw UI must reject invalid draft input before applying it but must not introduce a bypass of the normal server validation.
- Duplicate names must never retarget a mutation: only the selected existing account object/stable ID is authoritative. Raw editor names are reference labels, not identifiers to write back.

## Minimal reuse recommendations

1. Move snapshot-to-scheduling-control initialization into `loadAll()` once per actual reload. Keep `renderAccounts()` a projection of existing draft state. Read live mode for the active-radio projection and redraw on mode changes; do not reset the active selection.
2. Keep `ACCS.accounts` plus existing DOM scheduling controls as draft owners; do not add a second general-purpose store, new dependencies, or a new bulk save API.
3. Batch selection can hold current account object references in a transient `Set`. Clear on search changes/reload; prune removed or now-hidden rows on redraw. Never use name or Key as identity.
4. Raw JSON applies only to scheduling controls after complete validation. Include only reference account names; preserve account objects, active index, and model routes untouched.
5. Keep existing preset confirm-and-save behavior. Do not silently convert older presets into the new draft-only interaction.

## Runnable verification opportunities

- `test/ui-contract.test.js:1-103` reads the production HTML but currently has static assertions only. Add actual execution of production embedded JavaScript with Node's `vm` and small DOM/network stubs for selection, application, no persistence, and draft preservation. The script can be loaded as-is with an inert pending startup fetch and stubbed DOM listeners (`public/index.html:271-300`, `:829-841`); do not copy the production logic into tests.
- Existing API fixtures: `test/integration.test.js:73-113` (isolated `DATA_DIR`, mock server, `rawJson`), `:688-733` (hidden account fields, invalid-save byte preservation), and `:835-839` (pipeline rejection/preservation).
- Planned commands: `node --test test/ui-contract.test.js test/account-draft.test.js`, `node --test test/integration.test.js`, `npm test`, embedded-script `new vm.Script(...)` syntax check, `git diff --check`.
- Browser verification remains separate: keyboard selection, select-all indeterminate state, dirty dialog cancellation/focus return, narrow tables, and actual copy behavior are not proved by a DOM stub.
