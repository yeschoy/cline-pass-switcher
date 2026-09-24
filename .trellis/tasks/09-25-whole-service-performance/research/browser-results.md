# Isolated real-browser console performance smoke (partial)

`agent_browser` was unavailable (`agent-browser is required but was not found on PATH`; its suggested doctor binary was also missing). Fallback used the already-installed Python Playwright 1.58.0 / headless Chromium 145.0.7632.6 on a **local synthetic** service. Commands:

```bash
node .trellis/tasks/09-25-whole-service-performance/research/browser-fixture.mjs
# In another terminal use the printed loopback URL:
python3 .trellis/tasks/09-25-whole-service-performance/research/browser-measure.py http://127.0.0.1:<printed-port>/
```

The measurement script accepts only the exact printed loopback-root URL (`http://127.0.0.1:<port>/`), rejecting userinfo, paths and nonlocal hosts before opening Chromium; this does not authenticate the process behind a manually supplied port. The fixture uses temporary `DATA_DIR` and a loopback upstream, test-only administrator verifier/password, 10 invented upstream accounts, 50 known model IDs and a 5000-ID synthetic catalog. No operator config, real credentials or paid calls. It handles SIGTERM and removes the fixture; the two-run measurement used a 390 CSS-pixel viewport, native UI login, `Performance.getMetrics`, and actual DOM/request observations. The automation wall time includes Playwright command/locator waits, so it is **not** a user-perceived response-time SLO; browser `TaskDuration` is cumulative CPU accounting during each step, not a precise JS profiler. The local service had sparse recent statistics; neither run models a dense 1200-bucket dashboard.

| Operation | Run 1 wall / TaskDuration | Run 2 wall / TaskDuration | Other observed facts |
|---|---:|---:|---|
| Login + initial six admin reads/render | 141.2 ms / 67.8 ms | 147.6 ms / 68.5 ms | 50 model rows, 400 rendered catalog rows, 5994 DOM elements; 9 completed requests total including root/auth/state/login + exactly 6 reads; layout ~13.5–13.7 ms |
| Open catalog, filter 5000 IDs to one row | 15.6 ms / 10.9 ms | 14.2 ms / 10.8 ms | 0 network requests, one resulting row |
| Switch to statistics | 138.3 ms / 30.0 ms | 139.9 ms / 25.8 ms | 3 requests: GET statistics, POST quota refresh, GET statistics; ten accounts refreshed then served cached |
| Switch to model/Provider | 125.4 ms / 30.5 ms | 125.5 ms / 21.2 ms | One separate GET statistics, 50 model rows |

This confirms a sizeable **initial DOM surface** and repeat statistics reads when navigating; it does not prove browser scripting is the dominant user-facing bottleneck. In this sparse fixture, the catalog filter itself uses roughly 11 ms browser task time despite filtering 5000 IDs, and model/provider tab switch spends more time in end-to-end/automation wait than measured browser task. Dense statistics responses, 100+ accounts, many providers, repeated keystrokes, real network RTT, long tasks and production container/browser hardware remain untested. The planned model/provider UI simplification can reduce the row text/DOM surface; measure the same fixture after that child. No browser-side business code was changed in this task.
