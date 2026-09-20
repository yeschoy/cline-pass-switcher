# Production deployment plan

## 1. Planning/source gate

- [x] Validate task context and commit planning/activation metadata.
- [x] Push local `main`, then prove local `main == origin/main` and required feature/spec commits are ancestors.
- [x] Run syntax, embedded UI script compilation, full `npm test`, JSON parse and `git diff --check` against committed source.
- [x] Verify archive allowlist, key source hashes, identity exact path/gitignore/0600 and BatchMode SSH.

Stop before remote mutation if any source/identity/test gate fails.

## 2. Read-only production preflight

- [x] Verify host helper runtimes, Docker/Compose, disk and fixed target.
- [x] Freeze current release/exact image/container health/restart/OOM and old-image availability.
- [x] Freeze Compose/deployment/config/metadata/log hashes and safe config/statistics/state counts.
- [x] Check local/authenticated APIs, internal alias and public DNS/HTTP baseline without exposing credentials.
- [x] Persist bounded `current-production-preflight.json`.

## 3. Immutable candidate

- [x] Freeze unique release name and committed archive/source hashes.
- [x] Prove upload/release/candidate/verification paths do not exist.
- [x] Upload/verify/extract allowlisted archive; normalize and verify 0755/0644.
- [x] Generate candidate Compose with exactly image/context changes.
- [x] Build once through candidate Compose and capture exact image ID/modes.

Stop point: live Compose/data/container remain unchanged.

## 4. Copied-data hardening rehearsal

- [x] Copy current config/metadata/ordinary logs into private verification layout.
- [x] Start exact candidate as 1000:1000 with production hardening and isolated network.
- [x] Require startup/API/log recovery readiness without real model traffic.
- [x] Compare frozen input/output safe projections for canonical rule, pipeline, statistics v4 and state migrations.
- [x] Prove account/route/network/scheduling/quota/model facts and log bytes are preserved.
- [x] Restart candidate against migrated copy and prove byte-idempotence.
- [x] Record predicted post-switch config hash and bounded migration evidence.

## 5. Final freeze, backup and rollback proof

- [x] Refreeze live hashes; if dynamic inputs changed, repeat prediction from the new frozen copy.
- [x] Back up Compose/deployment/config/metadata/ordinary logs and hash manifest.
- [x] Verify previous exact image remains inspectable.
- [x] Exercise atomic install/restore helpers on scratch files.
- [x] Prove pre-mutation failure path leaves the healthy old container/image/hashes unchanged.

## 6. No-build switch and gates

- [x] Atomically install candidate Compose and run `docker compose up -d --no-build`.
- [x] Require candidate exact image, running/healthy, restart=0, OOM=false, source hash and predicted config hash.
- [x] Validate schema/safe counts, bounded logs, local/authenticated APIs, invalid quota-refresh 400, internal alias and UI/source markers.
- [x] Compare public ingress with pre-switch baseline.
- [x] Wait 90 seconds and repeat critical gates.
- [x] Run fresh independent read-only postcheck.
- [x] On hard failure, execute drift-guarded data/Compose/deployment restore and old-image no-build rollback.

## 7. Record and finish

- [x] Atomically update remote `deployment.json` only after all gates pass.
- [x] Persist deployment report, bounded JSON evidence, attempts and rollback reference under task `research/`.
- [x] Validate evidence JSON, scan for secret-shaped content and run `git diff --check`.
- [ ] Run full Trellis check, commit deployment evidence, archive, journal and push without force.
- [x] Keep production release/image/cache/log/backup/evidence.
- [ ] Ask user before deleting local/remote non-business temporary files; Trellis evidence is retained.

## Immediate rollback

1. Verify live Compose/config/image still match this deployment's candidate and there is no unknown drift.
2. Restore backed-up config/metadata/logs/Compose/deployment atomically.
3. Start the previous exact image with Compose `up -d --no-build`.
4. Require previous image, healthy, restart/OOM, config hash and local/auth/internal API recovery.
5. Retain failed candidate release/image/logs/backups/evidence.
