# Design: differential high-concurrency request-path investigation

## Scope

Read-only business behavior: new artifacts are reproducible, non-secret local benchmarks and a ranked findings report. This child does not implement an optimization or change production settings. Reuse archived 09-25 whole-service harnesses only after verifying they use temporary `DATA_DIR` and local mock upstreams; do not remeasure every archived admin/startup scenario. Run current committed baseline and, after the routing/log children pass their gates, run the same workload on the integrated branch. Avoid conflating baseline revision changes with an individual feature's cost.

## Workloads and attribution

- Synthetic owner-isolated pools of 1, 2, 10 and optionally larger accounts; healthy, differing health, unknown and finite/unlimited concurrency; concurrency steps around each pool's capacity, representative fast and slow mock upstreams, deliberate mock upstream 429, and local pool-full 429. Compare current legacy selection, opt-in load-health, and sticky baseline under identical inputs. Count per-account attempts (including retries), admission waits, successful completions and 429s separately; do not call a local 429 a Provider 429.
- Diagnostics off, existing sanitized error/full and accepted `raw-full` on **synthetic** small/large requests. Measure content limits and drop reasons; raw bodies may hold fake markers only. Do not enable or exercise raw capture with production content. Warmup and steady-state windows should be reported separately.
- Trace request entry/body parse and validation, enabled-account scan + health projection + lease wait, local transport including SSE backpressure, final statistics/metadata atomic write and ordinary/detail-log enqueue/publish. Prefer isolated perf hooks or temporary harness instrumentation, not permanent extra per-request logging. Timers nested in a request cannot simply be summed as independent bottlenecks.
- Record revision, Node/OS/hardware, workload generator, sample count and repetitions, fixed mock delays, simultaneous and sustained rates, p50/p95/p99 where statistically meaningful, throughput, CPU, heap/RSS, event-loop delay, optional cgroup peak, 429 split and capture drops. Use bootstrap/repeated-run spread rather than a single p99 to assert improvement. Compare to archived results only when definitions and inputs match.

## Output and decisions

`research/method.md` gives safe replay commands; `research/measurements.md` holds bounded aggregate data and source-backed observations (no request body/header/keys); `research/recommendations.md` separates measured fact, likely explanation, counterexample/risk, cost, next test, and ranking. If a bottleneck lacks evidence, state that. Gather a minimal anonymized production telemetry proposal without operating production: e.g. local vs upstream 429 split, per-owner pool eligibility counts, selected-account in-flight distribution, feature/profile rate, p95/p99 with declared sampling. Any code optimization suggested after this study needs a separate review and explicit scope approval. On rollback remove only disposable benchmark fixtures; Trellis research records remain.
