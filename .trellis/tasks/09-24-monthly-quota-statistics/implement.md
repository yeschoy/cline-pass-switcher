# Monthly quota statistics — implementation checklist (planning)

- [ ] Trace quota parse/validation, `/api/statistics`, account projection, statistics visit refresh and UI forecast tests.
- [ ] Implement labelled per-window reference remaining and separate monthly vs immediate totals, using validated snapshot and generatedAt without changing the quota-job or account-routing owner.
- [ ] Test two unequal windows, multiple accounts, known 0/100, missing/partial/stale/disabled, reset before/inside/after forecast and aggregate round-trip; UI VM/static and real narrow-browser evidence.
- [ ] Keep README/spec language explicit: $10/$25/$50 are community estimates for matching plan, not official balance; full relevant and project gates before approval to start.
