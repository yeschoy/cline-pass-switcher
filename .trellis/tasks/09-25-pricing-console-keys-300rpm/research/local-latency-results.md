# Isolated current-HEAD latency probe (planning, 2026-09-25)

Command, reproducible script (reads only source, creates/removes a temporary synthetic `DATA_DIR`):

```bash
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node .trellis/tasks/09-25-pricing-console-keys-300rpm/research/local-latency-probe.mjs
```

Node v26.8.1 on this local machine, one switcher process, one in-process loopback mock upstream, one synthetic account (`maxRpm:0`, `maxConcurrent:0`), four model IDs, ordinary logging defaults, detailed logging off, valid synthetic admin fixture. All requests below were sequential; small chat uses 100-character user text, large uses 512 KiB, mock replies immediately with short JSON/explicit usage. Each phase was warmed once. After the first phase, the script shut down the service, copied one valid synthetic statistics minute bucket to 1200 ordered minute positions inside the last 24h (not real traffic), restarted the same binary and measured again. No production data/keys/paid upstream, no raw capture. Script removed its temporary fixture. Response timing includes loopback/client JSON and the proxy; it does not isolate CPU stacks.

| Phase / two runs | metadata JSON | startup incl. synthetic admin login | small chat p50/p95 (32) | 512 KiB chat p50/p95 (8) | GET statistics p50/p95 (16) | GET accounts p50/p95 (8) |
|---|---:|---:|---:|---:|---:|---:|
| 1 bucket, run 1 | 15,908 B | 132.9 ms | 2.1 / 2.9 ms | 3.4 / 4.4 ms | 1.5 / 1.8 ms | 1.4 / 1.7 ms |
| 1200 cloned buckets, run 1 | 13,390,772 B | 157.4 ms | 18.0 / 19.9 ms | 18.4 / 18.8 ms | 14.3 / 17.8 ms | 2.2 / 2.4 ms |
| 1 bucket, run 2 | 15,908 B | 208.8 ms | 2.3 / 4.6 ms | 4.9 / 6.7 ms | 1.8 / 3.5 ms | 1.4 / 1.7 ms |
| 1200 cloned buckets, run 2 | 13,390,772 B | 174.9 ms | 19.9 / 32.6 ms | 22.0 / 34.1 ms | 23.0 / 43.4 ms | 4.5 / 16.4 ms |

Every sampled response was HTTP 200. **Evidence:** in this synthetic 24h-history case small chat and statistics GET both slow substantially while account GET grows less; this supports prioritizing the statistics traversal and metadata serialization/write path for finer attribution. It does **not** prove which part dominates (`pruneStatistics`, `saveMeta`, `sendJSON`, filesystem, client GC) or establish production latency/throughput. Difference between two runs warns against exact absolute thresholds. Startup numbers include scheduling and admin login, so no reliable startup regression conclusion.

Next measurement before any implementation: instrument current source in a test-only profiler or Node CPU profile at `commitStatistics` pre/post prune, `record`/`saveMeta` JSON/stringify/write/rename, statistics projection and `sendJSON`; run same corpus, then account/Provider cardinality, multiple retries, SSE/slow clients, cold catalog/diagnostics, UI trace and error/slow disk scenarios. Only optimize a source owner after attribution and preserve metadata atomicity/coverage. This is **not** a 300 RPM stress result.
