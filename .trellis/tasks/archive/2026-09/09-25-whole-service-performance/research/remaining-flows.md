# Remaining local performance flows: recovery, scheduled quota, connection reuse

## Reproduce / safety boundary

```bash
node --check .trellis/tasks/09-25-whole-service-performance/research/remaining-flows.mjs
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node .trellis/tasks/09-25-whole-service-performance/research/remaining-flows.mjs all
# or: replace `all` by `logs`, `quota`, or `proxy`
```

The new `research/remaining-flows.mjs` was run twice in its final `all` configuration on the local Node v26.8.1/macOS arm64 host. It creates a fresh random `os.tmpdir()` tree, puts all synthetic config/admin state/ordinary JSONL/detailed manifests there, binds only `127.0.0.1`, and removes the tree and closes child processes/mock listeners in `finally`. It never reads the repository's `config.json`, `metadata.json` or default `DATA_DIR`. The child is a disposable copy of the *current working-tree* `server.js` with only a process-exit CPU/loop/memory snapshot prelude, plus symlinks to local source/dependencies; no changes to the running service or business files. Credentials are fictional and only mock HTTP server addresses are used. Ordinary/detailed store timings call the real exported classes directly. No production traffic, raw detail capture, live credentials, TLS proxy, external network or deployment was involved. The repository's business code may change concurrently; these numbers identify this run's working tree rather than a frozen revision.

The script does **not** emit synthetic log rows, body contents, auth data or raw configuration. The log fixtures have valid, recent timestamps and distinct identities; ordinary requests/errors are split into 1,000-row segments, detail groups each contain one small metadata-only valid manifest and **no body file**. The probe uses 12 serial query repetitions per combination. Its p95 for 12 or 23 samples is a near-maximum, not a real tail estimate. Ordinary/detailed recovery begin concurrently, after fixture creation, and `ready.wallMs` ends only after both complete. `cpuMs` from `process.cpuUsage` includes other JS/I/O callback work and possibly thread-pool effects during that interval, so CPU time can exceed wall time. `loopMaxMs` for the store is across recovery *and queries*. Child CPU/loop/RSS/heap are whole child lifetimes including initialization, scrypt admin login, traffic and shutdown, not section-level attribution.

## Recovery and query scale (two complete runs)

| Flow | Small corpus (1,000 request + 100 error rows, 100 detail roots) | Larger corpus (30,000 + 3,000 rows, 2,000 roots) |
|---|---:|---:|
| Ordinary JSONL bytes / segments | 177,580 / 2 | 5,384,780 / 33 |
| Ordinary recovery ready (from joint launch) | 15.4–15.5 ms | 53.9–54.9 ms |
| Detailed recovery ready (from joint launch) | 44.1–45.3 ms | 518.6–550.1 ms |
| Joint ready wall / process CPU | 44.3–45.4 / 53.1–54.8 ms | 518.7–550.1 / 616.7–648.5 ms |
| Ordinary first page, 20 rows, wall p50 (12) | 0.77–0.91 ms | 0.70–0.72 ms |
| Ordinary absent-model filter, wall/CPU p50 (12) | 0.98–1.09 / 1.06–1.35 ms | 25.17–25.52 / 25.84–26.05 ms |
| Detailed first page, 20 roots, wall p50 (12) | 0.07–0.08 ms | 1.16–1.17 ms |
| Detailed absent-model filter, wall p50 (12) | 0.02 ms | 0.26–0.28 ms |
| Detailed exact manifest retrieval, wall p50 (12) | 0.17–0.18 ms | 0.16 ms |
| Probe heap after queries | 14–15 MiB | 38 MiB (same process had already run small corpus) |

Executable owners: `lib/jsonl-log-store.js` constructor/`_recover()` read and reconcile each historical segment asynchronously; `_queryPass()` reads catalogued segments newest first until enough matches, but rare/missing filters inspect all bounded data. Its absent-match cost above is mostly local parsing/CPU plus disk cache, *not* upstream wait. `lib/detailed-log-store.js` startup `reconcile()` indexes manifests/file sizes without reading bodies; `query()` traverses the in-memory inventory and `detail(id)` reads just the requested manifest. Detail startup growth here is many local filesystem operations + manifest parsing, **not** a chat/network bottleneck; the probe does not isolate disk I/O from JavaScript CPU at the source-section level. The fixture is substantially below 50k/10k ordinary retention and 100k detailed inventory safety limits, and excludes detail body files, raw inventory, boundary rewriting, corrupt entries and cold OS page cache.

The second stage launched the **real HTTP service** on the same larger corpus after closing the direct store instances. After listen + synthetic admin login (225.5/230.0 ms), the first authenticated ordinary GET returned safe `503` while recovery was still running. A simultaneous authenticated detail GET completed `200` in 512.8/507.7 ms (it queued behind reconciliation); an independent model chat against the local mock returned `200` in 19.9/17.8 ms during that wait. A later ordinary GET returned `200`. This checks truthful unavailability/fail-open and restart behavior at one scale; it does not imply every chat during recovery will complete in 20 ms. The one polling count is after waiting on the detail GET and is **not** a 503 duration or readiness bound.

## Scheduler overlapping model chat

Source: `server.js` `scheduleQuotaRefresh()` / `requestQuota()` / `pumpQuotaQueue()` / `runQuotaJob()`. The test-only `NODE_ENV=test`, `CLINE_PASS_TEST_QUOTA_SUCCESS_MS=120` setting is supplied **only** in the enabled case, so the routing scheduler wakes every 10 ms (production wake is 1–30 s, and successful quota cache normally lasts 5 minutes). Eight valid synthetic accounts have no capacity restriction; local quota mock deliberately sleeps 35 ms per GET; chat mock replies immediately. Two ~1.6 s, sequential, paced-chat trials per full run compare quotaPool=false/true. The reported quota/chat hit counts also include service startup/warm-up and the 80 ms post-trial settle; latency distributions include only paced trial chats. There is no per-key throttling and no paid upstream.

| Metric | quotaPool=false | quotaPool=true |
|---|---:|---:|
| Chat samples | 87 / 86 | 89 / 89 |
| Chat latency p50 / p95 (run 1) | 3.50 / 5.69 ms | 3.40 / 5.62 ms |
| Chat latency p50 / p95 (run 2) | 3.65 / 5.87 ms | 3.42 / 5.73 ms |
| Quota GETs / chat arrivals while a mock quota GET was in flight | 0 / 0 | 70 / 64; 66 / 63 |
| Quota mock wait p50 / p95 | not applicable | 36.24 / 37.29 ms; 36.31 / 37.46 ms |
| Peak concurrent mock quota GETs | 0 | 2 |
| Child total CPU including startup/login (two runs) | 351 / 353 ms | 418 / 429 ms |
| Child max event-loop delay, incl. startup/login | ~54 ms | ~52–54 ms |

Observed overlap is at the mock's *network wait interval*: chat arrivals occurred while two quota requests could be in flight, and completed without waiting the 35 ms mock delay in these small-message samples. The extra ~67–75 ms **whole-process** CPU is consistent with increased quota parsing/metadata persistence but cannot be attributed solely to the timer, nor normalized to identical chat counts/startup conditions. These runs do not claim zero contention, production 1–30 s scheduling behavior, worst-case quota payload cost, large metadata impact or saturated-account semantics. The number 2 was independently observed on the mock, matching the global slot cap in `server.js`.

## Direct / HTTP CONNECT / SOCKS5 reuse

Actual owner: `server.js` `proxyAgentFor()` / `clineRequest()`: native direct keep-alive agents and cached `HttpsProxyAgent`/`SocksProxyAgent`. Three fresh child processes each send 24 serial chats to the same local HTTP/1.1 upstream, changing only the account `proxyUrl`. Local HTTP CONNECT and minimal local SOCKS5 mocks each deliberately add **8 ms wait once per new tunnel** (not in the direct case); downstream and upstream keep-alive stay on. Each phase saw one upstream TCP connection; HTTP saw exactly one CONNECT, SOCKS exactly one SOCKS connection, direct neither. All 72 responses per run were HTTP 200.

| Case | First chat run 1 / run 2 | Warm p50 (23 each) run 1 / run 2 | Child total CPU run 1 / run 2 |
|---|---:|---:|---:|
| Direct | 11.78 / 12.45 ms | 2.86 / 2.93 ms | 176 / 175 ms |
| HTTP CONNECT | 25.12 / 25.03 ms | 3.15 / 3.04 ms | 182 / 184 ms |
| SOCKS5 | 25.19 / 23.58 ms | 2.88 / 3.16 ms | 180 / 185 ms |

The first-call gap includes child-to-upstream TCP setup, the intentionally delayed handshake, Node/HTTP work and other variance; **do not** attribute its entire difference to proxy CPU or to the fixed 8 ms. Warm proxied and direct times are similar here because tunnels are reused. This demonstrates reuse only for one healthy HTTP/1.1 host, one account, sequential traffic; not a TLS handshake/CONNECT benchmark, SOCKS5H DNS test, remote/slow proxy, multiple accounts, concurrency, exhausted sockets or proxy failure fallback test. Existing integration tests cover proxy failure and TLS correctness separately; no change is recommended from these timings.

## Recommendation / gaps

- No business-code optimization is justified from these small synthetic remaining-flow measurements. Most visible scale effect here is **cold detailed manifest reconciliation** (~0.5 s for 2,000 metadata-only roots) and rare-filter ordinary JSONL query (~25 ms for 33,000 rows); neither is a proven common chat-path hotspot. Retain the existing bounded, fail-open recovery/catalog owners and truthfully show startup diagnostics as pending.
- A realistic follow-up would measure near-cap roots/rows, body-file sizes, real disk stall injection, retry/maintenance contention and CPU profiles, and local HTTPS upstream through HTTP/SOCKS proxies with concurrent socket pressure. The 10-ms accelerated test scheduler cannot stand in for production timer cadence. No production capacity/SLO claim, no aggregate 300 RPM assertion.
- This additional measurement phase changed only its research script/doc; the task's separate metadata-encoding change, tests and spec are described in `results.md`. Local temporary fixtures were automatically removed after each successful run; no residual workload data belongs in the repository.
