# Bounded worst-flow follow-up: cold diagnostics, 5 MiB sanitized capture, concurrent catalog

## Reproduce and scope

```bash
node --check .trellis/tasks/09-25-whole-service-performance/research/worst-cases.mjs
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node .trellis/tasks/09-25-whole-service-performance/research/worst-cases.mjs all
# Narrower: substitute recover, capture, or catalog for all.
```

Two full `all` runs of the final measurement behavior on local macOS arm64, Node v26.8.1; values below are **run 1 / run 2**. After these runs, only teardown and an assertion that failed catalog fetch did not populate metadata were tightened; the separate `catalog` rerun confirmed `failedCacheAbsentBeforeRetry=true`, 12 cold mock calls, zero warm calls. The script uses a fresh random `os.tmpdir()` directory, restrictive synthetic config/admin authentication, a loopback-only mock and child server, and only a disposable copy of the current working-tree `server.js` and the two log modules. The copy adds a loopback token-protected metrics endpoint and optionally a `fs/promises` read delay; actual repo modules are unmodified. It closes processes/listeners and recursively removes its own fixture in `finally` (also has an exit cleanup fallback). No repository operator JSON/data, external host, paid endpoint, raw mode, production load or deployment is used. The report contains no body, credential or session values.

The child measures `process.cpuUsage()`, `monitorEventLoopDelay({resolution:1})`, RSS sampled every 10 ms and heap snapshots. Metric windows for capture and catalog are reset per phase; recovery metrics cover **startup + admin login + six chats + queries**, not just reconciliation. CPU is process-wide (including V8 GC and service work), and the loop maximum is the worst sampling interval, not a CPU flamegraph. Synchronous `JSON.stringify`, event-loop queueing and `fs` thread-pool work are not separately isolated. Each chat/capture/query sample is small (`n=5`, capture `n=5`, catalog `n=12`); nearest-rank p95 is effectively the maximum for these sample counts, not a population tail estimate. The corpus uses recent timestamps, unique IDs and valid manifests; it does not model cold OS page cache or remote disk.

## Cold recovery, local delayed reads and simultaneous chats

The deterministic fixture has 49,000 ordinary request rows (98% of 50k retention), 9,000 error rows (90% of 10k), **22,359,780 JSONL bytes** in 58 segments (not close to the independent 100 MiB byte cap), and 5,000 metadata-only detailed groups (5% of 100k entry fence; no body files). Seeding time is excluded. Startup log owner is `lib/jsonl-log-store.js` `JsonlLogGroup._recover()`, which parses bounded segments asynchronously. Detailed owner is `lib/detailed-log-store.js` `startup()`/`reconcile()`/`scan()`, which indexes manifests asynchronously and serializes list queries behind that scan. The injected case adds a 2 ms async timer before **every ordinary segment `readFile` and every 16th detailed manifest `FileHandle.readFile`** only in the disposable module copies; it does not stall the main event loop deliberately. Both cases restart the same fixture (prior run may add six new request rows).

| Metric | Normal run 1 / 2 | Delayed read run 1 / 2 |
|---|---:|---:|
| Listen detected after spawn | 153.59 / 153.54 ms | 152.81 / 154.85 ms |
| First authenticated ordinary GET | 503 / 503 | 503 / 503 |
| First detail GET wait (during six concurrent chats) | 1335.59 / 1323.10 ms | 1997.28 / 1957.35 ms |
| Six concurrent chats | all 200; p50 29.24 / 26.18 ms; p95 32.40 / 29.98 | all 200; p50 21.43 / 21.23 ms; p95 25.03 / 23.52 |
| Ready ordinary first-page GET, p50 / p95 | 3.24 / 3.59; 3.23 / 3.55 ms | 9.80 / 11.34; 9.79 / 11.34 ms |
| Ready ordinary **absent-model** GET, p50 / p95 | 78.04 / 86.08; 77.32 / 81.59 ms | 196.91 / 203.80; 202.02 / 203.90 ms |
| Ready detail first-page GET, p50 | 5.08 / 4.04 ms | 4.05 / 4.40 ms |
| Ready detail absent-model GET, p50 | 2.03 / 2.00 ms | 2.01 / 2.03 ms |
| Whole-window child CPU / loop max | 2395 / 2358 ms; 55.54 / 53.97 ms | 2420 / 2445 ms; 53.58 / 53.81 ms |
| Sampled peak child RSS | 229 / 230 MiB | 351 / 348 MiB |
| Instrumented read matches / accumulated injected timer wait | 0 / 0 | 5332 / 5332; 1395 / 1420 ms |

The first detail GET waited ~0.62–0.66 s longer under injected I/O. Added timer wait **across the entire service window, including later repeated queries**, was ~1.4 s, so it cannot all be attributed to cold reconciliation. Rare ordinary filters repeatedly reread many segments; with delayed reads their latency grows far more than first-page or in-memory detail listing. Process CPU rose only ~25–87 ms across cases, and loop max did **not** increase, supporting a waiting component rather than an injected JS busy loop. RSS differs appreciably but the two restart phases occur serially against warm OS cache/allocator states; do not interpret the RSS gap as the disk delay's causal memory cost. Also the six slow-case chats being faster is scheduling/order variance, not evidence that slow disks improve chat. The initial 503 plus 200 concurrent chats verifies fail-open/unavailable semantics for this fixture; the precise duration until ordinary recovery readiness is **not** measured (the script checks again only after the detail GET). No attempt was made to create 100k individual detail directories.

## Near-5 MiB input: full sanitized mode versus off/error-only

One valid chat JSON body is **5,238,853 bytes** (just below the 5 MiB detailed per-body copy limit; well below the 50 MiB inbound HTTP cap). Five requests per phase are serial to a local immediate-success mock; the error-only failure phase instead has five immediate upstream 503 responses. All 20 HTTP requests returned their expected success/failure statuses. Mode is changed through the authenticated `/api/logs/settings` route; `rawBodyLogging` stays false and `detailed-logs/raw/` remains empty. `lib/detailed-log-capture.js` owns 5 MiB copy/redaction and the shared 512 MiB / sanitized 64 MiB reservation; `lib/detailed-log-store.js` publishes manifests asynchronously. Phase CPU, loop and sampled RSS are child measurements including the five calls, listing/polling and settings read, not redactor-exclusive timings. No production credentials are included in body; the prompt is a repeated inert character.

| Mode, five chats | p50 / p95 ms (run 1; run 2) | Phase CPU ms (run 1 / 2) | Loop max ms (run 1 / 2) | Peak RSS MiB (run 1 / 2) | Detail inventory / health |
|---|---|---:|---:|---:|---|
| Default off, successes | 22.36 / 32.49; 21.03 / 30.73 | 122 / 123 | 18.27 / 17.97 | 218 / 215 | 0 roots, no drops |
| Error-only, successes | 20.39 / 22.43; 20.04 / 22.11 | 112 / 111 | 12.84 / 12.73 | 254 / 246 | 0 roots, no drops |
| Error-only, failures | 94.16 / 98.07; 89.34 / 97.18 | 517 / 504 | 86.05 / 84.67 | 339 / 324 | 5 error roots, no drops; failure processing is not comparable to success transport semantics |
| Full sanitized, successes | 28.93 / 327.68; 30.28 / 334.42 | 1495 / 1521 | 301.99 / 311.43 | 439 / 484 | 5 full roots; **1 `captureBudget` root drop and 2 capture reservation failures** in each run |

Both runs published 5 full manifests, but only 16 of their 20 body descriptors were `complete`; **4 were `resource-limited`**, so full mode did **not** retain every body at this size. Eight fully captured bodies exceeded 4.9 MiB, with the largest **5,238,891 bytes**, confirming the large-body sanitization path was exercised (not merely a short captured prefix). All detail descriptors read back had `redacted: true`; sanitized reservation had returned to zero by the health read. Store `health.dropped` and sum of fixed `dropReasons` agreed. The one root-level drop does not imply the group was absent: the manifest survived with safe omitted descriptors. p95/loop spike in full mode is local compute/copy/GC/possible synchronous finalization rather than upstream waiting (mock replies immediately); this measurement does not distinguish source-level redactor CPU from allocation/serialization. Mode phases share a child in fixed order, so RSS peaks are not independent clean-process comparisons. This is a reason to avoid assuming the 64 MiB sanitized budget or 5 MiB per-body cap implies a flat RSS ceiling. It is **not** evidence to weaken the safety fences.

## Cold concurrent `/api/models`: mock wait versus local work

`server.js` `catalog()` uses the one-hour metadata cache but has no in-flight fetch owner. On a fresh empty catalog, the fixture first returns a mock HTTP 503 with `{}` after 80 ms. The management route returns HTTP **200** with empty `catalog` (existing compatibility behavior); the mock count is one and metadata cache remains absent. A subsequent 12-way simultaneous authenticated GET with a controllable **200 ms** upstream delay causes **12** real mock model-list GETs in both runs, then a 12-way warm batch causes **zero** upstream GETs. The fixture asserts the post-retry catalog persisted 10 synthetic IDs. This is not a gateway/provider latency measurement; no paid calls were made.

| Batch (n=12) | p50 / p95 ms run 1 | p50 / p95 ms run 2 | Child phase CPU ms run 1 / 2 | Loop max ms run 1 / 2 | Mock GETs |
|---|---:|---:|---:|---:|---:|
| Cold concurrent, mock sleeps 200 ms | 211.50 / 214.40 | 211.43 / 214.41 | 39.74 / 40.24 | 6.22 / 6.38 | 12 / 12 |
| Warm concurrent | 1.19 / 1.43 | 1.36 / 1.60 | 7.36 / 6.18 | 1.18 / 1.28 | 0 / 0 |

The mock's explicit 200 ms wait dominates the cold client latency; the batch's ~40 ms **aggregate local CPU** and ~6 ms loop maximum are not per-request CPU and include response projection and repeated `saveMeta()`. This establishes a concurrent cold-fetch stampede on the current source, but not that it outranks the much more expensive opt-in full diagnostic workload at equal frequency, nor that such cold misses are common in production. If optimizing later, preserve fetch failure/retry, metadata atomicity, cache expiry and authenticated result shape; do not replace this evidence with a universal 300 RPM claim.

## Limitations and priority to caller

- Highest measured **conditional** user-path impact here: full sanitized 5 MiB capture, including an actual budget fence/drop and ~300 ms event-loop delay, but **default off**. It needs a representative diagnostic-mode call rate before treating it as the service-wide priority. The 503 error-only workload has distinct HTTP work and cannot isolate the error-only overhead by subtracting an off-mode success.
- Cold detail reconciliation with 5k metadata-only roots is ~1.3 s local file/CPU work; async I/O delay makes its first query ~2 s, while sampled concurrent chat remains functional. This is a cold/startup diagnostic availability issue; no 100k-file upper bound or real slow disk characterization has been measured. Ordinary rare-filter scans (49k rows) cost ~77–78 ms p50 normally and ~197–202 ms with injected read delay, not the ordinary first-page path.
- `/api/models` cold concurrency duplicates upstream work 12× in this synthetic case; the 200 ms mock network wait dominates observed client latency. The HTTP 200 response to upstream 503 with no data is a separately observed behavior, not a performance optimization recommendation.
- This supplements, not replaces, `research/results.md`, `research/remaining-flows.md` and the rest of the whole-flow task. No business code was changed, no production topology/disk cache/TLS/large body under concurrency was measured, and neither source-level CPU flamegraph nor sustained throughput is claimed. The script's deliberate injection is limited to async reads; failure/restart observations are first ordinary 503→200, fail-open chats, safe full-mode capture drops, uncached catalog mock failure→success and two fresh service restarts on the same synthetic log corpus.
