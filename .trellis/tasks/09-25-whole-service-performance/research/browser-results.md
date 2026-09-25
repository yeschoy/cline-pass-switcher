# Isolated real-browser console performance smoke (partial)

`agent_browser` was unavailable (`agent-browser is required but was not found on PATH`; its suggested doctor binary was also missing). Fallback used the already-installed Python Playwright 1.58.0 / headless Chromium 145.0.7632.6 on a **local synthetic** service. Commands:

```bash
node .trellis/tasks/09-25-whole-service-performance/research/browser-fixture.mjs
# In another terminal use the printed loopback URL:
python3 .trellis/tasks/09-25-whole-service-performance/research/browser-measure.py http://127.0.0.1:<printed-port>/
```

The measurement script accepts only the exact printed loopback-root URL (`http://127.0.0.1:<port>/`), rejecting userinfo, paths and nonlocal hosts before opening Chromium; this does not authenticate the process behind a manually supplied port. The fixture uses temporary `DATA_DIR` and a loopback upstream, test-only administrator verifier/password, 10 invented upstream accounts, 50 or 200 known model IDs and a 5000-ID synthetic catalog. Set `CPS_LOCAL_MODEL_COUNT=200` on the fixture process for the second case; its bounded default is 50. No operator config, real credentials or paid calls. It handles SIGTERM and removes the fixture; the two-run measurement used a 390 CSS-pixel viewport, native UI login, `Performance.getMetrics`, and actual DOM/request observations. The automation wall time includes Playwright command/locator waits, so it is **not** a user-perceived response-time SLO; browser `TaskDuration` is cumulative CPU accounting during each step, not a precise JS profiler. The local service had sparse recent statistics; neither run models a dense 1200-bucket dashboard.

| Operation | Run 1 wall / TaskDuration | Run 2 wall / TaskDuration | Other observed facts |
|---|---:|---:|---|
| Login + initial six admin reads/render | 141.2 ms / 67.8 ms | 147.6 ms / 68.5 ms | 50 model rows, 400 rendered catalog rows, 5994 DOM elements; 9 completed requests total including root/auth/state/login + exactly 6 reads; layout ~13.5–13.7 ms |
| Open catalog, filter 5000 IDs to one row | 15.6 ms / 10.9 ms | 14.2 ms / 10.8 ms | 0 network requests, one resulting row |
| Switch to statistics | 138.3 ms / 30.0 ms | 139.9 ms / 25.8 ms | 3 requests: GET statistics, POST quota refresh, GET statistics; ten accounts refreshed then served cached |
| Switch to model/Provider | 125.4 ms / 30.5 ms | 125.5 ms / 21.2 ms | One separate GET statistics, 50 model rows |

A second two-run case with **200 known models** and the same 10 accounts / 5000 catalog IDs created 200 model rows, 400 catalog rows and 13,044 DOM elements. Initial native login + six reads took 234–264 ms automation wall / **161–170 ms browser TaskDuration** (layout ~44–46 ms, style recalc ~26 ms). Filtering the 5000 IDs to one row took 40–42 ms automation wall / **37–39 ms browser task** with no network; statistics navigation used three requests and ~49 ms task; model/provider navigation one request and ~61 ms task / ~25 ms layout. Compared with 50 models (~5994 elements, ~68 ms initial task and ~11 ms filter task), this gives concrete DOM-scale cost, but those are *different synthetic corpora* with only two iterations each, not an isolated JS-vs-layout causal profile or actual subscription model count. Whole-page table rebuilding and hidden panels remain plausible UI optimization candidates for the later simplification child; don't imply that 200 subscription rows are a common production state.

This confirms a sizeable **initial DOM surface** and repeated statistics reads when navigating; it does not prove browser scripting is the dominant user-facing bottleneck. A separate bounded real-browser test added 0/3/10 synthetic Providers per model at 200 models; tab browser task time rose from ~74–96 ms to ~211–217 ms to ~461–474 ms, mostly more DOM/layout. Its methodology and limitations are in `research/browser-provider-density.md`; this is a real UI render scalability signal, not real Provider usage or production traffic. Dense **statistics histories**, 100+ accounts, repeated keystrokes, real network RTT, long-task distributions and production hardware remain untested. The planned model/provider UI simplification can reduce default row count; repeat the same fixture after that child. No browser-side business code was changed in this task.
