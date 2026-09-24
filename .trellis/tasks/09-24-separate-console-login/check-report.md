# Independent admin login — local check report

## Scope / evidence

- Branch: `feat/separate-console-login`, based on `main` commit `9c61b60`. No deployment, no production credentials/data or paid upstream used. Parent/sibling Trellis task directories remain planning/untracked and are not this child's implementation target.
- New admin state: strict `DATA_DIR/admin-auth.json` with 0600 salted scrypt verifier, explicit bootstrap flag and private independent code. Separate admin Cookie/CSRF/route guard replaces shared-key management access; client model routes retain their previous key behavior. A proxy token plus Host/Origin/TLS marker authenticates an approved remote HTTPS terminator. Existing detailed capture pauses until first password change.
- Production console deletes `localStorage.cps_key`, uses same-origin in-memory CSRF + HttpOnly Cookie, handles pending-session expiry and hides previous content behind an opaque topmost login overlay. README, Compose/Caddy and English executable specs include initialization/rollback gates.

## Verification performed

- `node --test test/admin-auth.test.js test/admin-ui.test.js test/ui-contract.test.js`: **21/21 passed** after parent fixes. Includes concurrent 12-login throttle, route denial, pending expiry, proxy spoof and API-key equality at restart.
- `node --check server.js`; `for file in lib/*.js; do node --check "$file"; done`; production inline `<script>` compiled with `vm.Script`: passed.
- `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT -u CLINE_PASS_ADMIN_BOOTSTRAP -u CLINE_PASS_ADMIN_INIT_CODE -u CLINE_PASS_ADMIN_INITIAL_PASSWORD -u CLINE_PASS_ADMIN_PROXY_TOKEN npm test`: **258/258 passed**.
- `docker compose -f docker-compose.yml config -q` and all-in-one config with a synthetic 64-hex token: passed syntax/interpolation check (not a running Caddy integration).
- `git diff --check`: passed; `task.py validate 09-24-separate-console-login`: passed with warnings that two large spec files exceed automatic context injection size. Read the needed full sections directly before edits.

## Remaining gates / risks

- **Real-browser local smoke performed** in isolated Chrome 154 headless via CDP and temporary `DATA_DIR` with a local mock catalog upstream (not production). Initial bootstrap page displayed and focused the password field; keyboard Tab moved through form controls. First-change form submitted successfully, then separate administrator login succeeded. At a true **375 CSS-pixel viewport**, measured `documentElement.scrollWidth=360 <= innerWidth=375`; opaque login overlay had `z-index:100` above drawers, dialog width 328, focused password on entry, Tab moved to the native submit button and wrapped to password, Escape did not dismiss it, and keyboard Enter submitted initialized login. Top-nav Enter activated statistics (`aria-pressed=true`) and the wide table remained in its scroll wrapper. `login-narrow-375.png` and `console-narrow.png` under `/tmp/cps-admin-browser.XqYAVP/` were visually inspected; scripts/screenshots are temporary local evidence retained pending operator-approved cleanup. The bootstrap password-change submission used `requestSubmit()` rather than a physical Enter key, so that exact first-change keystroke remains unverified.
- Native `agent_browser open` was unavailable (`missing-binary`) and Orca Computer Use could not read Chrome accessibility windows (`permission_denied` despite granted permissions); isolated Chrome CDP provided the real-browser fallback. Static/VM tests were not misrepresented as browser evidence.
- Actual Caddy/nginx TLS termination and proxy-token forwarding have not been observed against a deployed topology. These are mandatory deployment-time gates, as is private `admin-auth.json` backup/rollback rehearsal. No production operation is authorized by this code task.
- The proposed unredacted raw-body mode is **not implemented** in this child; completing authentication alone does not authorize raw production capture. Older releases regain their former shared-key management behavior on rollback and must not serve future raw detail bodies.
