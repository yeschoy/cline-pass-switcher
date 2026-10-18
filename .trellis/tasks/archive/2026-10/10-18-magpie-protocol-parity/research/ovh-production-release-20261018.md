# OVH production release: magpie protocol parity

## Running release

- User requested deployment of merged `main` containing the three-protocol Magpie-aligned edge work.
- Source: clean `main` commit `b54c8b3fb8ba1c45e1655c1e3ec54cd66f5ff292` (equals `origin/main` after push). Local suite **550/550** before release.
- Release `20261018-b54c8b3-magpie-protocol` / image `sha256:7295ee34c4361c1b02d88c9e7b094335c8c947a62c94f98c506d52e37cbb8e91`.
- Allowlisted archive SHA-256 `1c718f99360da23661b8fd7d65116d15d9922d1a21ac9234e53137005e8020ed`. Extracted/in-image hashes for `server.js`, `public/index.html`, `lib/account-workflow.js` matched HEAD. Compose change was image tag + build context only; switch used `up -d --no-build --no-deps`.
- Previous release `20261018-ac4ea23-circuit-502` / `sha256:b2e8d26f9a46758b3969da02530ff5e83bcf1f8d1fe261fd1510a66bcda1e993` retained.

## Migration / backup

- No config schema migration: private-copy candidate startup left `config.json` digest unchanged (`79b67aa09a6e359e799cd62c48c5c70cd38ca05633fc7cbbbc94bd59d69029ff`). Workflow stayed enabled (`healthFilter` true, `minimumHealth` 0.2). Statistics remained v6. Exact previous image read back the unchanged copy.
- Private pre-switch backup of Compose, deployment record, config, metadata, admin-auth, admin.env and gateway; raw detailed groups excluded. Atomic install/restore scratch passed.

## Machine verification

- Container healthy, zero restarts/OOM, UID1000, read-only root, CapDrop ALL, 1 GiB memory.
- Local gateway/app/console `/api/meta` 200; internal alias 200; independent public HTTPS `/api/meta` 200 (from deploy host `curl`; local urllib saw Cloudflare 403).
- Client-key-only management routes returned 401 (negative check only).
- `deployment.json` status: `awaiting-admin-acceptance` (no independent admin session for positive protected-view reads).
- No paid model request, policy change, raw capture enablement, or cleanup.

## Scripts

Reused adapted copies under sibling archive `10-18-request-log-target-vs-actual/research/deploy/` (no-migration rehearsal, stats v5|v6, workflow-enabled preservation, 1 GiB memory gate in postcheck).
