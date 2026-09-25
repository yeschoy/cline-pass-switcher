# Integrated-tree same-workload performance rerun (2026-09-25)

## Scope and reproducibility

Local macOS arm64, Node v26.8.1, headless Chromium 145.0.7632.6. The copied and path-corrected `integrated-profile.mjs` uses a disposable `DATA_DIR`, temporary instrumented `server.js`, current `lib/` and static files, synthetic credentials, local HTTP mock and strict child environment. It removes its own temporary corpus. The original four process runs compare `cc17ac7` (pricing v2 + split UI, before multi-key) with integrated `d56e2f1` (`4250d88` multi-key plus archive/journal commits) under the **same generated one-owner workload**, not byte-identical live data: one sparse bucket, then 1200 cloned minute buckets; 32 serial small chats, 8 serial 512 KiB chats, statistics/account/meta/model reads and SSE. `--ref` changes only the instrumented `server.js`; both runs use current `lib/`, `public/` and admin fixture, whose runtime owners did not change across these commits. The old HTML is compared separately in the browser check. The current server adds owner migration to its config, so startup/config processing is not identical even with the same inputs. One baseline/integrated pair also runs `--extended`: 3-attempt Provider retry, error/full sanitized diagnostic modes, 49 MiB ingress, cancellation, 2.1 MiB slow-consumer SSE, and ten-account sticky/health-sort 12-request burst. A model client key is always synthetic; the profiler does not measure a second owned key, production TLS, sustained 300 RPM or real upstream. The separate `test/pricing-key-integration.test.js` checks two-key actual-upstream credential isolation/cost correctness, **not** performance.

Run from the repository root:

```bash
p=.trellis/tasks/09-25-pricing-console-keys-300rpm/research/integrated-profile.mjs
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node "$p" --ref=cc17ac7 [--extended]
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node "$p" [--extended]
# Once the parent task is archived, insert archive/2026-09/ after .trellis/tasks/ in p.
```

Selected pair 1 / pair 2, pre-key → integrated (all mock responses expected HTTP 200):

| Metric | Pre-key pair 1 / 2 | Integrated pair 1 / 2 |
|---|---:|---:|
| Sparse small-chat p50 (n=32) | 3.10 / 3.09 ms | 3.05 / 3.19 ms |
| Sparse statistics GET p50 (n=16) | 1.85 / 1.79 ms | 1.81 / 1.81 ms |
| Dense small-chat p50 / p95 (n=32) | 23.86 / 26.13; 23.43 / 25.67 ms | 23.12 / 25.78; 23.20 / 26.07 ms |
| Dense statistics GET p50 / p95 (n=16) | 27.19 / 31.39; 27.05 / 33.24 ms | 27.46 / 33.93; 27.23 / 31.34 ms |
| Dense metadata bytes / JSON writes | 7,980,386 / 50 both | 7,980,386 / 50 both |
| Dense process CPU / max event-loop delay | 2296 / 54.6; 2259 / 55.9 ms | 2350 / 56.2; 2319 / 57.0 ms |
| Dense exit RSS | 294 / 298 MiB | 278 / 280 MiB |
| Dense total stringify / temp-write time (50 writes) | 770 / 163; 764 / 141 ms | 749 / 158; 759 / 147 ms |
| Extended 10-account sticky p50 / 12 waiter p50, p95 | 24.35 / 465.90, 784.61 ms | 24.17 / 467.39, 789.72 ms |

The extended retry made three mock attempts, slow SSE retained 2,101,310 bytes after a paused consumer, and the large-body request succeeded (~252 ms both). A check-agent rerun after requiring the profiler's expected HTTP statuses (and using an independent retry counter rather than mutating the total mock-hit counter) passed pre-key/integrated `--extended`: sparse small-chat p50 3.06/3.01 ms, dense small-chat p50 23.41/23.15 ms, dense statistics GET p50 27.24/27.93 ms, and 10-account waiter p50 459.02/468.97 ms. These are additional local samples, **not** a new capacity target or directly combinable with differently instrumented archived pre-pricing runs. The same-workload measured distributions show **no clear multi-key regression** for these one-owner paths. CPU/RSS differences are whole-process, startup/GC and sequencing sensitive; p99 with 8–32 samples is only the maximum. The earlier archived compact-metadata measurement had different pre-pricing statistical values and is not a strict A/B comparator to this later tree; the dominant dense-history cost remains synchronous per-terminal metadata rewrite and expensive model statistics projection. The profiler does not instrument a second key's cache-target growth, full 5 MiB sanitizer or cold 5k-manifest recovery; archived bounded worst-flow evidence owns those conditional cases.

## Interleaved real-browser HTML A/B

`integrated-ui-browser-check.py` reuses the archived UI checker and the archived pricing task's **current** loopback fixture (insert `archive/2026-09/` after `.trellis/tasks/` in the checker path after parent archival). At 390 CSS px it intercepts only the authenticated statistics response to display 200 synthetic models × 10 channels (2000 channel rows). Set `CPS_UI_SOURCE_REF=cc17ac7` to serve the **old committed HTML** via `git show` against that same current server; unset for integrated HTML. This is a UI A/B, not an old-server benchmark. Run order was old/new/old/new after two initial new-only repetitions. Both versions passed keyboard child-tab/focus and model-table horizontal scroll, kept the same two statistics reads, and returned from 2000 channel rows to zero hidden channel rows in the **dense** checker. Channel-table scrolling, DeepSeek amount text and search/navigation were exercised by the separate normal-fixture smoke in the archived UI child, not by this dense A/B.

| Browser TaskDuration (ms), old pair | Integrated pair | DOM old → integrated |
|---|---:|---:|
| Model entry: 53.8 / 52.6 | 52.5 / 52.9 | 4239 → 4278 |
| Channel switch: 348.1 / 346.3 | 350.4 / 352.0 | 33239 → 33278 |
| Filter channels to 10 rows: 102.1 / 103.6 | 102.1 / 101.8 | ten rows both |

An independent check-agent old/new/old/new rerun on a fresh copy of the same loopback fixture again passed 200/2000 rows, two reads and inactive-row removal: old model TaskDuration 53.7/54.3 ms, integrated 51.8/52.8 ms; old channel 349.2/349.3 ms, integrated 351.4/359.8 ms. This small and variable difference does not establish parity or a meaningful multi-key regression. Layout on the original channel-switch pair was ~121–124 ms old and ~121 ms integrated. Earlier archived UI-child runs recorded ~210–224 ms for channel switch and ~38 ms filtering; the **same old HTML in this current interleaved fixture** is also ~346–348 ms / ~102–104 ms. That rules out attributing the entire difference to the multi-key UI, but does **not** establish why this machine/browser run is slower, nor prove production latency. Explicitly opening 2000 channel rows remains a measurable local DOM/layout cost; default model view retains only 200 rows. We did not optimize it in the integration phase without representative usage/frequency evidence.

## Limits and verdict

The isolated two-run source probe and interleaved UI A/B found no clear regression attributable to multi-key integration under their bounded workloads. It is **not** a sustained/burst throughput test, a 300 RPM capacity or latency guarantee, a production container/TLS/proxy/slow-disk benchmark, or a screen-reader review. Diagnostic drop/queue counts and real billing were not measured in these comparisons; do not infer zeros. Parent acceptance combines this with the archived whole-flow profiles and focused functional tests, and retains old-image rollback as an explicit production blocker until a separately authorized full pre-upgrade data restore rehearsal.
