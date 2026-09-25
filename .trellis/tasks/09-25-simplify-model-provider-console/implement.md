# Execution plan (after review/start)

- [x] VM/static tests cover separate success denominators, failed retry and unknown Provider attribution, known zero versus missing usage, frozen v1/v2 price detail, stale reads and unchanged account drafts.
- [x] Two child views share the accepted `/api/statistics` snapshot; model is default, channel view shows final-success-attributed usage. Compact rows and native details retain coverage, historic prices, source, and non-billing caveats. Inactive table rows are removed from the DOM, not kept hidden.
- [x] Local Chromium 145 at 390px verified keyboard/focus/Enter/details, both horizontal scroll regions, live status text, filter and no-refetch child switching. Two 200-model × 10-channel synthetic runs plus two post-review runs measured default 200 versus explicit channel 2,000 rows (`research/browser-results.md`); not a production-capacity or screen-reader claim.
- [x] Final independent review found no blocking issue; focused 58/58, env-scrubbed full gate 300/300, Node/inline script/Python syntax checks and `git diff --check` passed. Frontend English specs updated. Work commit/archival follow this accepted check; no server API, persistence, production or paid upstream change.

Rollback: no persistence change; restore only this view without touching the price history or other browser drafts.
