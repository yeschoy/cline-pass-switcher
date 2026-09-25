# Exclusive Client-Key Account Pools

> Executable contract for downstream model authentication, private `config.json` inventory, scoped account leasing/catalog and independently authenticated key administration. Read with [administrator authentication](./admin-auth-guidelines.md), [persistence](./database-guidelines.md), [routing](./quality-guidelines.md), and frontend [state management](../frontend/state-management.md).

## 1. Scope / Trigger

Use when changing `clientKeyInventory()`, `clientKeyIdFor()`, account normalization/full saves, `/api/security/client-keys`, client model aliases, chat selectors, cache membership, stateful binding, catalog, diagnostics or rollback. `server.js` is the sole config/auth/scheduler owner; key ownership is **exclusive**, not account sharing or a per-key RPM limiter. Never conflate downstream `clientKeys[].key` with the account's upstream `accounts[].key` or with the independent administrator password.

## 2. Signatures

```text
config.json: { proxyKey: string, clientKeys: [{ id: string, name: string, key: string }],
               accounts: [{ id: string, clientKeyId: string, key: string, ... }] }
metadata.json: { cachePoolTargetSize: integer, ... } // one shared numeric target; no key secrets or member lists
PROXY_KEY: optional nonempty startup/restart override of effective legacy proxyKey
CLINE_PASS_KEY: optional injected upstream account, owned by legacy

GET    /api/security/client-keys             -> { keys: [{ id, name }] } // includes Legacy; no secrets
POST   /api/security/client-keys             <- { name } -> { id, name, key } // generated key once
PATCH  /api/security/client-keys/<id>        <- { name } -> { id, name }
POST   /api/security/client-keys/<id>/rotate <- {} -> { id, key } // generated key once
DELETE /api/security/client-keys/<id>        -> { ok: true }
GET/POST /api/security                      -> legacy proxyKey, publicBaseUrl, authRequired, exposeCatalog // compatibility
GET/POST /api/accounts                      -> accounts[].clientKeyId; POST replaces full account array

GET  /models | /v1/models | /api/v1/models
POST /chat/completions | /v1/chat/completions | /api/v1/chat/completions
POST /v1/responses // authenticated 501, no lease/network
```

All management operations require initialized non-pending admin Cookie, trusted transport/Origin and exact `X-CSRF-Token` for unsafe methods. Model routes accept `Authorization: Bearer <client key>` or legacy `X-Admin-Key: <client key>`, not administrator Cookie as model authentication. `GET /api/meta` remains public; `/api/models`, probes and tests remain independently admin-authorized.

## 3. Contracts

### Inventory and persistence

- `proxyKey` is the **only stored** Legacy secret (stable owner ID `legacy`); `clientKeys` contains **additional** records only, at most 16. `clientKeyInventory()` derives Legacy plus extras without a second stored Legacy secret. An extra ID cannot be `legacy`. IDs use `[A-Za-z0-9_-]{1,100}`, names are trimmed 1–80 characters without controls and unique case-insensitively including `Legacy`, and extra secrets are trimmed 16–256 characters without controls and unique against stored and effective Legacy and each other. Management creates random `ck_...` IDs and `cps_` plus 64 hex digits for new secrets; do not accept caller-chosen IDs/secrets on these routes. Any nonempty client key equal to the initialized admin verifier fails startup; new/rotated secrets and Legacy security edits may not equal the administrator password.
- A nonempty `PROXY_KEY` overrides the effective Legacy key **at startup/restart only**. A successful admin `POST /api/security` may change `config.proxyKey` and the running effective key immediately; the next restart reapplies a still-set nonempty environment value. Startup also rejects a stored Legacy/extra duplicate even if an environment override would conceal it. Missing JSON may use defaults; malformed/unreadable or invalid canonical inventory/owner state fails before normalization writes, preserving operator bytes. Persist validated complete candidates through the existing same-directory atomic `config.json` write *before* changing live key inventory or account ownership. Config contains plaintext private secrets, not encryption at rest.
- Legacy accounts (including migrated `apiKey` and injected `CLINE_PASS_KEY`) acquire `clientKeyId: 'legacy'`; stable account `id` remains the runtime join key. Startup rejects a newly injected Legacy account when Legacy is empty and additional keys exist, before any migration write; a nonempty `PROXY_KEY` startup override can authenticate that injection. On an old full-list `POST /api/accounts` omitting `clientKeyId`, an existing stable ID retains its current owner; newly created accounts get a valid default (`legacy` when effective Legacy is nonempty or it is the sole key, otherwise the first additional ID). The browser should explicitly select an owner. All accepted account references must point to inventory IDs. Deleting an attached additional key is a conflict until a **separate saved** account reassignment removes all attachments. Rotation changes secret, not owner ID. There is no extra-key route that deletes/rotates Legacy; retain the existing admin `/api/security` plaintext Legacy response for old clients, without exposing *additional* secrets on lists.
- An empty Legacy key retains historical anonymous access **only to Legacy-owned accounts**. With no additional keys the original open mode admits all model requests, even with conflicting/invalid credential Headers; once additional keys exist only a request with neither credential Header may enter anonymous Legacy, and invalid or conflicting supplied credentials return `401`. Creating an extra key while any Legacy-owned account remains anonymously accessible is rejected; first configure a nonempty Legacy key or reassign those accounts. Never convert anonymous access into a new-key pool. An additional key with zero eligible accounts is valid but cannot borrow anyone else's pool.

### Routing, catalogs and projections

- Resolve the authenticated request to a stable key ID at the model boundary; scope accounts *before* hard eligibility, mode ranking, active-index fallback, wait/recheck, RPM/concurrency permit, cache membership/growth/standby and allowed pre-output replacement. `single` uses the active account only when owned/eligible; otherwise the first owned eligible candidate. The six legacy modes and all-false pipeline retain their previous ranking **inside** the owned set. Stateful binding namespaces identical HMAC sessions by owner (Legacy retains its historical fingerprint), checks owner/active eligibility on hit and invalidates confirmed/provisional entries on reassignment/deletion/revocation. Provider retries stay on the leased account, first-event SSE errors may retry before output, and started streams/cancellations never replay. A valid secret with no eligible owned account returns `503`; owned candidates blocked by capacity/RPM yield scoped busy `429` when applicable. Recheck ownership and credential after waits; rotation/revocation immediately blocks new admission, but already leased work may finish on its original account. Never forward the downstream Authorization; `responseHeadersFor()` installs the selected account's upstream bearer.
- `META.cachePoolTargetSize` remains **one shared persisted number**, applied independently to each key's derived candidate set. Grow-one of the shared target can enlarge another owner's derived active membership but cannot select its accounts for this request. No persisted per-key target/member list, per-key limiter, second scheduler or binding store. `GET /api/accounts.cachePool.scope` is `per-client-key`; `actual` is the sum of derived active high/low/unknown counts, and each account's `cachePoolRole` is computed in its own owner pool.
- Client GET model aliases retain the global static known-model/alias ID union. With `exposeCatalog`, fetch extra upstream IDs only through an owned eligible account, with no foreign/synthetic/global-admin-cache fallback for an empty owned pool; scoped catalog cache is process-local. Admin `/api/models`, explicit account-ID probes/tests and existing ID-less global management selection do not inherit client scoping. A catalog read is not a native chat/RPM attempt.
- Normal key listing contains only ID/name; public metadata, statistics, ordinary JSONL, diagnostic metadata/Headers and sanitized detailed capture exclude all configured and still-in-flight client secrets. Sanitized redaction seeds include effective/stored Legacy and extra keys without relaxing bounded capture limits. Deliberately opt-in, default-off **raw body** capture may contain arbitrary caller-embedded secrets: do not promise arbitrary text redaction there. Raw client credentials must not become upstream Authorization or an ordinary log value. Administrator `GET/POST /api/security.proxyKey` is the narrow plaintext Legacy compatibility exception, not a public or additional-key list.

### Upgrade / rollback gate

An old binary is **unsafe on v2 DATA_DIR**: in a synthetic isolated rehearsal its startup and full account save dropped `clientKeyId`, and a Legacy request reached a foreign-owned upstream account. An atomic v2 write cannot protect against a permissive old parser. Before an authorized upgrade, fence writes and privately back up the **entire** pre-upgrade DATA_DIR (config, metadata, admin state and applicable logs/details), verify recoverability; retain a separate full v2 backup before any rollback. To roll back, isolate traffic/management and stop writes, preserve v2 data separately, restore the complete pre-upgrade state **before starting** the old image, verify image and data hashes/permissions and isolate old management/raw ingress. Never point old code at writable v2 data. Restored v1 need not understand v2-only keys, owners or post-upgrade history. Local mocks/rehearsal are not production validation or deployment authorization.

## 4. Validation & Error Matrix

| Input/state | Required result |
|---|---|
| Bad client credential, conflicting supplied Bearer and `X-Admin-Key`, or rotated/revoked secret with an authenticated inventory | `401` before account/network work; no alternative owner. The original **single-key empty Legacy** mode remains anonymously open even if Headers are invalid/conflicting |
| Client key on management without initialized admin Cookie/CSRF/transport | `401`; no management write, even when Legacy model traffic is open |
| Extra key create/rename with invalid/duplicate name, over 16 keys, malformed canonical ID/secret, duplicate effective/stored secret, or admin-password collision | Management `400` (persisted malformed state fails startup); preserve original config bytes and live inventory |
| Empty Legacy with a Legacy-owned account and attempted extra-key creation, or security edit reintroducing anonymous Legacy alongside extra keys | `400`; preserve state; anonymous clients cannot reach extra-key accounts |
| Empty Legacy plus extra keys and a newly injected `CLINE_PASS_KEY` Legacy account at startup | Fail before rewriting config; set a nonempty Legacy key/`PROXY_KEY` or remove the injection |
| Unknown account `clientKeyId`, duplicate/changed stable account ID, invalid complete account save | `400` before mutation; old existing-ID omission retains previous owner |
| Revoke an extra key still owning an account | `409`; no key/account change; save reassignment first |
| Rename, create, rotate, delete with failed atomic config replacement | Safe `500`; old bytes and in-process ownership/credentials remain effective |
| Valid key with no eligible owned account versus owned but busy pool | `503` versus bounded local `429` when applicable; zero foreign attempts |
| Explicit admin probe/test account ID across ownership | Remains independently admin-authorized; client credential alone cannot invoke it |
| Malformed existing config or canonical inventory/unknown persisted owner | Fail startup with original bytes intact; never repair by wiping owners |
| Old image starts on mutable v2 DATA_DIR | **Prohibited**; restore complete pre-upgrade backup in isolation before old startup |

## 5. Good / Base / Bad Cases

- **Good:** assign a new account to extra key B, save full account list, then B chats with its upstream credential; identical session under Legacy selects only Legacy-owned accounts. Rotate B: old secret gets `401` on new work, previously leased B stream finishes, new secret keeps B's owner ID and accounts.
- **Good:** a positive cache pool derives one active member in each owner's set at shared target 1; saturation in one set may increment target to 2, but no cross-owner attempt is made and admin actual counts sum the independently derived sets.
- **Base:** a single Legacy key with no `clientKeys` and accounts missing `clientKeyId` migrates to Legacy without changing stable account IDs. Empty Legacy continues anonymous model traffic to Legacy only, not management.
- **Bad:** key B's empty pool borrows global active account, a cached global catalog or a standby belonging to A; downstream `Authorization` becomes upstream bearer; or old code opens writable v2 state during rollback.

## 6. Tests Required

- `test/multi-client-keys.test.js` with temporary DATA_DIR/local upstream: old config/env migration/restart and old full save; key create/rename/rotate/delete and byte-preserving rejects; Bearer/`X-Admin-Key`, three chat and three model aliases, empty/disabled/blocked pools; six modes, same-session collisions, pipeline/cache role/target/growth/standby, owner-recheck on waits, provider retry, first-event and post-start SSE, cancellation, pre-stream replacement, in-flight rotation/revocation. Assert **zero foreign upstream attempts**, not just HTTP statuses; admin explicit-ID tests remain independent.
- `test/admin-auth.test.js`, `test/integration.test.js`, `test/account-draft.test.js`, `test/admin-ui.test.js`, `test/ui-contract.test.js`, logging/raw-detail suites: client-only management denial, Cookie/CSRF, Legacy plaintext compatibility, one-time secret display/clear, complete owner draft round-trip, absent secrets in public/ordinary/sanitized projections, upstream Authorization replacement; label deliberate raw-body exception. Browser focus/keyboard/native confirmation/narrow scrolling require real-browser evidence, not only VM/static checks.
- Isolated old-image rehearsal must explicitly test the **unsafe** old-on-v2 case only on a disposable clone, then restore complete pre-upgrade DATA_DIR before old startup and keep v2 backup intact. This is a rollback blocker and cannot be described as production verification. Run scoped Node tests and the full environment-scrubbed project gate before reporting a code change.

## 7. Wrong vs Correct

```js
// Wrong: a global fallback or post-selection owner check can leak a foreign lease.
const lease = await acquireAccountLease(identity);
if (lease?.account.clientKeyId !== clientKeyId) return retryWithGlobalPool();

// Correct: authenticate once, pass the owner to the *existing* selector,
// and recheck after waits before the final permit/lease. Never borrow another pool.
const identity = { ...extractSessionIdentity(req, body), clientKeyId };
const selected = await acquireAccountLease(identity, { ownerRequestId });
if (!selected.lease) return sendScopedUnavailableOrBusy();
```

Likewise, do not treat a v2 config as backward compatible merely because an old image boots: an old normalizer can silently strip owner fields and then send Legacy traffic to a different owner's upstream credential.
