# Independent quota exhaustion protection — check report (2026-09-24)

## Review and fixed findings

- Reviewed status/content/account evidence, existing quota queue/timer and pool-off source ownership, admission paths, account save/recovery, persisted account state, browser snapshots, ordinary logs and SSE/cancellation. The independent check fixed missed explicit monthly 429 verification with a full 100% snapshot, timer wakeups for disabled accounts, over-precise threshold input and a write-failure/expired-rule-cooldown path that could turn a protected local response into 500.
- Actual upstream HTTP 429 with explicit account quota evidence and redacted bounded content triggers one deduplicated refresh; only a **new** successful monthly snapshot below the strict global threshold installs the manual-release ban. A valid month-only partial may prove the month but not short-window recovery. Confirmed 5h/week holds require new complete positive three-window evidence; reset timers only recheck. The new owner uses existing `quotaJobs`/timer even with quota routing off. The old rule recovery cannot clear monthly bans; key/proxy edits fence short/pending facts while preserving manual ban.
- A metadata-write fault leaves the original file bytes intact and the current process blocks the affected account. The authenticated management projection reports `protectionPersistence: 'pending'`; the existing timer retries only the full metadata write with bounded backoff, and a later successful atomic write clears this marker and survives restart. **Unavoidable limit:** if storage stays unwritable and the process restarts before a successful write, that uncommitted ban cannot be recovered. Do not report pending as durable or restart production before repair/verification.

## Executed verification

- `node --test test/quota-protection.test.js` and relevant UI/admin/integration tests: passed in the implementation and independent check phases using temporary `DATA_DIR` and local mock upstreams. Fault injection includes failed rename, no upstream replay, another usable account, retry and restart boundary.
- `node --check server.js`, checks of `lib/*.js`, production HTML inline-script `vm.Script` compilation, `git diff --check`: passed.
- `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT -u CLINE_PASS_ADMIN_BOOTSTRAP -u CLINE_PASS_ADMIN_INIT_CODE -u CLINE_PASS_ADMIN_INITIAL_PASSWORD -u CLINE_PASS_ADMIN_PROXY_TOKEN npm test`: 270/270 in final independent check.
- Real local Chrome headless at 390 CSS px loaded the production HTML from a local file with a synthetic account. A visible “解除月额度封禁” native button accepted focus and keyboard Enter, opened a native confirmation warning of repeated quota failures, and after acceptance sent exactly one synthetic `/api/accounts/quota-recover` call for the selected stable ID; document width stayed 390px. This is a UI interaction smoke, **not** authenticated end-to-end, screen-reader behavior or production evidence.

No production account, real credential, paid upstream or deployment used. Production remains on `c35cd74`; this feature is local code only until a separately authorized release.
