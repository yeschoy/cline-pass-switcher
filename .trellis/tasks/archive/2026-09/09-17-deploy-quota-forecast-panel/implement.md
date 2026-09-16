# Implementation Plan

## 1. Local committed-source gate

- Record `HEAD`, branch and source file hashes.
- Confirm product/deployment allowlist paths are clean relative to `HEAD`; unrelated dirty Trellis/tooling paths remain excluded.
- Run the full repository test suite against the committed application/test files and `git diff --check` for deployment-relevant paths.
- Generate a unique white-listed `git archive HEAD` tar and its SHA-256.

## 2. Read-only production preflight

- Validate the exact SSH identity path, gitignore, mode and non-interactive connectivity.
- Capture current release/image/container health, restart/OOM state, disk capacity, compose/deployment hashes, config hash, metadata hash, account count/mode and safe API baseline.
- Probe public ingress/DNS before switching.
- Stop before upload or mutation on any SSH, source, disk, current-health or identity failure.

## 3. Install immutable release and backups

- Upload the archive to a unique temporary file.
- Refuse overwrite of an existing release.
- Extract into `/opt/cline-pass-switcher/releases/<release>` and verify key hashes.
- Create versioned backup/verification directories and copy compose, deployment, config and metadata.
- Generate and validate a compose candidate whose only semantic changes are image tag and build context.

## 4. Direct full switch

- Atomically replace compose with the reviewed candidate.
- Run `docker compose -f compose.yml up -d --build` once; do not create canary traffic or a second production route.
- Wait for bounded running/healthy state.

## 5. Post-switch verification or rollback

- Verify image/restart/OOM/startup logs.
- Verify local and authenticated API gates, invalid quota-refresh rejection, internal alias, served HTML forecast marker, unchanged account count/mode and exact config hash.
- On any hard failure, restore config bytes if unexpectedly changed, restore old compose, start the previous release, and require it healthy.
- On success, atomically update `deployment.json` and save a safe report with hashes and gate facts.
- Preserve every release/image/backup/log/cache artifact.

## 6. Task evidence

- Save a secret-free deployment report under this task's `research/` directory with release/source, before/after state, verification results, rollback readiness and residual public-ingress status.
- Run a final read-only delayed stability check before reporting success.

## Rollback Point

The last pre-switch rollback point is the versioned compose/config/metadata/deployment backup plus previous release/image identity. No production traffic change occurs before that evidence exists.
