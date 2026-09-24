# Quota exhaustion protection — implementation checklist (planning)

- [ ] Trace error normalization, retry/rule ordering, enabledAccounts/lease admission, quota job owner/dedupe/backoff, persisted dispositions and `/api/accounts/recover` callers; reconcile with any intervening commits.
- [ ] Define strict configurable global reference threshold (default $0.20), safe state normalization and migration, manual recovery UX/API; no new quota scheduler/transport.
- [ ] Implement status+content signal → request-local bounded pause → same-owner forced quota refresh → post-signal fresh-monthly AND check → durable manual-release ban; fail/unknown retains no permanent ban and temporary hold expires safely.
- [ ] Implement independent short-window temporary states with multi-window gating; reset time only schedules recheck and release requires successful fresh complete three-window proof with no monthly ban.
- [ ] Test full AND truth table, default/custom/equality boundary, stale/failure/unknown, duplicate concurrent failures, one account vs another, 5h available+week exhausted, multiple reset times, month manual-ban priority, restart, manual release, key/proxy edits, pre/post SSE, original upstream status and ordinary log safety.
- [ ] Focus integration/UI tests, full gate and spec/operator docs; do not perform live quota requests or deployment without separate authorization.
