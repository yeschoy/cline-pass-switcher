# Raw Scheduling Editor Design

## Boundary and Reuse

Depends on the completed bulk-concurrency child. Read `../09-14-bulk-account-concurrency/research/account-draft-flow.md` and re-check current source after that child lands.

Keep application changes in `public/index.html` plus focused tests. No new dependency, backend endpoint, general draft store, or account serializer. `ACCS.accounts` and existing scheduling controls remain authoritative; `loadAll()` alone hydrates controls after server reload, while `renderAccounts()` preserves drafts.

## Visible JSON Contract

Add “查看/编辑原始配置” near the scheduling pipeline. Use the persisted scheduling field name `accountMode` in the displayed JSON, mapping to the existing `accMode` select. The complete editor object is:

```json
{
  "accountMode": "sticky",
  "concurrencyWaitMs": 2000,
  "accountErrorRules": {"429": {"action": "cooldown", "cooldownMs": 1800000}},
  "accountPipeline": {
    "quotaPool": false,
    "excludeUnhealthy": false,
    "healthSort": false,
    "sticky": false
  },
  "accountNames": ["Account A", "Account B"]
}
```

These are illustrative values, not replacement defaults. Opening reads current controls and all current account names, independent of the account search filter. Explain that policy is global to the pool, names are reference-only, and runtime eligibility/health/capacity can affect actual selection. Preserve `ACCS.active`; its identity is not edited through this JSON.

`accountNames` is an ordered array of names, not a map. Keep duplicates and unsaved accounts visible. Require the reference array to match the opening/current draft; changing it produces an error rather than renaming, reordering, or targeting accounts. Do not include IDs, Keys, notes, proxies, custom headers, per-account parameters, runtime statistics, or `perModel` in the JSON.

## Open, Apply, and Close

1. Before opening, parse the live error-rule textarea and read the live mode/wait/pipeline. Invalid existing text/numeric input reports an error and remains untouched; never fall back to `{}` or a normalized default.
2. Create an editor-only text snapshot and record the originating `ACCS` object plus live scheduling-control values. Open a labelled native `<dialog>` using `showModal()` so the browser supplies modal focus containment; style it consistently with existing dark UI.
3. Applying parses JSON and validates the whole object before writing controls. Check that the underlying `ACCS` reference and originating scheduling values have not changed while the editor was open. A reload/stale editor must retain editable text and report the need to reopen, not overwrite a newer snapshot.
4. After validation, assign only mode/wait/rules/pipeline controls, redraw the account table using the preceding child's draft-preserving path, and report “草稿已更新，尚未生效；请保存账号配置”. No API call, full account serialization, or automatic reload occurs.
5. Close/Cancel/Escape confirms only when editor text differs from its opening snapshot; cancellation never applies partial values. After application or confirmed close, restore focus to the opener. Existing page draft remains unchanged on cancellation.
6. The ordinary save button remains the sole persistence action. Since values were written into live controls, existing `saveAccounts()` already reads the intended wait/rules/pipeline. Existing preset behavior is preserved.

## Validation Contract

Use one small raw-draft validator beside this editor; do not build a schema framework or clone backend normalization. The existing backend remains the final trust boundary. Browser validation is stricter about actual JSON number/boolean types, not a replacement server validator.

| Field | Local acceptance |
|---|---|
| Root | Non-null non-array object with exactly the five documented own keys |
| `accountMode` | One of the current six select values; no unknown mode |
| `concurrencyWaitMs` | JSON number, finite integer 0–30000 |
| `accountPipeline` | Exactly `quotaPool`, `excludeUnhealthy`, `healthSort`, `sticky`; all booleans |
| `accountErrorRules` | Non-null non-array object; numeric HTTP status keys in the backend domain 100–599 |
| Each rule | Object with `action` equal to `ignore`, `cooldown`, or `ban`; no unsupported rule fields |
| Cooldown | JSON number, safe integer 1–2592000000 ms; required only for `cooldown` |
| `accountNames` | Array of strings exactly matching the opening and current reference list |

Reject unknown top-level/pipeline/rule fields, including prototype-like keys, instead of spreading arbitrary parsed objects into live state. Do not coerce string/null/boolean numeric values or clamp range failures. Preserve valid custom error statuses; the existing preset limitation to 429 among 4xx does not prohibit custom manual rules.

## State/Integration Matrix

- Pending bulk concurrency -> open/apply raw -> ordinary save: both intended changes persist, other fields remain equal.
- Pending scheduling controls -> account search/drawer/bulk redraw -> raw open: raw JSON reflects the pending values.
- Temporarily invalid rule JSON -> bulk/search redraw: text survives; raw open reports the problem without replacement.
- Raw invalid/dirty cancel -> no page mutation and no persistence calls.
- Account rename/reload while editor is open -> stale error; no name-based reassignment.
- Existing scheduling/error preset confirm -> unchanged ordinary confirm-and-save path.

## Verification and Rollback

Extend `test/account-draft.test.js` to execute the actual production editor functions with DOM/dialog/network stubs, and use `test/ui-contract.test.js` for structural accessibility markers. Add a complete account/scheduling API round-trip fixture only if existing integration coverage is insufficient.

Manual browser review covers modal keyboard/focus behavior, dirty cancellation, full names, and narrow scrolling. Do not describe VM/static checks as browser automation. Rollback only the reviewed raw-editor diff; retain the preceding bulk child and all unrelated planning/configuration files.
