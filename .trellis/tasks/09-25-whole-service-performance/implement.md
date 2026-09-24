# Whole-flow execution plan (after planning review/start)

- [ ] Load full backend/frontend scenario specs; verify parent read-only audits and two-run synthetic smoke. Record what is measured, inferred and untested.
- [ ] Build reproducible isolated harness/profile fixtures for startup, chat short/large/retries, account modes/waiters, keep-alive/SSE/cancellation, statistics/metadata size, ordinary/detail logs, quota scheduler, management reads and browser rendering. Do not read default operator files. Run narrow baseline with scenario-specific CPU/event-loop/IO/heap and latency/throughput traces.
- [ ] Specifically attribute 1200-bucket chat/statistics slowdown to pruning, metadata JSON/stringify/write, projection or other measured costs before touching these owners. Rank all candidates by weighted impact; record deliberate no-change decisions for already-fast or infrequent paths.
- [ ] Implement a small, coherent fix for proven top bottleneck(s), adding targeted semantic/fault/restart tests first. No extra queue/store, no RPM/auth/backpressure shortcuts or silent durability changes. If instrumentation shows the initial hypothesis wrong, follow measurements rather than the draft.
- [ ] Re-run same input/corpus/workloads and real-browser UI trace where relevant; compare p50/p95/p99, service CPU/event loop/RSS/heap, I/O, error/diagnostic drops, startup and common management latency. Preserve research/results with commands and limitations.
- [ ] Run focused tests for changed owners, `node --check server.js`, `lib/*.js`, production inline VM compile, env-scrubbed `npm test`, `git diff --check`; update English specs only for changed reusable contracts; independent review and commit including Trellis artifacts. Then repeat relevant cases after later feature children.

Rollback: preserve prior metadata and tests; each measured optimization is a separate reversible change. Production deployment/performance validation is not authorized here.
