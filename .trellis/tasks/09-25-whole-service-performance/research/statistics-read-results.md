# Second pass: statistics GET projection (local synthetic, 2026-09-25)

## Reproduce

```bash
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node .trellis/tasks/09-25-whole-service-performance/research/statistics-read-profile.mjs --ref=6abd3a0
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node .trellis/tasks/09-25-whole-service-performance/research/statistics-read-profile.mjs
```

`--ref` reads **only server.js from the explicit commit**; both modes copy/instrument source inside a disposable directory and use generated config, independent synthetic admin fixture, local mock HTTP and a temporary `DATA_DIR`. The parent cleans up on normal completion, exceptions and handled SIGINT/SIGTERM; SIGKILL/power loss cannot run cleanup. No default data, production traffic or credentials. Node v26.8.1 / local arm64. Four models are configured and projected **in every case**; the 1×1 / 4×3 labels count populated historical model/Provider cells, not the number of configured model rows. One synthetic account; the first priced model has a native valuation cell, while other model IDs use synthetic copied usage/health cells without valuation. Native chat first creates a valid version-5 template including final, Provider health, Provider usage and a frozen reference-price version. The script then clones the template into 1 or 1200 consecutive current 24h buckets; up to four models and three Provider slugs per bucket (14,400 cells per Provider owner, below the 50,000 limit). These are **schema-valid** and survive startup, but the cloned historical values are not a realistic distribution or reconciled lifetime event ledger. Detail logging off. Each case restarts one child, authenticates locally, warms three GETs, then measures 24 serial GETs to completion; no upstream fetch in GET. Response is bounded (~11–21 KB). Instrumentation wraps named source functions, the GET accounts/models/global sections, and `sendJSON` serialization; inclusive totals are nested, not additive. CPU, event-loop-delay max, heap and RSS are whole-child readings including startup/login/shutdown and are not per-request allocations.

## Evidence at unchanged committed baseline (`6abd3a0`)

| Corpus | Metadata / response bytes | GET p50 / p95 ms (24) | `route.models` mean ms/GET | `modelProviderProjection` mean ms/model | `providerUsageProjection` mean ms/call | `aggregateSuccessHealth` mean ms/call | stringify mean ms/response |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 bucket, 1 model × 1 Provider | 5,589 / 11,515 | 1.87 / 2.44 | 0.099 | 0.016 | 0.008 | 0.004 | 0.017 |
| 1200 buckets, 1 × 1 | 3,152,964 / 11,665 | 10.04 / 11.08 | 5.645 | 1.044 | 0.716 | 0.100 | 0.019 |
| 1 bucket, 4 × 3 | 13,991 / 20,473 | 1.93 / 2.12 | 0.187 | 0.038 | 0.006 | 0.001 | 0.025 |
| 1200 buckets, 4 × 3 | 13,235,364 / 21,073 | 45.68 / 48.18 | 41.013 | 8.827 | 1.996 | 0.153 | 0.035 |

At 1200 × 4 × 3, each GET called `modelProviderProjection` 4 times, `providerUsageProjection` 16 times (one model total + three Providers per model), `aggregateSuccessHealth` 13 times (12 Provider, one account). Source inclusive measurements attribute the GET regression mainly to `route.models` (41 ms/GET), not response JSON stringify (~0.035 ms); Provider usage and health repeatedly traverse the 1200 buckets. Model Provider projections are inclusive of usage/health and must **not** be added to them. `pruneStatistics` ~0.82 ms/GET, account projection ~1.46 ms/GET and four `aggregateModelRange` calls ~1.32 ms each also remain. The official console does an initial six-read sweep, statistics visits and the model/Provider view request this endpoint, so this is user-visible at high history scale but does not run on every chat finalizer. The service body is small; reducing JSON output would not address this synthetic case.

Whole-child baseline CPU ms / loop-delay max ms / exit RSS MiB / heap MiB: sparse 1×1 143 / 54.6 / 76 / 12.7; dense 1×1 592 / 54.9 / 118 / 17.0; sparse 4×3 151 / 54.0 / 81 / 13.4; dense 4×3 1827 / 62.8 / 170 / 24.2. Loop max includes startup and is **not** a GET p99.

## Measured experiment, deliberately not shipped

A temporary `server.js` single-pass prototype replaced repeated per-Provider bucket scans with a per-model traversal, sharing Provider aggregates/coverage and health. It preserved the focused frozen-price/overflow/prototype/coverage tests. Same synthetic commands/corpus produced the following paired numbers:

| Corpus | Baseline GET p50/p95 | Prototype GET p50/p95 | Baseline → prototype `route.models` ms/GET | Response bytes baseline/prototype |
|---|---:|---:|---:|---:|
| sparse 1×1 | 1.87 / 2.44 | 1.91 / 2.48 | 0.099 → 0.093 | 11,515 / 11,515 |
| dense 1×1 | 10.04 / 11.08 | 9.88 / 11.09 | 5.645 → 5.390 | 11,665 / 11,665 |
| sparse 4×3 | 1.93 / 2.12 | 1.92 / 2.11 | 0.187 → 0.178 | 20,473 / 20,473 |
| dense 4×3 | 45.68 / 48.18 | 43.59 / 46.59 | 41.013 → 38.971 | 21,073 / 21,073 |

The dense multi-Provider p50 difference was ~2.1 ms (~4.6%) **in one sequential A/B pair**, not an established speedup: there is no retained prototype patch/source to independently rerun that arm. A repeated unchanged-baseline run after review measured dense 4×3 p50 **44.05 ms** (another working-tree run **44.61 ms**) versus the original baseline **45.68 ms**; normal run-to-run variation is comparable to the proposed ~2 ms improvement. Source timings likewise describe instrumented work on this fixture, not an uninstrumented CPU profile. The prototype did not meaningfully reduce the expensive aggregate merges. Whole-child dense 4×3 CPU was 1793 vs 1827 ms; RSS 173 vs 170 MiB and exit heap 36 vs 24 MiB (not per-GET peaks, do not claim memory benefit). Given the low GET frequency relative to model traffic and the fragile frozen-version/overflow/coverage ordering contract, this does not justify landing the refactor. The prototype was reversed; `server.js` remains byte-for-byte committed `6abd3a0`. A separate focused v5 regression test retains learned compatibility checks (including prototype-named Provider, old frozen price distinct from its changed rate, explicit zero vs missing usage, independent Provider final/health/usage and restart). Existing pricing tests also pin overflow.

## Verification of the retained change

Focused historical projection test passed on both committed baseline and prototype; existing pricing/coverage/overflow/prototype-ID cases passed under the prototype. After reverting the runtime experiment, `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node --test test/integration.test.js` passed **110/110**, env-scrubbed `npm test` passed **295/295**, `node --check server.js` and all `lib/*.js`, inline HTML VM compile, profiler syntax check, and `git diff --check` passed. No production code or persisted/API schema was changed; no reusable spec contract update is warranted. The script, focused test and this report are retained task evidence, not runtime artifacts.

## Remaining risks / next evidence

The above is a source-level **attribution** for synthetic GET CPU work, not a production CPU profile, concurrent load test, browser trace, or sustained/300-RPM claim. Interleaved/real Provider usage cardinality, high account count, historical price-version diversity, real traffic ledger consistency and V8 GC can change ranking. A useful next candidate would reduce the number of aggregate-field operations (rather than merely the number of bucket loops) while proving exact overflowFields ordering, frozen old price versions, known-zero/unknown and incomplete coverage under differential response comparison on a richer valid corpus. Do not add a cross-request cache, drop Provider/valuation coverage, or change durability to speed up a management read. The chat terminal metadata rewrite still costs far more frequently than this GET, even after compact encoding. The whole-service task's additional slow-disk, browser-density, proxy saturation and sustained throughput evidence remains pending.
