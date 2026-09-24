# Execution plan (after review/start)

- [ ] Add UI fixture tests for tab, success sample format, missing vs zero, unknown Provider, frozen price detail and stale async responses.
- [ ] Replace long introductory paragraphs and mixed table with two child views; reuse accepted statistics snapshot and existing `api()`. Add accessible concise disclosure/row details and a short cost caveat.
- [ ] Inspect account draft/nav ownership; test keyboard focus/return, announcements and 390px scrolling in a real browser with synthetic local statistics, not production.
- [ ] Run `node --test test/ui-contract.test.js test/account-draft.test.js test/detailed-log-ui.test.js` then integration if API changed; production inline VM compile, Node checks, env-scrubbed `npm test`, `git diff --check`; update frontend spec if UI contract changes; review/commit.

Rollback: no persistence change; restore only this view without touching the price history or other browser drafts.
