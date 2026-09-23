# Production Deployment — Integrated Diagnostics, RPM, Low-Quota Pool and New API Chat

## Outcome

**Succeeded** on the canonical `ubuntu@167.114.158.4:49555` host. No live/paid model request, New API change, or production-data upload was made. Release/image/logs/backup/build cache were not pruned.

- Source: committed `origin/main` = `2431d5b8c89c7a79a72e1cb8b6b893eb9c7eabe1` at release creation and switch; working tree clean; full gate **242/242**.
- Immutable release: `20260923-085128-2431d5b8-integrated` under `/opt/cline-pass-switcher/releases/`.
- Allowlisted Git archive SHA-256: `506556034ca2a2b10843cbaa35b6e2947e8d31fd1981847b7c1ef25a80f06b73` (14 regular/directory members, no operator data or identity file).
- Exact Compose-built image: `sha256:a8468d22c002c3bbe03479248a915d6e1f63fbb0c31dce9207d436a61d8a97ee`.
- Previous exact image: `sha256:9e852b57984076f583715414138993dadf5be747c46ae4a4b27292d31509bcc3` (`20260921-061841-16c3b966-error-detail`); retained for rollback.
- Candidate Compose changed only `image:` and `build.context:`. Extracted release directories/files normalized to 0755/0644; the built `/app` source modes and `server.js`/`public/index.html`/three `lib` hashes matched committed source under hardened UID/GID 1000:1000.

## Preflight and reversible preparation

- Canonical SSH identity mode 0600 and gitignored; host Python3/Docker Compose available; filesystem had ample space. Pre-switch old container `running/healthy`, restart 0, old exact image present.
- Pre-switch local `/api/meta`, authenticated accounts/models/statistics/request/error/detail settings and malformed quota-refresh gates were 200/400; `ai-internal` alias was 200. The public hostname was **already degraded**: deploy host DNS could not resolve it, independent local client got a connection reset.
- Two preparation failures were confined **before live mutation**: Python `tarfile` normalized `lib/`/`public/` names without trailing slashes; an overstrict candidate Compose assertion compared one changed field without normalizing the other. Both were corrected only after proving the live Compose/config/container were unchanged. The first failed before release/backup creation; the second failed after release and private backup preparation but before candidate Compose generation. The old container remained exact healthy throughout.
- Source archive verified by SHA-256 and exact member/type allowlist before extraction. Candidate Compose passed exact two-field canonical comparison. Private same-directory atomic install/restore self-test passed. Deliberately passing a wrong candidate hash to the live-switch script exercised its **pre-live no-op guard**, leaving the old container healthy and Compose/config hashes unchanged.

## Copied-data migration and rollback rehearsal

- Root-private backups include original Compose, deployment state, config, metadata, ordinary logs and detailed logs. Fresh `backup-final` immediately before switching: `/opt/cline-pass-switcher/deployments/20260923-085128-2431d5b8-integrated/backup-final`. Ordinary/detailed operator data remained in the mounted `data/` volume.
- Isolated current-config/metadata/log copies ran the **exact Compose-built image** twice with UID/GID 1000:1000, read-only root, dropped capabilities, no-new-privileges, tmpfs and no external network. Startup marker and `/api/meta`, authenticated accounts/statistics/request logs/detail settings all passed; second config normalization was idempotent.
- Original config SHA-256: `f871daeb5d8d8e4c78193d5ad28b91d8718b22380684f0ce9ce730343e58df26`. Copy-predicted and final live SHA-256: `83d2fe1ec39266bd8941dcbe7c3da438c1302982d836295cb78ab0ffd913b1b0`. Structural comparison found **16 expected additions only**: `accounts[*].maxRpm`, `accountPipeline.cachePoolMaxSize/cachePoolLowQuotaSize/sessionBindingExplicitTtlMs/sessionBindingFallbackTtlMs/sessionBindingMaxEntries`, and `retryRules`; no existing operator value changed. Runtime target normalized to `cachePoolTargetSize=5`, with low slots off by default.
- Live metadata legitimately changed while the old service continued running; both initial and fresh pre-switch copies were retained, never restored over live data. A separate isolated rollback rehearsal proved the previous image starts with **original config + migrated metadata**, so an actual rollback can restore original config while preserving live metadata if still compatible. Backup metadata is retained as fallback. No live rollback was needed.

## Exact switch and gates

- Atomically installed candidate Compose, then `docker compose -p cline-pass-switcher --project-directory /opt/cline-pass-switcher -f /opt/cline-pass-switcher/compose.yml up -d --no-build`. No rebuild occurred during switch.
- Immediate and **90-second delayed** gates each required captured exact image ID, `running/healthy`, restart 0, original account count 10/enabled 8/sticky, 6 error rules, detailedLogging true/errorDetailLogging false, copy-predicted config hash, local `/api/meta` 200, authenticated accounts/models/statistics/request/error/detail APIs 200, malformed quota-refresh 400, and internal `ai-internal` alias 200.
- A fresh independent read-only postcheck repeated image/health/restart/OOM and source hashes, config/target/schema/operator counts, startup-marker/fatal-log check, backup and previous image presence. All passed: zero restarts, OOM false, no fatal startup markers.
- Public ingress remains **not verified/available** after switch: deploy-host DNS still unresolved and independent local client still gets a connection reset. This was reproduced before switching, so it was not reclassified as a release regression. No real New API/Cline topology, Docker E2E Chat or paid model traffic was exercised.
- Root-private `/opt/cline-pass-switcher/deployment.json` was atomically updated with safe release, commit, image, config/archive/source hashes, previous release/image, backup path and verification flags; no secret values are in this record.

## Rollback and residual risk

Rollback is from the retained `backup-final` and previous exact image via `up -d --no-build`. The tested guard refuses automatic restoration if live Compose/config/deployment drift outside this operation's candidate/backup hashes; it does not stop a still-healthy old container on a pre-live preparation error. A rollback after this release must check current operator drift first; the original config backup is necessary because the old binary may not understand newly normalized config fields. Keep metadata/log backups and preserve any post-switch facts when safe. The public DNS/connection-reset issue needs separate ingress investigation. Do not prune production backups, images, logs or releases as part of this task.
