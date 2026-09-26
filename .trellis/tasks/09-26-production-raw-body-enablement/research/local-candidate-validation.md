# Local code-candidate validation (2026-09-26)

**Scope:** local source candidate `a8fb4da` on `feat/raw-detail-safe-headers` based on `main` `9aaa691`; no deploy, push, production access, memory/flag change or raw setting write. New raw Header projection is bounded by fixed names and canonical structural values; `Authorization`, `Cookie` and `Set-Cookie` names have only `[REDACTED]` values. Arbitrary/custom names and values are omitted. Sanitized legacy capture and raw body budgets/retention remain unchanged. An independent Trellis check corrected fixed sensitive Header-name visibility and prevented oversized explicit response Headers from falling back to normalized values; synthetic regressions were added.

**Observed checks:**
- `node --test test/raw-detail-headers.test.js test/raw-detail.test.js test/detailed-log-capture.test.js test/detailed-log-store.test.js test/detailed-log-ui.test.js test/ui-contract.test.js test/admin-auth.test.js`: **120/120 pass**.
- `node --check server.js`, `for file in lib/*.js; do node --check "$file"; done`, and VM compilation of the production inline script: pass.
- `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test`: **344/344 pass** (includes integration).
- `git diff --check` and `task.py validate` on this task's context manifests: pass.
- Local real Chromium 390px synthetic fixture: passed native confirm cancel/accept, one CSRF POST, safe selected Headers, body on-demand, keyboard focus, navigation/401 clear. Reproduction and caveats: `raw-ui-browser-check.py`, `raw-ui-browser-evidence.md`.

**Not verified / blocked for production:** exact committed candidate image under >=2 GiB hardened cgroup and concurrent 35 MiB/SSE/slow-admin load, measured memory headroom, actual private backup exclusion/expiry, migration and old-image rollback on copied state, authenticated production browser acceptance, and a separately approved live cutover. Existing release's `awaiting-admin-acceptance` and opaque config hash drift remain independent and unresolved. Production raw remains false per last documented read-only baseline; this session did not re-read production. Local headless browser evidence does not prove production auth or responsive behavior at every width.

Focused/full temporary stdout logs are under `/tmp/cps-raw-focused-check.log` and `/tmp/cps-raw-full-check.log`. They are non-business intermediates; do not remove without operator cleanup consent at wrap-up. No production raw body or credential was copied into task artifacts.
