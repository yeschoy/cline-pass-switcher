# OVH production release: request-log UI (target/actual/usage + light theme)

## Running release

- User requested deployment. Source was pushed clean `main` commit `db9f4b260c57841c19da2fea5a58804b3b7eb842` (fast-forward from `feat/request-log-target-vs-actual`). Local suite passed 513/513 before release.
- Release `20261018-db9f4b2-request-log-ui` / image `sha256:a293cb1f1447f246cfe0974ed3e599074c5e6d634e14b68b0ed4928f2e5f9341`.
- Allowlisted archive SHA-256 `b96c9e4ee468a289a76abbe13e2672dae4e140a853fc1fdc280d6cb79fb5db6a`. Extracted/in-image hashes for `server.js`, `public/index.html`, `lib/account-workflow.js` matched HEAD. Compose change was image tag + build context only; switch used `up -d --no-build --no-deps`.
- Previous release `20261018-4fbe782-html429-acct` / `sha256:53337e02b09983e9895268f2ce27a69544e54c835891390f9f61f3dcf944caa7` retained.

## Migration / backup

- No config schema migration: private-copy candidate startup left `config.json` digest unchanged (`fef5128b06a7b23bba93715f8478a29f3363436b701b32bfa5d66a8bf6993cd8`). Workflow stayed enabled (`healthFilter` true, `minimumHealth` 0.2). Statistics remained v6. Exact previous image read back the unchanged copy.
- Private pre-switch backup of Compose, deployment record, config, metadata, admin-auth, admin.env and gateway; raw detailed groups excluded. Atomic install/restore scratch passed.

## Machine verification

- Container healthy, zero restarts/OOM, UID1000, read-only root, CapDrop ALL, 1 GiB memory (production limit; not 512 MiB).
- Local gateway/app/console `/api/meta` 200; internal alias 200; independent public HTTPS `/api/meta` 200.
- Client-key-only management routes returned 401 (negative check only).
- `deployment.json` status: `awaiting-admin-acceptance` (no independent admin session for positive protected-view reads).
- No paid model request, policy change, raw capture enablement, or cleanup.

## Scripts

Adapted copies under `research/deploy/` (no-migration rehearsal, stats v5|v6, workflow-enabled preservation, 1 GiB memory gate).
