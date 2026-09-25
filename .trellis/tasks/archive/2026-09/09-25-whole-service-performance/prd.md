# Whole-program performance review and evidence-based optimization

## Goal

Find comparatively slow operations **throughout the service**, determine frequency and user impact, then improve the highest-value existing owners without weakening correctness/security. The future aggregate 300 RPM example is only one possible load case, not the primary goal, a client-key quota or the sole pass/fail threshold.

## Confirmed evidence

Read-only code audit under parent `research/perf-routing-transport.md`, `perf-stats-diagnostics-startup.md`, and `perf-management-ui.md` covers startup, HTTP/body/auth, account selection, provider transport/SSE, statistics/persistence, ordinary/detailed logging, quota jobs, management API and browser rendering. Some old full-directory logging scans were already fixed; avoid duplicating that work. A reproducible local synthetic loopback probe at current HEAD (`research/local-latency-results.md`) found that cloning valid recent history from 1 to 1200 buckets (metadata ~16 KB → 13.39 MB) correlated with small-chat p50 ~2 ms → ~18–20 ms and statistics GET p50 ~1.5–1.8 ms → ~14–23 ms in two runs. This is **not** a CPU profile, causal attribution, concurrent/production test or 300 RPM result. `pruneStatistics()` traversal and `record()` sync metadata rewrite are candidates; other key candidates include large-body retry cloning, many-account ranking/wake-ups, cold catalog fetch, opt-in detail redaction and browser redraw.

## Requirements

1. Establish a *whole-flow inventory* with measured baseline for cold start/restore, typical and worst input, 1/multiple Provider attempts, session/account modes, upstream keep-alive/SSE/slow consumer/cancellation, stats and metadata sizes, ordinary/error/full diagnostics, quota polling, common management endpoints and UI initialization/filter/redraw. Distinguish local CPU/event-loop/disk cost from upstream network waits and deliberate account capacity limits.
2. Measure source-level hot sections and rank by **frequency × cost × user impact**, with concrete data scale and diagnostic modes. Apply small reversible optimizations to proven high-value issues in the current owner; do not add a second queue/store or simply disable safety work. Re-profile after each fix on the same corpus, with explicit structural/failure/restart tests.
3. Report slow operations that remain, benefits and tradeoffs, plus limitations where measurements are not representative. Throughput under aggregate 300 RPM may be included as one scenario; no per-client-key limiter or universal production SLO.

## Acceptance criteria

- [ ] Repeatable local synthetic commands/corpus and report for each major flow; startup, steady-state, management and browser metrics are not collapsed into a single 300 RPM number. CPU/IO/loop/heap and latency distributions distinguish correlation from causal profile evidence.
- [ ] At least the observed history-size regression is attributed to measured source sections; if another hotspot dominates under representative workloads, prioritize by evidence and explain any deliberately deferred item.
- [ ] Each actual optimization preserves request/body/auth, account lease/permits, provider retry, SSE/cancellation/backpressure, durable metadata and known-zero/unknown coverage; focused and full tests plus before/after profile verify no semantic regression.
- [ ] No production data, keys, paid upstream, deployment or live load test used without separate authorization. Report unresolved risks rather than claiming unconditional 300 RPM capacity.

## Out of scope

Large framework rewrite, distributed global throttling, hidden loss of diagnostic/statistics coverage and performance claims for unmeasured production container/topology.
