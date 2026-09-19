# Production deployment plan

## 1. Source gate and read-only preflight

- [ ] Prove clean committed source is local/remote `main@9ecc84d`; task files remain outside archive.
- [ ] Run committed-source syntax, UI script compilation, full `npm test`, and diff check.
- [ ] Verify fixed identity path, gitignore, mode 0600, BatchMode SSH, host Python/Docker/Compose.
- [ ] Collect safe current production container/deployment/hash/config/statistics/provider-health/log/API/internal/public projection.
- [ ] Freeze unique release name and all local source/archive hashes.

Stop if source, identity, SSH, current health, helper runtimes or disk gates fail.

## 2. Install immutable candidate

- [ ] Prove release/upload/verification/candidate paths do not exist.
- [ ] Upload allowlisted archive and verify local/remote SHA-256.
- [ ] Extract with release modes 0755/0644 and verify members/key hashes.
- [ ] Generate candidate Compose with exactly image/context changes.
- [ ] Build once via candidate Compose and capture exact image ID/modes.

Stop point: live Compose/data/container remain unchanged.

## 3. Copied-data production-hardening rehearsal

- [ ] Copy current config/metadata/ordinary logs into private verification layout.
- [ ] Start exact image as 1000:1000 with production hardening and isolated network.
- [ ] Require startup marker, container/API readiness and ordinary-log recovery.
- [ ] Compare safe config projection/hash; reject unapproved semantic changes.
- [ ] Verify metadata changes are limited to declared provider-health normalization and preserve statistics/quota/model facts.
- [ ] Restart against copied migrated data and prove idempotence.
- [ ] Record predicted live config hash and safe migration evidence.

## 4. Final freeze, backup, and rollback proof

- [ ] Refreeze live dynamic hashes; rerun prediction if data changed.
- [ ] Back up compose/deployment/config/metadata/logs and create manifest.
- [ ] Verify previous exact image remains inspectable.
- [ ] Exercise atomic install/restore helpers on private scratch files.
- [ ] Prove pre-mutation failure path is a no-op for the healthy old container.

## 5. No-build switch

- [ ] Atomically install candidate Compose and any exactly predicted config migration if required.
- [ ] Run Compose `up -d --no-build`.
- [ ] Require candidate exact image, running/healthy, restart=0, OOM=false, source hash and config hash.
- [ ] On a hard-gate failure, execute drift-guarded no-build rollback and verify old service recovery.

## 6. Immediate, delayed, and independent gates

- [ ] Check local meta and authenticated accounts/models/statistics/request/error/detailed-settings APIs.
- [ ] Check invalid quota-refresh returns 400 without real model traffic.
- [ ] Check UI/source markers for singleton provider, provider health/cooldown, 429 classification, affinity/content/detailed logging.
- [ ] Check `new-api → cline-pass-switcher` internal alias.
- [ ] Check public DNS/HTTP relative to pre-switch baseline.
- [ ] Wait 90 seconds; repeat image/health/restart/OOM/config/API/log gates.
- [ ] Run a fresh independent read-only postcheck.
- [ ] Atomically update `deployment.json` with safe facts and rollback reference.

## 7. Record and finish

- [ ] Persist deployment report plus bounded JSON evidence under task `research/`.
- [ ] Validate JSON, scan evidence for credential patterns, run `git diff --check`.
- [ ] Commit Trellis task evidence on `main`, then archive and record journal.
- [ ] Push evidence commits to `origin/main` without force.
- [ ] Keep production releases/images/logs/backups/evidence.
- [ ] Ask before deleting local/remote temporary upload artifacts; never delete Trellis evidence.

## Immediate rollback

1. Confirm the live compose/config/image still belong to this candidate and no unknown operator drift exists.
2. Restore backed-up config/metadata/logs/compose/deployment atomically.
3. Start the old exact image with `docker compose up -d --no-build`.
4. Require old image, healthy, restart/OOM, config hash and local/auth/internal API recovery.
5. Retain failed candidate release/image/logs/backups and all evidence.

## Completion status

- Release `20260919-193220-9ecc84d-provider-health` is deployed from `origin/main@9ecc84d`.
- Exact image is `sha256:52664183bc13d52828051a066b1de549500ebabdb394ae71492225f16f75154f`.
- Copied-data rehearsal normalized 78 provider-health rows only, kept config/logs unchanged, and was idempotent on the second start.
- Immediate, 90-second delayed, and independent gates all passed; container is healthy with restart 0 and OOM false.
- Authenticated APIs and the `new-api` internal alias passed; public DNS remains the pre-existing unavailable dependency.
- No real model request, business configuration change, NewAPI/CPA change, or production artifact pruning occurred.
