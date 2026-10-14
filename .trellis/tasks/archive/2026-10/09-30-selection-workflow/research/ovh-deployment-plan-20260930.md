# OVH selection-workflow production deployment plan

Target: the canonical `ubuntu@167.114.158.4:49555` host and `/opt/cline-pass-switcher` installation. Authorized by the user's explicit deployment request. Source must be pushed, clean `main`; the current runtime source is `d4e0a2748e66b80b0b33796a1ec237ae67a3134c`. Do not send paid/live model requests, change saved workflow policy, enable raw capture, or clean release/backup/intermediate artifacts.

## Read-only baseline

- Local `main` equals `origin/main`; full committed-source suite passed 420/420 on 2026-09-30.
- SSH identity is the exact repository-local ignored mode-0600 file. Host has noninteractive sudo, Python3/PyYAML, Docker Compose 5.5.0, rsync and free disk space.
- Current live release is `20260929-1910b66-diagnostics-2`, commit `1910b6616174abda5172509f11451fd9d2f84cc7`, image `sha256:30491891ef2da9471fea4ba04d4612f8db6ab9b161d45a4fcfd775a691471c77`; container running/healthy, zero restarts/OOM, 512 MiB and hardened UID1000 runtime.
- Live config has 51 accounts, sticky mode, cache min5/max100 and target18; no `accountWorkflow` field or counter snapshot, statistics v5, raw body capture off. Current `deployment.json` remains `awaiting-admin-acceptance` from the prior release. Public and host-local `/api/meta` returned200 before changes.
- The candidate differs from that live commit only in guided workflow source/UI/docs; new startup normalization will add a disabled workflow field and an authoritative counter snapshot. Pre-switch copy rehearsal must predict exactly these safe schema effects and prove the exact old image can read the migrated copy before a compatible rollback path is accepted.

## Ordered gates

1. Verify source and identity once more. Produce a SHA-256 recorded allowlisted `git archive HEAD` with a unique release name. Upload only that archive, never the working tree or private identity.
2. Create a root-private stage on the target without changing live Compose/data. Verify uploaded archive hash, extract to a new immutable release, normalize directory/file modes0755/0644 and compare critical source hashes to local HEAD.
3. Create a candidate Compose by changing only the image tag and build context. Compare parsed Compose structures after removing just those two fields; build with this exact candidate Compose, capture the image ID and verify source modes inside the image as UID1000.
4. Copy only required non-raw operator state to a root-private isolated data directory; retain original bytes. Start the exact candidate image without a network under production user, memory limit and hardening. Verify startup, projected account IDs/owners, disabled workflow, statistics and predicted config/counter migration. Boot the exact prior image on a separate copy of the candidate-migrated state, also without network. A failure or incompatible parser means no live switch under the ordinary rollback contract.
5. Before live mutation, prove old container/image/Compose/config hashes still match baseline, create and verify private backups of Compose, deployment record, config, metadata, admin state and applicable env/gateway sidecars (never raw detailed groups), and test atomic Compose install/restore on scratch files. Preserve current live config on any drift and rehearse a fresh snapshot.
6. Atomically install candidate Compose, switch with `docker compose up -d --no-build --no-deps cline-pass-console`, and require the exact built image, healthy/running state, zero restarts/OOM, expected config hash, account identity parity, raw=false, local/internal/public meta and safe protected-route negative checks. Roll back only under the verified compatible-data condition, preserving post-switch bytes and old image/release.
7. Atomically record a secret-free deployment report. Without an independently authenticated administrator session, mark the new deployed code `awaiting-admin-acceptance`; do not mistake a client-key401 for protected-view acceptance. Keep rollback materials and all static intermediates until the user authorizes cleanup.

Never print config/account keys, private Headers, proxy URL, admin token/password/session, raw log content, or source operator JSON. Use bounded safe projections and digest comparisons.
