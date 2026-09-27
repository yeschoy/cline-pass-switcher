# Design: longer generated extra client keys

## Boundary and choice

- Change only extra-key create/rotate generation in `server.js` to one shared helper producing `cps_` + `crypto.randomBytes(48).toString('hex')` (100 total ASCII characters, 384 random bits). The existing 68-character/256-bit format is already cryptographically strong; the extension honors the user's explicit length preference. Do not add a persisted length setting, new endpoint, dependency, account-key generator or regex that rejects old 68-character keys. Keep server-generated-only name/empty-body API shapes and the existing 16–256-character canonical validation.
- Preserve atomic config writes and independent admin Cookie/CSRF checks. Return the new value only from a successful create/rotate response; `GET /api/security/client-keys` remains label-only. Existing credentials stay valid across restart/deploy; an explicit admin rotation replaces only that owner's secret and invalidates its new admissions, while already leased requests and account ownership follow existing rules. No automatic live/production rotation.

## Console and tests

- Reuse the existing one-time secret owner and `clientKeyWrite` lifecycle. Replace `#clientKeySecret` single-line readonly input with a readonly multiline textarea sized to show a 100-character value on desktop and narrow screens, with wrapping and optional internal scrolling; do not write the key into `innerHTML`, labels, status text or another state owner. Existing `.value`, clipboard `.writeText()`, `.select()`, close and focus callbacks remain the owners. Do not mask/truncate the actual copied text. A failed list refresh must leave the already-accepted new value visible; a 401/navigation/dismissal clears it as before.
- Update create **and** rotate integration assertions to the 100-character format; test old-format persisted fixtures still authenticate and are not migrated, and new credentials work through both client Header forms. Run focused VM/UI tests and real-browser modal focus/wrapping/copy fallback at narrow width. Synchronize `README.md` and reusable client-key/frontend specs; no config schema change or production setting is needed.

## Rollback

Reverting the generator affects future new/rotated keys only; already generated 100-character values remain valid under the unchanged 16–256-character parser. Rollback of UI to a single-line input reduces visibility but must not change accepted secrets. Do not rotate deployed keys as part of code rollback.
