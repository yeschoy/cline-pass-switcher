# Model / provider statistics — implementation checklist (planning)

- [ ] Trace commitStatistics/finalizer/usage normalization, attempt attribution, provider health, quota reference price source, `/api/statistics`, all UI navigation callers and existing VM/integration contracts.
- [ ] Add bounded per-provider successful usage cells inside existing statistics owner with migration and coverage; distinguish model request vs per-attempt health success rate and unknown attribution.
- [ ] Add versioned official ClinePass reference pricing with source/date, explicit applicable token fields, fixed-point arithmetic/overflow checks; dynamic peak/context/unsupported cached-write cases remain unpriced unless reliable inputs exist. Cost is reference valuation, never actual bill.
- [ ] Project safe bounded model/provider rows in existing management API. Add top-nav page after detailed logs; preserve drafts, stale-response ownership, accessibility, HTML escaping and responsive table scrolling.
- [ ] Test retries/failover without double count, stream usage missing/known 0, cache read pair, unsupported cached-write, auto provider, aliases, price changes, persistence migration, partial coverage, UI VM and real browser interaction.
- [ ] Run focused integration+UI tests, full gate; update official reference source/date in docs and changed spec contracts. No live paid upstream or production data.
