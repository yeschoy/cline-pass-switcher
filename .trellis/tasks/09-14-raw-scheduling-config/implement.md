# Raw Scheduling Editor Implementation Plan

## Activation and Dependency Gate

- [x] User approved PRD/design/plan; both JSONL manifests validate.
- [x] `09-14-bulk-account-concurrency` passed its quality gate and supplied shared draft-preserving behavior plus the executable UI harness.
- [x] Current source was re-read; implementation/check writers ran sequentially.
- [x] The parent activated this child after approval; dispatches used its exact active-task path.

## Ordered Work

1. [ ] Extend production-script draft tests first: raw view from live controls, exact field scope, labels only, no API calls, atomic invalid-input rejection, stale source and cancel behavior.
2. [x] Add the raw-editor entry and labelled native dialog. Preserve opener focus, dirty text, and accessible feedback.
3. [x] Construct the documented five-field JSON from current draft controls and full account names. Invalid existing rule text or numeric values must survive a failed open unchanged.
4. [x] Validate the whole object using current server domains and strict JSON types. Reject unsupported fields, partial pipeline, changed reference names, and stale snapshots before any mutation.
5. [x] Apply scheduling fields to existing controls only. Reuse the bulk child's rendering behavior and the existing explicit account-save path; do not add a save endpoint or second draft owner.
6. [x] Test combined bulk/raw/account changes and existing preset round trips. Confirm hidden account fields, active identity, per-model routes, and unsaved text survive.
7. [x] Full-scope quality checks, exact-diff independent review and parent browser acceptance passed; handoff to detailed logging is authorized.

## Required Verification

```bash
node --test test/ui-contract.test.js test/account-draft.test.js
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node --test test/integration.test.js
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

Check-stage evidence (revision 2 independently rechecked): focused tests passed 19/19; full suite (including integration) passed 42/42 with credential/base overrides cleared; embedded script and server syntax passed; scoped diff whitespace check passed. Both JSONL manifests parse and referenced paths exist. Frontend state/quality specs now record the verified raw-editor contract, including successful-save feedback clearing while retaining open editor text for stale rejection. Integration uses temporary `DATA_DIR` and local mocks. Test-first ordering was not independently verified, so item 1 remains unchecked. Parent subsequently completed the real-browser SC6 gate below; VM/static tests alone were not used for that acceptance. Item 1 remains unchecked solely because original test-first chronology was not verified, not because executable coverage is missing.

Acceptance matrix:

- SC1: exact JSON projection from pending controls; no credentials/routes; names include duplicates/new rows.
- SC2: local apply, zero writes until ordinary save, combined bulk/raw/account full round trip.
- SC3: malformed/root-array/missing/unknown fields, all invalid mode/wait/rule/pipeline domains, string/boolean/null numbers, changed names, stale snapshot; assert deep equality and zero persistence.
- SC4: invalid live rules and pending edits survive failed open, cancel, search, and redraw.
- SC5: filtered/duplicate/unsaved/renamed/deleted accounts cannot be reassigned through labels.
- SC6: static labels/live feedback plus manual keyboard/focus/discard and responsive browser review.

## Handoff, Spec Update, and Rollback

Expected application paths: `public/index.html`, `test/account-draft.test.js`, `test/ui-contract.test.js`, and narrowly targeted integration assertions if necessary. Record the verified raw/draft contract in frontend specs during the required finish phase; no speculative spec rewrites during planning.

The logging child must not change the new draft owners or submit/reload account drafts when toggling diagnostics. Parent integration checks all four approved features together.

On failure, preserve partial work and report evidence. Revert only this reviewed child diff if requested; do not remove the bulk child, rewrite live `config.json`, or reset untracked planning artifacts.

## Parent Acceptance Evidence

Parent accepts SC1–SC6 after revision 2. Fresh full suite passed 42/42 (`/tmp/cps-raw-parent-final.log`); source/spec exact diff is `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-implementation-baseline-mylegn65/raw-review-2.diff`. The stale unsaved-feedback defect was fixed by one hydration line and a red/green production save/load regression. Seventy protected files remain unchanged, staging is empty and scoped whitespace/syntax checks pass.

Real isolated Chrome 152, local fixture APIs and blocked external page requests verified keyboard open/apply/cancel/Escape, actual dirty-confirm decline/accept, opener focus return, native modality preventing underlying-control focus, exact duplicate/unsaved-name projection, invalid/stale atomic no-ops, pending bulk/account preservation, one explicit complete save and obsolete feedback removal. Parent inspected 1800px/500px screenshots; narrow dialog/textarea remained within viewport without horizontal text overflow. Report/screenshots: `/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-raw-browser-evidence-3tCLqn/`. HTML SHA256: `b08e07f1e4a95ce0accc2fb9d2ae653b06343fe6a97ce19aca8b05299d34de1c`.

The Tab sequence includes a neutral BODY transition also reproduced in a minimal native-dialog page with no application JS/CSS (`/var/folders/h7/1s08hdn51x778k3dtg4ytt140000gn/T/cps-native-dialog-control-1ldL5W/focus.json`). Underlying inputs remained inert, so no custom focus trap/application change was introduced for that browser-native behavior. No screen-reader audio test, commit, push or archive is claimed. The parent authorizes the next logging-child activation.

## Final Four-Feature Integration Record

The 2026-09-14 parent integration gate initially re-ran the production-script UI/draft suite at 27/27, full integration at 44/44 and full suite at 127/127. A later detailed-log-only security correction produced final integration 45/45 and full suite 129/129; no raw-editor code or test changed. SC1–SC6 remain satisfied through bulk, detailed-log and statistics navigation: the exact five-field editor still projects the one live draft owner, stale/invalid/cancel paths remain atomic, and the ordinary explicit save preserves account identity/hidden fields plus combined raw/bulk changes. The Chrome 152 raw report and declared screenshots were re-read; the native-dialog BODY transition and lack of screen-reader-audio testing remain disclosed. The index remained empty.
