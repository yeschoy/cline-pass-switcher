# Multiple client API keys with exclusive account pools

## Goal

Allow independent downstream model-client keys; give each saved upstream account exactly one owner key, so authenticated traffic only schedules that key's pool. Keep the administrator session/password independent.

## Existing contract

`proxyKey`/effective `PROXY_KEY` authenticates all model/chat aliases; empty key preserves open model traffic (`server.js:1935-1942,4588-4599`). `PROXY_KEY` env overrides persisted value at startup (`server.js:1186`). The administrator cookie/CSRF does not rely on client keys after initial migration. `POST /api/accounts` replaces the full account list; existing pipeline/cache/session-binding and retry paths assume a global pool. The user accepted exclusive account ownership, with all old accounts assigned to the current legacy key.

## Requirements

- Add/label/rotate/revoke multiple bounded client keys through authenticated administration, without exposing new key material in public metadata, ordinary/detailed diagnostics or normal list responses. Keep old Bearer and client-only `X-Admin-Key` compatibility; no client key grants management access. Validate duplicate IDs/secrets/names and unknown owners before persistence.
- Each account has a stable key-owner ID. Old config/env migration puts every existing and environment-injected account under current legacy key; old full saves omitting owner preserve it by stable account ID; a new account defaults explicitly to a valid selected/default key. Key deletion with attached accounts must fail until accounts are reassigned; key rotation preserves owner ID. Reject unassigned/unknown IDs, fail closed for a valid key with no eligible accounts and never borrow another key, including sticky binding, cache pool standby, provider retry and allowed pre-stream account replacement.
- Security UI lists key labels and account assignments, supports safe create/copy-once/rotate/revoke confirmation, and preserves hidden account fields across filters/drafts/full saves; show env-pinned legacy key precedence clearly. Existing single-key installations keep working across restart, including empty-key legacy behavior until explicitly changed.
- Keep management probes/test with explicit account ID admin-authorized; audit `/v1/models` and other model aliases for key scope without changing independently authenticated admin routes. Rotate/revoke immediately blocks new admissions; already leased work may complete on its original owner.

## Acceptance criteria

- [ ] Synthetic multi-key integration covers non-stream/SSE/first-event retry/same-session collision, every relevant scheduler mode/pool, empty pool, blocked account, concurrent in-flight revocation and both model auth header forms; no cross-owner upstream attempt.
- [ ] Legacy config/env precedence, successful/malformed migration, old-client account/security save, reboot and key reassignment/rotation/revoke keep config bytes safe and stable account IDs; no orphaned accounts or dangling bindings.
- [ ] Auth/CSRF/role, ordinary/detail logging and credential-redaction tests prove new key cannot manage, cannot appear in diagnostics, and client credentials never become upstream Authorization. Browser draft/keyboard/confirmation tests exercise management UI.

## Out of scope

Cross-key account sharing, per-client-key RPM caps, independent admin accounts, production credential rotation/deployment and real upstream tests.
