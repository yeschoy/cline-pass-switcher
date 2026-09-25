# Current-price console real-browser smoke (local, 2026-09-25)

`agent_browser` could not launch because its required binary was not on PATH. Fallback used the already-installed Playwright 1.58.0 with real headless Chromium 145.0.7632.6 at **390 CSS px**. Only a synthetic `DATA_DIR` and loopback mock upstream/admin fixture were used; no production keys/data, paid upstream or deployment.

Reproduce from repository root:

```bash
node .trellis/tasks/archive/2026-09/09-25-expand-reference-prices/research/price-browser-fixture.mjs
# In another terminal, use its printed loopback fixture URL:
python3 .trellis/tasks/archive/2026-09/09-25-expand-reference-prices/research/price-browser-check.py http://127.0.0.1:<printed-port>/
# Stop the fixture with SIGTERM; its temporary data and child service are removed.
```

Two consecutive runs before archival and one run after archival all passed: native administrator fixture login; keyboard Enter activates “模型和渠道” and focuses its title; the expandable current-reference-tariff table has **12 exact rows**; V4.1 Flash row shows labelled `低峰：0.15 / 0.6 / 0.003 / —` and `高峰：0.3 / 1.2 / 0.006 / —` with DeepSeek official source; Qwen3.7 Plus explains unknown context tier/cache-write count; the single synthetic successful V4.1 Flash request renders **$0.000002259000 – $0.000004518000** and `已计 1 / 1 最终成功请求` rather than an actual charge. The tariff wrapper is horizontally scrollable (scroll width 768 vs 340 CSS px), and keyboard ArrowRight moved its scroll position after native smooth scrolling settled. Switching to the separate statistics tab showed monthly reference remaining **$40.00** for one synthetic account with 20% monthly usage, confirming the price-page change did not replace the `$50 × remaining-percent` calculation in this fixture.

This is a real browser focus/layout/keyboard smoke against synthetic data, not screen-reader review or an authenticated production topology. The separate UI simplification child will change tab structure later and must re-run its own browser acceptance. The local browser fixture was stopped after both runs; its temporary data was removed automatically. An external `/tmp` fixture stdout log remains a non-business intermediate until the user authorizes cleanup at task completion.
