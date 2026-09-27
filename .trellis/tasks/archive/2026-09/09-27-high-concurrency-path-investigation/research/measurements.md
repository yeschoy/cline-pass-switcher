# Synthetic request-path measurements (2026-09-28)

These are bounded **run summaries**, not production throughput or latency. Exact runner, revisions, definitions and replay commands: `method.md`. A = `7eeb3b220e1c2071056d5c763f5d12af0b946a2e`; B = `378ff1f03112fc71d029508d1922ab230dfe8635`. Data below are per-run values in execution order, rounded to 0.1 where indicated. p99 for 6/12/24/48 samples is not a population tail estimate. Differences near the run-to-run spread are not improvements/regressions.

## Routing, admission, 429 and stream

Default fast requests: 96 requests in 12-wide waves; `full*` 24 in 12-wide waves against 40 ms mock/2 × capacity 1; `slow10` 48 against 40 ms mock/10 × capacity 1; `sse10` 48 against 40 ms delayed `[DONE]`. `health*` = known 90% and 20% rates for two accounts plus eight unknown; `dense*` = 1,200 repeated synthetic minute buckets. `RPS` means completed requests divided by wave-span; **local 429 increases apparent RPS**. Fields: throughput RPS (three runs), client p50/p95/p99 ms (three runs, `p50:p95:p99`), response-window CPU ms (three runs). Event-loop max and RSS are whole-child **measured-window** ranges, not per-request allocation.

| Case | Ref | n / outcome per run (200, local 429, upstream 429) | RPS per run | Client p50:p95:p99 ms per run | Response CPU ms per run | Loop max ms / RSS peak MiB ranges |
|---|---|---|---|---|---|---|
| rr1 | A | 96,0,0 | 1581,1579,1608 | 5.3:7.1:8.4; 5.3:7.3:9.6; 5.3:7.3:8.6 | 58,60,59 | 5.6–6.9 / 83–84 |
| rr1 | B | 96,0,0 | 1531,1613,1450 | 5.4:7.6:9.8; 5.1:7.3:9.1; 5.7:8.8:10.9 | 59,60,60 | 7.4–8.3 / 83–84 |
| rr2 | A | 96,0,0 | 1519,1040,1505 | 5.3:8.7:9.5; 7.5:14.8:18.7; 5.6:8.5:8.9 | 64,93,64 | 5.8–16.4 / 84–85 |
| rr2 | B | 96,0,0 | 1518,1512,1518 | 5.4:7.5:9.8; 5.4:8.5:9.2; 5.3:8.3:9.3 | 63,64,63 | 7.7–8.3 / 84–86 |
| rr10 | A | 96,0,0 | 1160,952,1084 | 6.9:10.5:11.5; 7.9:14.2:16.3; 7.4:11.7:13.2 | 94,110,101 | 8.9–15.8 / 85–86 |
| rr10 | B | 96,0,0 | 1145,1150,1158 | 6.9:10.3:12.2; 6.8:10.5:12.5; 6.9:10.8:11.9 | 94,84,85 | 8.0–8.9 / 84–85 |
| load10 | B only | 96,0,0 | 1153,1128,1128 | 7.0:10.6:11.7; 6.9:10.9:12.3; 7.0:11.5:12.7 | 92,96,98 | 7.5–8.9 / 85–86 |
| sticky10 | A | 96,0,0 | 1078,1056,1135 | 7.5:11.1:13.1; 7.9:12.0:13.1; 7.3:11.0:12.3 | 96,100,96 | 7.7–9.6 / 84–86 |
| sticky10 | B | 96,0,0 | 1097,1106,1109 | 7.6:11.3:12.4; 7.4:11.4:13.0; 7.4:10.9:12.4 | 97,96,97 | 8.2–9.2 / 84–85 |
| health10rr | A | 96,0,0 | 417,1177,931 | 8.9:45.5:74.0; 6.6:10.5:11.7; 7.2:14.2:30.2 | 122,93,96 | 8.8–51.5 / 85 |
| health10rr | B | 96,0,0 | 1174,1133,1142 | 6.5:11.4:12.4; 6.9:10.7:11.8; 6.9:10.8:12.5 | 85,98,92 | 8.6–10.0 / 85–87 |
| health10load | B only | 96,0,0 | 1027,1121,1029 | 7.6:12.6:14.2; 7.2:10.9:12.5; 8.2:13.0:15.1 | 116,97,111 | 8.8–10.1 / 85–87 |
| full0 | A | 24 => 4,20,0 | 256,252,261 | 6.7:49.1:49.7; 6.6:49.5:50.2; 6.8:47.8:48.4 | 26,27,26 | 5.9–7.0 / 78–80 |
| full0 | B | 24 => 4,20,0 | 257,253,251 | 6.2:49.2:49.9; 6.5:48.9:49.6; 6.0:49.9:50.5 | 25,25,25 | 6.1–7.5 / 78–79 |
| full80 | A | 24 => 8/9/8,16/15/16,0 | 133,108,135 | 85.9:91.6:92.2; 85.7:91.3:130.1; 85.1:90.0:90.5 | 33,38,32 | 6.3–8.7 / 78–79 |
| full80 | B | 24 => 8,16,0 | 132,135,131 | 86.6:92.6:93.2; 86.1:89.8:90.6; 86.7:94.1:94.8 | 36,31,37 | 7.3–10.2 / 79–80 |
| pool80 | B only | 24 => 8,16,0 | 134,133,133 | 86.3:90.9:91.5; 86.6:90.6:91.2; 86.4:90.8:91.5 | 32,34,33 | 7.2–10.3 / 78 |
| slow10 | A | 48,0,0 | 134,134,133 | 51.8:88.7:92.1; 51.8:88.8:93.0; 51.7:90.7:92.2 | 93,88,91 | 12.0–16.5 / 83–84 |
| slow10 | B | 48,0,0 | 132,136,131 | 53.5:92.3:93.7; 49.1:87.8:91.0; 52.5:91.4:94.0 | 99,73,92 | 8.5–15.7 / 84 |
| upstream429 | A | 48 => 0,0,48 | 736,767,847 | 7.0:16.4:18.0; 6.7:15.7:17.2; 6.4:14.2:15.6 | 75,68,61 | 6.1–8.9 / 83 |
| upstream429 | B | 48 => 0,0,48 | 834,866,834 | 6.4:14.4:15.9; 6.2:13.7:15.1; 6.3:14.3:15.9 | 64,61,61 | 8.8–9.5 / 82–84 |
| rpm429 | A | 24 => 4,20,0 | 1333,1102,900 | 5.1:12.2:12.6; 6.2:14.6:15.0; 6.6:19.2:19.3 | 22,28,33 | 5.4–7.7 / 79–80 |
| rpm429 | B | 24 => 4,20,0 | 1277,1311,1259 | 5.6:12.4:12.7; 5.1:12.3:12.7; 5.8:12.5:12.9 | 23,23,23 | 5.4–6.1 / 78 |
| sse10 | A | 48,0,0 | 149,134,134 | 49.0:59.0:61.4; 52.3:65.4:66.8; 54.0:61.2:63.0 | 103,152,149 | 17.4–17.8 / 86 |
| sse10 | B | 48,0,0 | 137,133,145 | 51.2:66.9:71.5; 54.5:62.4:65.7; 49.1:61.8:63.6 | 156,153,117 | 11.6–17.3 / 86–87 |

**Meaning and attribution.** All fast/unlimited requests succeeded and each had one mock attempt. `rr2` split 48/48, `rr10` ~9–10/account, slow10 ~4–6/account; sticky10 concentrated on 6–8 accounts due to only 12 identities (not a balancing guarantee). B `health10load` never selected known-bad `a1` under this loose capacity; instead a0 and unknowns received attempts (a0 7–8; one unknown 16–17). B `load10` called `successHealthProjection()` **1,056 times per 96 measured requests** vs 96 for `rr10`; `strategyRank` inclusive total ~0.68–0.71 ms/96 and `acquireAccountLease` ~1.37–1.44 ms/96. `health10load` lease ~1.55–1.65 ms/96. At these sparse states, run-to-run whole-request variation is much larger. A `health10rr` first-run event-loop max 51.5 ms and synchronous metadata write total 57+49 ms, while its other runs have lower latency: not evidence of a cross-revision win. For fixed capacity 0 ms wait: 4 **successful**/24 and 20 local 429; 80 ms wait: 8–9 successful, 15–16 local 429 but p50 ~85–87 ms and half-ish total completion RPS; successful completions per second remained roughly similar (~40–45/s) because the mock accounts have fixed capacity/latency. B `pool80` affects only pool-full wait, a new option **not present in A**. A/B normal 80 ms wait is the matched comparison. RPM 20 local 429 produced zero Provider attempts; upstream429 produced 48 upstream 429, 48 attempts, with 24 attempts per account across different requests. No automatic within-request account failover is inferred or recommended.

### Dense metadata / health scan (different from prior archived dense corpus)

48 completed small requests, 12 in flight, 1,200 cloned minute buckets and the same differing-health seed. Run-by-run measurements:

| Mode/ref | RPS (3) | p50/p95/p99 client ms (3) | Response CPU ms (3) | Loop max ms (3) | RSS peak MiB (3) | Account lease / strategyRank / health projection inclusive ms (3) | JSON stringify / sync write / rename ms (3) |
|---|---|---|---|---|---|---|---|
| RR A | 187,190,187 | 34.9:63.8:67.0; 36.5:62.1:64.4; 37.0:63.4:64.7 | 264,260,264 | 52,49,39 | 172,172,173 | 0.42/0.03/3.00; 0.48/0.03/3.21; 0.42/0.03/2.97 | 140/46/5.7; 140/46/5.6; 144/44/7.1 |
| RR B | 206,193,180 | 32.7:57.9:58.7; 34.5:60.7:63.5; 35.5:67.8:77.8 | 254,260,270 | 37,49,64 | 169,169,175 | 0.44/0.03/2.89; 0.46/0.03/3.11; 0.46/0.03/3.29 | 137/29/5.2; 138/43/5.4; 145/39/18.3 |
| load-health B | 193,188,193 | 36.9:61.5:63.5; 37.5:63.2:64.9; 36.3:60.7:63.7 | 271,275,270 | 41,42,45 | 174,172,175 | 12.74/12.30/15.50; 12.92/12.48/15.67; 12.58/12.15/15.27 | 138/31/5.4; 144/30/5.4; 138/31/5.5 |

Projection call counts: RR **48**, load-health **528** per 48 requests. `strategyRank` includes health projection; lease includes ranking; these are **nested**, not additive. B load-health's ~12.2–12.5 ms ranking total is ~0.25–0.26 ms/selected request in this artificial dense case. Its `record()` inclusive total was ~179–184 ms/48 requests (RR B ~175–207 ms); JSON stringify alone ~138–144 ms/48, sync file write ~30–31 ms/48. The high dense response delay is not solely selection. B RR spans 180–206 RPS, encompassing B load-health 188–193; A RR ~187–190; not a reliable throughput gain/loss attributable to revision or new mode. This corpus is **not** the archived 1,200-minute × multi-Provider corpus, so cross-report absolute times must not be compared.

### Backpressured, paused SSE (separate from short SSE above)

Each response ~4 MiB SSE (256 × 16 KiB synthetic `data:` records), 120 ms intentional client pause after its first chunk; n=12, concurrency=4, 12 **sequential** warmups excluded. A runs: RPS 24.0/23.2, p50/p95/p99 **154/186/186** and **164/179/179** ms, response CPU 209/248 ms, event-loop max 18.5/18.5 ms, sampled RSS 210/209 MiB, mock `write(false)`/`drain` 40/40 and 48/48. B: RPS 25.2/24.0, latencies **148/170/170** and **156/180/180** ms, response CPU 200/243 ms, loop max 16.8/19.5 ms, RSS 274/214 MiB, mock backpressure 41/41 and 42/42. 12/12 status 200 and 12 Provider attempts in each run. The ~120 ms deliberate reader pause and mock/OS buffering dominate latency; `runChatChain()` ~35–52 ms **ends before the stream completes**, not a full-stream profiler. No counter for downstream `res.write(false)`, TLS/proxy pressure, cancellation or partial-client drops was recorded. This cannot establish an A/B SSE improvement.

## Optional diagnostic modes (same workloads A/B; default off)

`offSmall/errorSuccess/fullSmall/rawSmall`: 48 successes, 340-byte input, concurrency 4; error-429 off/on: 48 upstream 429, no warmups; 1 MiB: 12 successes, concurrency 2; 6 MiB: 6 successes, concurrency 2. Each row shows two fresh-child runs: RPS, p50/p95/p99 ms (for n≤12, p95 and p99 both equal the maximum), response-window CPU ms, total CPU after async publication ms, event-loop max ms, sampled RSS peak MiB. All successes made exactly one Provider attempt; all failures had 48 attempts, **0 local 429**. No detail bodies were read by the benchmark.

| Case | Ref | RPS (2) | Client p50/p95/p99 ms (2; n≤12 p99=p95) | CPU response → after publish ms (2) | Loop max ms (2) | RSS peak MiB (2) | Measured detail roots / drops |
|---|---|---|---|---|---|---|---|
| offSmall | A | 847,864 | 4.1/5.0/5.1;3.9/5.0/5.1 | 35→36;35→36 | 5.7,5.7 | 82,81 | 0/0 |
| offSmall | B | 864,847 | 3.8/5.0/5.7;4.1/5.0/5.4 | 36→36;35→36 | 5.9,5.7 | 83,82 | 0/0 |
| errorSuccess | A | 843,870 | 3.9/5.2/5.5;3.7/5.2/5.5 | 44→45;42→43 | 5.7,5.9 | 82,82 | 0/0 |
| errorSuccess | B | 804,865 | 4.3/5.4/5.4;3.8/5.3/5.6 | 44→45;42→43 | 5.9,6.0 | 84,83 | 0/0 |
| errorFailOff | A | 667,635 | 4.6/9.7/10.8;4.7/10.9/12.1 | 63→63;63→64 | 6.1,6.2 | 81,82 | 0/0 |
| errorFailOff | B | 630,647 | 4.7/11.3/12.7;4.6/10.7/11.9 | 65→66;65→66 | 6.7,6.6 | 82,82 | 0/0 |
| errorFail | A | 631,512 | 4.7/12.7/14.0;5.6/11.6/12.9 | 99→111;118→135 | 8.8,12.2 | 87,89 | 48/0 |
| errorFail | B | 672,624 | 4.4/11.4/12.7;4.9/11.6/12.9 | 95→110;101→110 | 9.6,9.1 | 87,87 | 48/0 |
| fullSmall | A | 832,826 | 4.0/5.3/5.8;4.0/5.1/5.7 | 76→148;77→146 | 10.0,9.6 | 95,94 | 48/0 |
| fullSmall | B | 845,776 | 3.9/5.4/6.0;4.1/5.8/6.0 | 78→154;82→153 | 6.1,7.6 | 96,95 | 48/0 |
| rawSmall | A | 618,823 | 4.2/11.9/23.1;4.2/5.0/5.2 | 67→124;73→120 | 11.0,10.2 | 91,90 | 48/0 |
| rawSmall | B | 829,907 | 4.1/5.0/5.1;3.6/4.9/5.2 | 75→124;64→121 | 11.3,6.3 | 91,90 | 48/0 |
| offLarge (1 MiB) | A | 286,282 | 6.2/8.5;5.6/7.3 | 42→43;40→40 | 6.5,5.7 | 147,149 | 0/0 |
| offLarge | B | 263,306 | 6.5/9.1;5.8/7.5 | 48→49;40→40 | 6.2,5.9 | 158,146 | 0/0 |
| fullLarge | A | 82,65 | 9.2/41.5;40.0/42.9 | 181→538;231→536 | 37.2,38.0 | 235,256 | 12/0 |
| fullLarge | B | 55,81 | 37.9/46.6;10.9/40.8 | 275→506;209→503 | 39.3,35.3 | 266,260 | 12/0 |
| rawLarge | A | 257,265 | 6.8/10.4;6.6/9.4 | 69→101;65→95 | 7.5,7.5 | 210,217 | 12/0 |
| rawLarge | B | 260,269 | 6.7/8.3;6.5/8.5 | 71→98;66→93 | 7.4,8.3 | 201,205 | 12/0 |
| off6m | A | 69,72 | 25.3/30.0;25.8/28.6 | 96→97;94→94 | 12.4,12.3 | 313,270 | 0/0 |
| off6m | B | 71,71 | 24.8/28.7;26.8/27.6 | 107→109;103→104 | 13.2,12.3 | 296,250 | 0/0 |
| full6m | A | 5.2,4.9 | 39.5/570.2;42.2/615.2 | 1230→1860;1317→1668 | 533,581 | 437,422 | 6/4 captureBudget each |
| full6m | B | 5.1,5.1 | 42.7/613.5;39.3/606.7 | 1265→1902;1267→1913 | 573,568 | 403,408 | 6/4 captureBudget each |
| raw6m | A | 59,60 | 31.5/35.4;29.9/34.1 | 145→221;142→239 | 15.6,25.3 | 402,398 | 6/0 |
| raw6m | B | 51,59 | 38.3/40.9;31.8/35.8 | 165→252;145→235 | 29.4,23.5 | 470,436 | 6/0 |

For every `full6m` run, six roots were published but 16 descriptors reported `resource-limited`, four `truncated`, four `complete`; largest captured descriptor **5,242,880 B**. B `captureDropped` counter incremented 4/4 (A 4/5; it counts capture events, not necessarily one per dropped root). For every `raw6m`, 24 descriptors were `complete`, max captured descriptor **6,291,617 B** (upstream attempt JSON includes injected route fields). Raw carries **unredacted synthetic bytes** and is intentionally behind readiness/authentication/retention controls; its faster measurement is **not** a safe replacement for sanitized logging. `errorSuccess` published no roots, but its response CPU (~42–44 vs off ~35–36 ms/48) still shows request-local setup cost; `errorFail` published 48 and used more total CPU (~110 vs failure-off ~63–66 ms/48). 1 MiB sanitized full spent ~500–538 ms process CPU after publication vs off ~40–49 ms; 6 MiB sanitized full produced ~0.57–0.61 s client maxima and >0.5 s event-loop max while safety limits prevented some descriptors. Small n, synthetic repeated characters, GC and async publication mean these are warning signs for **opt-in** workloads only, not general model-traffic regressions.

## Code-path evidence and cross-report boundary

- `server.js:1438–1560` scans eligibility and rank, enforces maxConcurrent then reserves RPM, and waits on the existing waiter/deadline; `server.js:1523` recomputes health for every candidate in `load-health`. `server.js:2830–2860` projects recent minute buckets per account. `server.js:2033` selects and leases **before** the Provider chain; `server.js:4234` runs attempts within that account. The benchmark disables retries (`maxRetries=0`); it cannot characterize high retry fanout or cooldown-driven documented pre-stream replacement.
- `server.js:2709` updates statistics, `server.js:2881–2970` records bounded ordinary logs and calls `saveMeta()`, and `server.js:115–126` synchronously stringifies/writes/renames metadata atomically for each completed request. Timed `record()` is inclusive of `json.stringify`/write/rename, and async ordinary `append` duration is queued work **after** the response in part; do not sum them. Sparse B RR1 had `record()` 21–24 ms/96; dense B RR had 175–207 ms/48. Source proves the synchronous save frequency; this probe does not model a slow disk or demonstrate that weakening durability would be safe.
- `server.js:4718–4735` selects default-off diagnostic profiles and limits concurrent roots to 128. `lib/detailed-log-capture.js:325–425,440–550` captures, bounds, and learns/redacts before materialization; raw skips redaction. `lib/detailed-log-store.js:390–410` publishes files asynchronously. Under the measured sanitized near-limit fixture, `captureBudget` omissions and high loop stalls are **safety behavior**, not a reason to disable omission. The archived 09-21 isolated sanitizer pass (~102 ms for near 5 MiB) and archived 09-25 five near-5 MiB chats (~300 ms loop maximum) are corroborating but use **different fixtures/scopes**, not directly comparable numbers.
- This task did **not** rerun archived 09-25 dense `/api/statistics`, cold catalog, browser DOM, ordinary log recovery, direct/HTTP/SOCKS proxy or quota refresh profiles. Archived `results.md`, `statistics-read-results.md`, `remaining-flows.md`, `worst-cases.md` already establish conditional management/startup costs under their own workloads. Our 1,200-minute case has one model/Provider cell cloned, not their multi-Provider/price-version corpus. No fresh evidence for a UI, log-store or connection-pool change.

## Check-agent replay after source/attribution hardening

A/B smoke on the same Node v26.8.1/Darwin arm64 checkout, one fresh child per case, one run each; **not** pooled with the earlier 2–3 run tables and not evidence of an A/B improvement. This replay copies committed `server.js`, `lib/`, and `public/` separately for each approved ref and verifies the shared fixture/lockfile. Values are measured-wave RPS and client p50/p95/p99 in ms; per-run JSON was printed by the reproducible script, not saved with bodies.

| Case | A: RPS, p50/p95/p99 | B: RPS, p50/p95/p99 | Outcome / real mock calls per ref |
|---|---|---|---|
| rr2 (96) | 1533, 5.30/7.69/9.24 | 1485, 5.56/8.33/9.67 | 96 × 200 / 96 |
| offSmall (48) | 846, 4.06/5.02/5.13 | 854, 4.04/4.96/5.23 | 48 × 200 / 48 |
| upstream429 (48) | 826, 6.29/13.97/15.58 | 807, 6.61/13.34/15.37 | 48 mock 429 / 48; local 0 |
| rpm429 (24) | 1208, 5.61/13.16/13.50 | 1237, 5.24/12.98/13.57 | 4 × 200, 20 local 429 / 4 |
| load10 (96) | unavailable by design | 1101, 7.32/11.11/12.72 | B: 96 × 200 / 96 |
| rawSmall (48) | not replayed | 835, 4.07/5.06/5.49 | B: 48 × 200, 48 raw roots, 0 drops / 48 |

One additional pre-hardening B `offSmall` check saw 569 RPS and ~9.73 ms p95; the immediate hardened replay above returned 854 RPS and 4.96 ms p95. The source of this variation was not measured, further limiting any small A/B performance inference. Local-mock counters and response headers agreed in all hardened cases, but no body/ordinary-log file was read back and no sustained load, near-35-MiB raw body, TLS/proxy, production telemetry or downstream backpressure counter was verified.
