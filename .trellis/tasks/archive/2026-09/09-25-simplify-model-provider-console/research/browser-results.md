# Model/Channel split: local real-browser acceptance (2026-09-25)

The native `agent_browser` binary was unavailable in this environment, so the already-installed Python Playwright 1.58.0 + headless Chromium 145.0.7632.6 exercised the **production** `public/index.html` against the archived pricing task's loopback-only Node fixture. It uses a temporary `DATA_DIR`, mock upstream, independent synthetic admin password and fabricated client/account keys. No production data/key, paid upstream, deployment or persistent operator config was accessed. The fixture process was stopped and its temporary data cleaned after measurements; `/tmp/cps-ui-browser-fixture.log` remains a non-business intermediate until the user approves deletion at task completion.

Reproduce from repository root while the UI task is active (after archival, insert `archive/2026-09/` after `.trellis/tasks/` in the three UI-script paths):

```bash
node .trellis/tasks/archive/2026-09/09-25-expand-reference-prices/research/price-browser-fixture.mjs
# In a second terminal, replace <port> with the fixture's exact printed loopback port:
python3 .trellis/tasks/09-25-simplify-model-provider-console/research/ui-browser-check.py http://127.0.0.1:<port>/
python3 .trellis/tasks/09-25-simplify-model-provider-console/research/ui-browser-check.py http://127.0.0.1:<port>/ dense
# Stop the fixture via SIGTERM.
```

## Interactive 390 CSS px smoke

The final smoke passed: administrator fixture login; keyboard Enter on the top navigation button focused the panel heading; the default model view was visible with 12 rows and the channel view hidden; an expanded price-row `<details>` opened with Enter and showed the frozen v2 tariff and non-billing caveat. A synthetic DeepSeek V4.1 Flash success showed `$0.000002259000 – $0.000004518000`, not an actual charge. Both model (978 vs 340 CSS px) and channel (1024 vs 340 CSS px) table wrappers accepted keyboard ArrowRight horizontal scrolling. Enter on the channel button retained focus, changed `aria-pressed`, announced the view through the live status and displayed one named channel; the model view became hidden. Search and child-tab switching changed no statistics-read count: one read on initial console load plus one on panel entry; switching top navigation hid the panel. This is browser behavior, not screen-reader verification or production data.

## Synthetic dense projection

A separate browser route intercepts **only** the local authenticated `/api/statistics` read and replaces its displayed model list with 200 synthetic model projections × 10 synthetic channels each. This is UI workload, not a valid ledger or real model inventory. The local service's catalog remains 12 models, unlike the archived performance probe's 200-model catalog; therefore the earlier mixed-table numbers are context, **not** a strict A/B comparison. `Performance.getMetrics` measures browser TaskDuration/LayoutDuration; wall time includes Playwright and local HTTP waits. At 390 CSS px, two final runs measured:

| View/action | Rows | DOM elements at view | Wall ms | Browser TaskDuration ms | LayoutDuration ms |
|---|---:|---:|---:|---:|---:|
| Enter default model view | 200 | 4,241 | 433.0 / 339.9 | 28.6 / 27.3 | 5.6 / 5.7 |
| Switch to channel view | 2,000 | 36,239 | 209.1 / 207.2 | 203.9 / 201.5 | 76.8 / 66.0 |
| Filter channels to 10 rows | 10 | — | 39.7 / 40.3 | 37.9 / 38.4 | — |

Within this same fixture, default entry avoids rendering channel rows, while explicitly selecting the dense channel view still costs roughly 200 ms of browser task time (not a service-capacity/300 RPM result). A subsequent review removed inactive rows from the DOM on each child-view redraw; the follow-up below verifies that switching back no longer retains 2,000 hidden rows. The default has **not** been tested with production-scale price/version history or screen readers; user-visible rates/usage correctness remains owned by the focused VM tests and synthetic integration tests. Do not claim the mixed-table baseline improved by an exact percentage given different catalog/cardinality and browser runs.

## Review follow-up: inactive rows removed (390 CSS px)

The same local fixture and script were rerun after the review change. In the ordinary 12-model smoke, keyboard entry, focused child buttons, horizontal scrolling, details and search passed. In the 200 × 10 synthetic projection, channel view contained 2,000 rows / 33,239 DOM elements, then keyboard Enter on the model child button returned focus to that button, restored 200 model rows, left **0 channel rows** and 4,239 DOM elements. Selecting channels again reconstructed all 2,000 rows from the same snapshot; the authenticated statistics-read count stayed at two (initial console and panel entry). Two post-review synthetic runs measured model entry TaskDuration **29.9 / 29.6 ms** and channel switch **209.9 / 223.6 ms**. These remain local synthetic observations, not a strict A/B benchmark or production latency promise; screen-reader announcements remain unverified.
