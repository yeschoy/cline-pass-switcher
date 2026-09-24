# Execution plan (after review/start)

- [ ] Review prior performance evidence and code owners, choose bounded fixture and profiling instrumentation; avoid any production data.
- [ ] Establish local warm/cold baseline at aggregate 300 RPM across >2 rolling windows, bounded burst/short/slow/SSE/logging variants. Persist commands, config shape, measurements and environment in task research, not secrets.
- [ ] Rank measured bottlenecks and propose smallest optimization in existing owner. If none materially affect target, stop at report instead of speculative refactor.
- [ ] Implement focused tests proving exact counter/coverage, persistence/restart, lease/RPM permit, error/cancellation/SSE and bounded queues for the changed owner.
- [ ] Repeat benchmark same host/workload, compare distributions and document remaining limits; run narrow tests then full Node check/inline VM/env-scrubbed `npm test`/`git diff --check`, independent review and commit.

Rollback: independent performance commit; if changed metadata format/cadence, rehearse startup/rollback on temporary copied data before any separately authorized release.
