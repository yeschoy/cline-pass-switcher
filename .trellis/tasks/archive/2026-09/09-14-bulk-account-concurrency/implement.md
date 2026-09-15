# Bulk Concurrency Implementation Plan

## Activation Gate

- [x] User reviews PRD/design/plan and approves implementation with “开始”.
- [x] Both context manifests validate; current branch, task and pre-existing changes are verified.
- [x] This child is activated (`in_progress`). Every implementation/check dispatch starts with `Active task: <task.py current path>`.

## Ordered Work

1. [x] Re-read the shared flow in `research/account-draft-flow.md` and all `renderAccounts()`/`collectAccounts()`/`saveAccounts()` callers.
2. [x] Add executable draft-regression fixtures using the actual embedded script and Node `vm`; add static accessibility markers to the existing UI contract suite. No frontend dependency is required.
3. [x] Move snapshot-to-scheduling-control initialization to `loadAll()`; make table redraw preserve live draft state and live mode/radio behavior. Keep existing presets unchanged.
4. [x] Add independent selection controls, current-match select-all, transient selection lifetime, names/count summary, and strict common-value input.
5. [x] Apply only selected `maxConcurrent` locally after complete validation; show persistent draft-only guidance.
6. [x] Verify ordinary full-list API save preserves every hidden account field, active identity, and scheduling draft.
7. [x] Run a fresh quality check, review the full diff, and correct failures before handing off to the raw-editor child.

## Required Verification

```bash
node --test test/ui-contract.test.js test/account-draft.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node --test test/integration.test.js
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

The new test file is a planned deliverable; these commands are not claimed to have passed during planning. Integration uses temporary `DATA_DIR` and local mocks; inherited credential/base overrides are cleared to avoid exposing real credentials in fixtures.

Acceptance matrix: BC1 exact target-only deep comparison; BC2 search/select-all/active independence; BC3 empty/fractional/negative/NaN/infinite/100001 rejection and 0/100000 acceptance; BC4 no API calls on apply and combined explicit-save round trip; BC5 duplicate names, unsaved rows, rename/deletion/reload, keyboard and empty-state safety.

Browser checklist: keyboard-only row/select-all operation, mixed checkbox state, stable focus after applying, full names visible, 1800px desktop and <600px horizontal scrolling, account/rules edits preserved through search and bulk redraw.

## Handoff and Rollback

Expected application files: `public/index.html`, `test/ui-contract.test.js`, `test/account-draft.test.js`, and narrowly targeted `test/integration.test.js` assertions if coverage is missing. Update frontend draft/selection specs only for the verified contract during the required spec-update phase.

Do not start `09-14-raw-scheduling-config` until this child passes its gate. Hand off the shared hydration/rendering contract and runnable draft harness. Detailed logging must not write the shared console concurrently.

If blocked, preserve the partial diff and report exact failures; do not commit, archive, delete data, or reset unrelated work automatically.

## Independent Check Evidence

- Reviewed the complete child application diff and curated contracts; strengthened the production-script regression to apply a real pending drawer-note edit before bulk/search redraw. No application-code fix was needed.
- Fresh focused suite: 11/11; full suite: 34/34; integration suite: 20/20. Embedded-script compilation, server syntax, scoped whitespace check, protected fingerprints, and empty staging index passed. Raw review logs: `/tmp/cps-bulk-check-full.log`, `/tmp/cps-bulk-check-integration.log`.
- Updated frontend state/quality specs with verified hydration, selection, validation, and draft-only contracts.
- Parent browser gate passed on real isolated Chrome 152 with the production HTML (SHA256 `65ba11bada18d59857a723e7485816a87f82231db9d9bfd18825c0ac28202b9c`) and local fixture-only APIs; external page requests were blocked. Space/Tab/Enter selection/application, mixed checkbox state, focus stability, filtered select-all/search-clear, 0/100000 bounds, disabled-account preservation, real drawer-note edits, invalid rule-text preservation, zero implicit saves, and one explicit complete save/reload passed. Parent visually inspected 1800px and 500px screenshots; the 500px document width was 485px with a 435px horizontally scrolling account wrapper. This is real-browser interaction evidence plus screenshot inspection, not a claim of screen-reader audio testing.
- Browser evidence: `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-bulk-browser-evidence-pZahdS/report.json` and sibling `desktop.png`/`narrow.png`. Initial browser-driver Enter attempts produced no click; correcting CDP character/native-key parameters resolved them without any application edit or source-hash change.
- Read-only exact-diff reviewer found no code issue. Parent rechecked 70 protected fingerprints, unchanged backend, empty staging and scoped whitespace. The earlier isolated quota timing failure remains unexplained and disclosed; subsequent implementation/check/full/runtime gates passed without changing that assertion.
- Parent accepts this child's BC1–BC5 gate and authorizes activation of the raw-scheduling child. No commit, push or archive has occurred.

## Final Four-Feature Integration Record

The 2026-09-14 parent integration gate initially re-ran the production-script UI/draft suite at 27/27, full integration at 44/44 and full suite at 127/127. A later detailed-log-only security correction produced final integration 45/45 and full suite 129/129; no bulk code or test changed. BC1–BC5 remain satisfied inside the shared four-feature navigation/save flow: object-identity selection and strict bounds remain draft-only, pending invalid scheduling text survives redraw/navigation, and one explicit account save preserves active identity plus every hidden field. The Chrome 152 bulk report and declared desktop/narrow screenshots were re-read and remain valid; no screen-reader-audio claim is added. The index remained empty.
