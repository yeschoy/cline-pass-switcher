# View and Edit Raw Scheduling Configuration

## Goal

Implement parent requirement **R2** in `../09-14-diagnostics-routing-config/prd.md`: inspect and directly edit scheduling policy while understanding which accounts the policy concerns.

## Background and Evidence

- The screenshot maps to error-rule JSON/presets and four pipeline switches (`public/index.html:182-187`); mode and capacity wait are in the same card (`public/index.html:162-175`).
- `GET /api/accounts` exposes accounts plus mode, active index, wait, rules, and pipeline (`server.js:1995-2003`). Its full-list POST validates and replaces accounts (`server.js:2004-2052`); unrelated hidden account data must survive.
- `collectAccounts()` mixes account objects and DOM state; `saveAccounts(payload)` takes wait from the DOM (`public/index.html:759-760`). Passing a raw object directly into save is not an independent raw-configuration API.
- Search redraw currently resets scheduling controls (`public/index.html:173`, `public/index.html:745-748`). The preceding bulk-concurrency child owns the shared hydration/rendering correction.
- `accountPipeline` is an exact four-boolean object (`.trellis/spec/frontend/state-management.md`).

## Confirmed Requirements

- **S1 — Scope:** Show/edit scheduling mode, capacity wait, account error rules, and the four pipeline switches. Include corresponding account names for reference, as requested (“包含对应的账号名字就行”). Do not expose credentials or introduce account-parameter/model-route editing here.
- **S2 — Source:** Opening the raw editor shows the current page draft, not a fresh server snapshot. Clearly identify draft state rather than claiming it is already effective configuration.
- **S3 — Local apply:** Validate the whole JSON object and all supported fields before applying any change. Application updates the existing visual controls locally without a persistence request; explicit “保存账号配置” persists the combined draft.
- **S4 — Preservation:** Opening, cancelling, failed validation, and table redraw preserve unrelated account/scheduling drafts. Changing raw scheduling policy must not rename, reorder, add/delete, select, or otherwise modify accounts, including the active account and per-model routes.
- **S5 — Invalid/stale input:** Malformed JSON, missing/unsupported fields, invalid values, modified account-name references, or a stale editor cannot partially apply or overwrite a newer draft. Do not silently normalize invalid input into a different policy.
- **S6 — Accessibility:** Native keyboard-operable editor controls, labelled JSON input, readable full account names, announced validation/save feedback, and confirmation before discarding dirty editor text.

## Acceptance Criteria

- **SC1 / S1, S2:** Opening displays current mode/wait/rules/pipeline and corresponding names, excludes account credentials/proxies/headers/routes, and sends no persistence request.
- **SC2 / S3, S4:** Valid JSON changes exactly the scheduling controls. Explicit ordinary save round-trips those values with every account field, active identity, and pending bulk-concurrency change intact.
- **SC3 / S3, S5:** Invalid or stale input changes neither page draft nor persisted configuration; errors identify the offending field safely.
- **SC4 / S2, S4:** Existing invalid error-rule text is not replaced with `{}` when opening fails. Open/cancel/filter/redraw cannot erase other pending edits.
- **SC5 / S1, S4:** Duplicate names and unsaved accounts are safe reference labels, never identities used to update accounts. Modified labels cannot rename/reassign accounts.
- **SC6 / S6:** Keyboard open/apply/cancel/Escape, dirty-discard confirmation, focus return, and narrow-width reading remain usable.

## Dependencies and Scope

Implement after `09-14-bulk-account-concurrency` passes its quality gate. Reuse its draft-preserving `loadAll()`/`renderAccounts()` boundary and executable draft tests; do not introduce another state owner. This is an explicit implementation dependency, not a dependency inferred from the parent tree.

Detailed logging follows this child to avoid concurrent edits of `public/index.html` and tests. The parent owns cross-feature integration acceptance.

No new scheduling algorithm, generic configuration-file editor, credential editor, per-account raw editor, or new persistence endpoint. Existing presets retain their explicit confirm-and-save behavior.

The user approved this plan for implementation with “开始”. This child remains planning until the preceding bulk-concurrency gate passes and the parent activates it.
