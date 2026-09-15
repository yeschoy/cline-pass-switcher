# Bulk Account Concurrency Settings

## Goal

Implement parent requirement **R3** in `../09-14-diagnostics-routing-config/prd.md`: set a common concurrency limit on explicitly selected accounts without editing each account individually.

## Background and Evidence

- The account drawer already updates `maxConcurrent` in a local draft (`public/index.html:766-768`).
- Name/note search projects the full account list; no batch selector exists. The existing radio selects the active account (`public/index.html:173`, `public/index.html:745-757`).
- `collectAccounts()` preserves all persisted account fields (`public/index.html:759`), while `POST /api/accounts` destructively replaces the full list and validates `maxConcurrent` as an integer in 0–100000 (`server.js:2004-2052`). Zero means unlimited.
- A preset can set every account to concurrency 1, but cannot provide arbitrary bulk editing (`public/index.html:771-774`).
- `renderAccounts()` resets scheduling controls from `ACCS` (`public/index.html:745-748`); the shared rendering path must stop erasing pending scheduling edits when a new bulk action redraws the table.

## Confirmed Requirements

- **B1 — Targets:** Independent multi-selection checkboxes, plus “select all current search results.” The existing active-account radio is unaffected. Display the affected account names and count before application.
- **B2 — Assignment:** Assign one common concurrency value only to selected accounts. Accept integers 0–100000; reject empty, fractional, negative, excessive, and non-finite input before changing any account. Do not clamp invalid input.
- **B3 — Draft/save:** Apply locally without a persistence request. Preserve other pending account/scheduling edits; the existing “保存账号配置” button explicitly persists the combined draft. Clearly state that draft updates are not effective on the server yet.
- **B4 — Preservation:** Modify only targeted `maxConcurrent`. Preserve IDs, names, enabled state, credentials, notes, proxies, headers, per-model routes, weights, priority, active account, and global scheduling fields. Unselected accounts remain unchanged.
- **B5 — Selection lifetime:** Changing search conditions clears selection without discarding any draft edits. The user accepted that selections cannot accumulate across different searches. Hidden/removed accounts must not become unexpected targets.
- **B6 — Accessibility:** Native keyboard-operable controls, labelled row/select-all inputs, safe empty-selection behavior, and announced validation/draft feedback.

## Acceptance Criteria

- **BC1 / B1, B2, B4:** One operation gives exactly the explicitly selected accounts the same value; names/count match the targets, other fields and accounts are deeply unchanged.
- **BC2 / B1, B5:** Select-all touches only current matches; changing the filter clears selection but not drafts, and the active radio is independent.
- **BC3 / B2, B6:** Invalid input or empty selection produces no mutation or persistence request; 0 and 100000 are valid boundaries.
- **BC4 / B3, B4:** Applying sends no persistence request and survives table redraw without losing pending account/scheduling edits. Explicit account save round-trips the combined intended draft through the ordinary API.
- **BC5 / B5, B6:** Duplicate names, unsaved accounts, deletion, reload, keyboard selection, and filtered empty state cannot retarget a bulk operation.

## Dependencies and Scope

This is the first implementation child. It owns the minimal shared rendering/hydration fix needed to preserve scheduling drafts. The raw-editor child follows sequentially and reuses that behavior; parent integration must check both features together. Detailed logging is functionally independent but will be implemented afterward to avoid concurrent edits of the shared console/tests.

No bulk key, weight, priority, proxy, enablement, or model-route editing. No new bulk persistence API or scheduling algorithm. Preserve existing presets' explicit confirm-and-save behavior.

The user approved implementation with “开始”; this first child is activated (`in_progress`). Preserve the reviewed scope and obtain the quality/parent handoff before activating the next child.
