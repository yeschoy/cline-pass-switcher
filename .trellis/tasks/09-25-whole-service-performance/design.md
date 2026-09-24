# Whole-service performance research and optimization design

## Surfaces and evidence levels

Map distinct operations to existing owners: synchronous startup config/metadata validation and asynchronous log-store recovery; inbound body/auth/session extraction; account ranking/leases/RPM/waits/cache pool; outbound agent/serialization/Provider retry; SSE first-event/observer/backpressure; terminal statistics and atomic metadata write; bounded ordinary/error/detail capture and maintenance; quota job scheduling; management statistics/accounts/models projection; browser six-read initialization, filters and DOM replacement. The parent `research/perf-*.md` records code-level costs; `research/local-latency-results.md` records two measured *correlations* on a 1200-bucket cloned history. Do not call a static O(N) loop an observed bottleneck or generalize the synthetic run.

## Measurement sequence

1. Use the existing parent `research/local-latency-probe.mjs` as a tiny **planning smoke** only. Build a maintained, bounded local-only harness after task start: temp `DATA_DIR`, synthetic credentials, local mock chat/catalog/quota/proxy, valid seeded statistics/log directories at sparse/full scales, separate cold/warm cases, in-process service metrics or CPU profiles that do not log secrets. Keep automatic fixture teardown; one process and Node >=18.
2. Attribute the demonstrated history-size slowdown first: instrument `commitStatistics()` pre/post prune, `record()`/`saveMeta()` stringify/write/rename, GET `/api/statistics` projection vs `sendJSON`; record CPU/event-loop delay and metadata bytes on the *same* valid corpus. Then compare request body 100B/512KiB/near-limit and 1/3 attempts, account mode and counts, many waiters, catalog cache miss/hit, detailed log modes, quota refresher, startup recovery and browser long tasks. A paced aggregate five starts/s run is an optional smoke alongside single-request/tail/burst tests; never substitute it for all-flow profiling.
3. Rank by measured cost × call rate × impact, address the highest proven hotspot in its existing owner, test semantics/failure/restart and rerun identical workload. For history-scale slowdown, preserve retention and persisted coverage, old price versions, same-directory atomic writes and fail-open diagnostic behavior. Any changed durability/cadence must be explicitly designed and reviewed first; do not quietly batch or drop metadata. Keep credential/body projections and SSE stream byte/lease lifecycle intact.

## Existing protections and risk gates

`JsonlLogGroup` already has bounded pending queue and active-segment I/O; detailed store has incremental index and distinct sanitized/raw budgets; native agents keep connections alive and SSE applies backpressure. Measure these rather than replacing them by default. Cold catalog can wait up to 60 s upstream, so distinguish network time and concurrent request deduplication from Node CPU. UI needs real browser Performance/Network evidence with synthetic local state; VM tests do not prove DOM/render cost. Maintenance/diagnostic slow disk needs injected local fault/latency with client traffic fail-open, never production mutation.

## Rollout

Performance work is the first implementation child. Later price/key/UI children must repeat relevant performance cases on their own changes and parent runs integrated checks. Each optimization has an independently reversible commit. No deployment/raw-mode enablement/paid load without separate authorization.
