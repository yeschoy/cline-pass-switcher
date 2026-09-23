# Real Browser Smoke — Detailed Drop Reasons

- 2026-09-23, local Google Chrome headless via CDP trusted mouse events, isolated profile and temporary `DATA_DIR=/tmp/cps-detail-reasons-ui`; viewport **375 CSS pixels**, one fake account, detailed logging default off. No production API/data, paid upstream or credentials were accessed. The local service and Chrome were stopped after verification.
- The actual production inline script and real authenticated-management-page DOM were exercised. Nonzero reasons were injected **only into the browser's read-only `renderDetailHealth()` function** with fixed synthetic numeric counters; this was not an API write and did not touch persisted operator state. Server/API zero state was independently verified through `GET /api/logs/settings`.

| Check | Observed |
|---|---|
| Initial state | API `dropped=0` and all fixed `dropReasons=0`; details panel shows `本进程启动以来，诊断省略/拒绝 0 次；无原因分项`. |
| Real navigation | Trusted mouse click on `#navDetails` shows details panel; `#detailsDropReasons[aria-live=polite]` is visible. |
| Nonzero reasons | `{dropped:3,captureBudget:2,redactionWorkLimit:1}` displays fixed Chinese labels and safe counts only. |
| Unsafe extra key | Injected `<img src=x onerror=…>` key is ignored; no `img` node, no script side effect or text leak. |
| Focus | `document.activeElement.id` remained `navDetails` while the read-only region updated. |
| Narrow layout | Document width = viewport width = 375; reason paragraph `scrollWidth=clientWidth=325`, text wraps and is visually readable. |
| Old response | `{dropped:3}` without `dropReasons` says `原因暂不可用`, does not invent buckets. |

**Result: 7/7.** Temporary screenshot `/tmp/cps-detail-reasons-ui/reasons-375.png` was visually inspected; it is not committed. VM/static/UI API tests remain independent from this browser proof. This smoke does not establish the behavior of a deployed production console; this task does not deploy.
