# Performance experiment and change boundary

## Experiment

Use native Node test/benchmark scripts with a local mock upstream and unique temporary `DATA_DIR`/port; one spawned production `server.js` process, deterministic test credentials/configuration and isolated stats/logs. Warm startup, then drive open-loop pacing of 5 starts/sec for >120s; add bounded bursts and separated SSE/slow-response tests so arrival rate is not confused with in-flight concurrency. Record intended/actual start time to detect generator saturation, client TTFB/complete latency p50/p95/p99, result/status/account/attempt counts, event-loop delay in the service process, CPU, RSS/heap, metadata file bytes/write counts and JSONL queue drops. Avoid unstable absolute cross-machine CI thresholds; CI asserts structural correctness and bounded behavior, while same-machine measurements are a transparent research artifact. Cleanup temp fixture *only after* review of non-business artifacts, and do not touch operator data.

## Candidate owners to measure

- `pruneStatistics()` scans all 1440 minute buckets and nested cells twice around finalization; `record()` calls same-directory synchronous `saveMeta()` once per final request. The issue may be metadata size and cardinality rather than rate itself. Instrument at safe counters/monotonic timers in a test-only way without logging secrets or bodies. Any deduplicated/incremental pruning or persistence cadence change must preserve migration, history/version coverage, crash consistency and fail-open model traffic; changing durability requires explicit review, not a silent batching assumption.
- `JsonlLogGroup` already bounds pending records/bytes; do not introduce another queue. SSE comments/backpressure and native keep-alive already have owners: verify rather than replace. Error/full detailed capture can be benchmarked only within its security defaults and memory budgets; raw 35 MiB remains off.
- Multi-key routing may change candidate/filter and binding costs; take an integrated pre-optimization baseline after that child. Any earlier current-HEAD exploratory run is separately labelled, not a same-workload before/after comparison. A synthetic mock must not exceed configured per-account `maxRpm` unintentionally; record legitimate local blocks, not classify them as service failure.

## Risk/rollback

Scope optimization to source-proven work. Compare traffic bytes, status, finalization count, diagnostic drops and persistent metadata on restart before/after. Retain original algorithm behind a small reversible commit if semantics diverge; no new scheduler/store/worker/queue without measurement and design review. Local results do not establish container/production or paid upstream behavior. Do not deploy or run a live benchmark without separate user approval.
