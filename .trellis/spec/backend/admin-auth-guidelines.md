# Independent Administrator Authentication

> Executable contract for `server.js` management authorization and the static console login. Read with `database-guidelines.md`, `quality-guidelines.md`, and frontend `state-management.md`.

## 1. Scope / Trigger

Use this when changing a management route, client-key rotation, console `api()`, bootstrap, reverse-proxy deployment, or raw detailed-log access. The downstream model-client key must never grant management rights, even when no client key is configured. This is a migration from the former shared `X-Admin-Key` behavior; never add a compatibility bypass.

## 2. Signatures

```text
GET  /api/auth/state     -> { initialized: boolean, available: boolean }  // no session
GET  /api/auth/session   -> { ok: true, pending: boolean, csrf: string } // session required
POST /api/auth/bootstrap <- { password: string, code: string }           // one-time pending session
POST /api/auth/login     <- { password: string }                         // initialized only
POST /api/auth/password  <- { newPassword: string }                      // pending only
POST /api/auth/password  <- { currentPassword: string, newPassword: string } // initialized
POST /api/auth/logout    <- {}                                           // revoke one session
```

`adminTransportOK(req)`, `adminOriginOK(req)`, `adminSession(req)`, `adminAuthRoute(req,res,path)` belong to the server auth boundary; `admin-auth.json` belongs exclusively under `DATA_DIR`. `POST /api/security` may rotate the Legacy client key but never the admin verifier; additional keys are governed by [client-key-guidelines.md](./client-key-guidelines.md). No ordinary log, metadata, API projection, browser storage, response Header or service output contains a password, bootstrap code, session token or proxy attestation.

## 3. Contracts

- Exact `admin-auth.json`: `{version:1, initialized:boolean, salt:<64 lowercase hex>, hash:<128 lowercase hex>}`. A non-regular/symlink/permissive/malformed/unreadable existing file fails startup without overwriting bytes. Missing state leaves management unavailable, unless the operator explicitly sets `CLINE_PASS_ADMIN_BOOTSTRAP=1` with an independent 16–1024-character `CLINE_PASS_ADMIN_INIT_CODE` (not equal to the initial password). The pending verifier is derived once from the effective `PROXY_KEY` or, when it is empty, the separately configured nonempty `CLINE_PASS_ADMIN_INITIAL_PASSWORD`. Store only salted scrypt verifier with same-directory atomic replacement and mode 0600. Remove bootstrap env values after first change; normal restart does not reinitialize. An initialized verifier matching any effective nonempty client key fails startup, including the Legacy environment override.
- Bootstrap requires password **and** independent code, creates only a pending process-local session. Pending sessions can access `/api/auth/session`, `/api/auth/password` and `/api/auth/logout`, but no management route. The first password must differ from every configured client key and old password and have 12–1024 characters; successful atomic change clears *all* sessions and requires a fresh login. Later password changes require current password and likewise revoke all sessions. Bad candidates do not replace the admin file.
- Sessions are random process-local tokens, at most 128, with 8h absolute expiry (test override only in `NODE_ENV=test`). `cps_admin` Cookie is `HttpOnly; SameSite=Strict; Path=/api`, plus `Secure` for HTTPS. `GET /api/auth/session` returns in-memory CSRF token only to the owning Cookie. Unsafe admin methods require exact `X-CSRF-Token`; auth POSTs require `application/json` and a 4096-byte request cap. Login/bootstrap failures are throttled at 5 failures / 60s per socket address with bounded map size; check again after body admission before scrypt, because concurrent requests can pass the initial check. The reverse proxy should additionally rate-limit its public endpoint.
- `/api/meta` and `/` (static page with no sensitive embedded values) remain public. Model/chat aliases (`/models`, `/v1/models`, `/api/v1/models`, `/chat/completions`, `/v1/chat/completions`, `/api/v1/chat/completions`, `/v1/responses`) use only the downstream client key; empty Legacy preserves historical model openness **for Legacy-owned accounts only**, and extra-key creation is rejected while an anonymous Legacy-owned account remains. Model aliases and chat cannot borrow another owner's upstream account. Every other `/api/*` management route requires initialized admin session, including logs, statistics, configuration and tests. Management has `Cache-Control: no-store`, no wildcard CORS, and no management OPTIONS preflight; client-key `Authorization` and `X-Admin-Key` do not help. Capture of full/error detailed content is suspended before first password change, even if previously enabled; raw-body mode is a separate explicit default-off setting effective only after first password change and only for new detail captures. Client keys cannot read raw settings/list/detail/body; old shared-key rollback images must have management ingress isolated and must not traverse the private raw directory.
- Direct HTTP administration is allowed only from loopback with a loopback Host. Remote administration needs the configured HTTPS `PUBLIC_BASE_URL` equal to the browser's Origin/Host, a private/loopback socket peer, `X-Forwarded-Proto: https`, and a private 64-lowercase-hex `CLINE_PASS_ADMIN_PROXY_TOKEN` matched against a proxy-replaced `X-Cline-Pass-Proxy-Token`. Never trust private IP or a forwarding Header alone: another model client can reside on that same private network. Reverse proxies must **replace**, not pass through, both attestation Headers, and the app port must not be public. Actual TLS/proxy behavior needs deployment-time verification; local HTTP mocks do not prove it.
- The frontend removes legacy `localStorage.cps_key`; it keeps the CSRF token in memory, while the Legacy admin-only password field and newly revealed one-time extra key exist transiently in the DOM, never browser storage. Legacy `GET/POST /api/security` intentionally still returns its plaintext `proxyKey` to authenticated administrators; additional-key normal listings never return secrets. A 401 hides previous content behind an opaque login overlay above drawers/dialogs while preserving unsaved drafts for re-login; an expired pending bootstrap returns to password+code entry. Logout reloads after server confirmation; failures do not claim success.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Client key alone, missing/expired/pending Cookie, mismatched CSRF or disallowed Origin | `401`, no management work; public meta and correctly authenticated model routes keep their own behavior |
| Malformed existing admin state or unsafe file type/mode | Startup fails without changing original bytes; missing without explicit bootstrap stays 401 for management |
| Empty client key without separate nonempty initial password/code, equal code/password, invalid proxy token | No unsafe bootstrap/remote login; never an empty admin password or untrusted TLS claim |
| Login/boot wrong credentials, five failures in 60s, simultaneous bad submissions | Bounded 401 then 429, no unbounded scrypt work; no raw credential in logs |
| Wrong auth media/body shape, oversized auth body | 415 / 400 / 413, no state change |
| Old password, client-key-equal or short new password; failed atomic write | 400 or safe 500, previous persisted/admin session state remains authoritative |
| Initialized admin password equals client key after env rotation | Startup fails closed before serving traffic; operator corrects key in isolation |
| Cross-site or untrusted direct HTTP with forged forwarding Headers | 401, no cookie/session; no wildcard management CORS |

## 5. Good / Base / Bad Cases

- **Good:** on legacy deployment, operator provides independent private code; first remote HTTPS login uses effective client key + code, receives pending-only session, changes password atomically, then logs in again with new password. Existing client key cannot read `/api/accounts` or detailed bodies.
- **Base:** no admin state and no bootstrap flag: model proxy remains compatible, management is 401, and no detailed content is captured. Empty client key is not an empty admin credential.
- **Bad:** trusting `X-Forwarded-Proto` from any private peer, leaving `localStorage.cps_key`, re-deriving admin password from rotated client key on restart, or letting an expired pending dialog submit indefinitely.

## 6. Tests Required

`test/admin-auth.test.js` must assert the full route matrix, first-change gate, concurrent bootstrap, code replay denial, client-key rotation/startup equality, 0600 state/malformed/symlink preservation, empty-key initialization, strict JSON/body size, Cookie/CSRF/Origin/TLS-proxy-token denial, logout/restart/password-change revocation and throttling under concurrent failures. UI VM tests must exercise legacy storage deletion, CSRF, expired pending session recovery and opaque topmost login state; VM/static checks are **not** real-browser focus/keyboard/narrow-width evidence. Existing `test/integration.test.js` and sibling suites must use temporary `DATA_DIR` admin fixtures, while independent denial tests bypass fixture injection.

## 7. Wrong vs Correct

```js
// Wrong: sharing the downstream key lets every model client administer the service.
if (p.startsWith('/api/') && authOK(req)) return dispatchManagement();

// Correct: exempt only deliberate public/auth/model paths, then require a live
// independent initialized admin session and CSRF before management work.
if (managementRoute && (!adminState?.initialized || !adminSession(req) || !adminOriginOK(req)))
  return unauthorized(res);
```

A passing local mock does not authorize a production switch: rehearse the separate bootstrap secret, verified TLS proxy token, administrator file backup and rollback path against isolated data before deployment.
