# Measure and optimize service hot paths for an aggregate 300 RPM reference load

## Goal

Explore what else should be optimized to keep the proxy responsive at roughly five requests/second service-wide, independent of the number of client API keys. Establish evidence before code changes, and improve only demonstrated bottlenecks.

## Current facts

The service is one Node ESM process. Upstream account `maxRpm` counts real Provider attempts and `maxConcurrent` counts leases, neither is a downstream per-key throttle. `pruneStatistics()` (`server.js:2489-2543`) traverses bounded 24h cells twice per request finalization and `record()` (`server.js:2739-2832`) synchronously atomically writes metadata; both are candidate hotspots, not benchmark findings. Ordinary JSONL already uses bounded async pending records/bytes. Detailed capture/redaction may incur event-loop CPU; raw mode default-off and subject to separate deployment safety gates.

## Requirements

- Create a reproducible local-only benchmark workload with temp `DATA_DIR` and mock upstream: paced aggregate 300 RPM for multiple 60s windows, bounded short/slow/SSE scenarios, relevant account cardinality, cold/warm metadata and logging modes. Measure offered vs achieved throughput, latency distributions, errors/blocked reasons, event-loop delay, CPU, RSS/heap, metadata growth/save frequency and diagnostic drops; separate upstream-imposed limits from service bottlenecks.
- Profile the existing owners (account lease/retry, connection pooling, JSON/metadata statistics, ordinary/detailed logs, SSE/backpressure). Rank issues by measured impact and risk; make local reversible optimization(s) only when baseline supports them, preserving exact routing, durability, fail-open diagnostic behavior, unknown vs zero and stream cancellation semantics.
- Document post-change results under identical conditions plus failure/restart tests. If 300 RPM cannot be sustained in a workload, report limitations/next steps; do not manufacture a universal production SLO or weaken account protection.

## Acceptance criteria

- [ ] Benchmark instructions, fixture, workload duration and machine/runtime configuration reproduce a before/after record without production data/upstreams.
- [ ] Report distinguishes queue/client/upstream bottleneck, 429/503 due to configured account capacity, event-loop stalls, diagnostic drops and client-visible failures.
- [ ] Every optimization has focused regression tests (including fault, SSE and restart paths where affected); identical post-change run plus full project gate, with evidence rather than speculative refactor.

## Out of scope

Per-key quotas, bypassing account RPM/limits, multi-process/distributed limiter or unchecked live/paid upstream or production load testing. This task does not turn on raw diagnostics.
