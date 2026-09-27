# Stop-first code switch: scoped backup glue, **not a deploy command**

`code_cutover_backup.py` is a root-only, raw-off, 512 MiB **read-only preflight / already-stopped-old backup** helper for exact old image `0bd1dea…`, candidate image `bd49772…` and committed `main` source `4d4ee87`. It does **not** stop or start Docker, install Compose, switch images, restore live data, authenticate an administrator or enable raw capture. Do **not** run `--seal-stopped` on production until a separately reviewed continuously enforced ingress/all-writers fence, stopped-old recovery owner and complete cutover/rollback procedure exist. The current implementation deliberately stops before that unsafe boundary. Operator assurance about no admin/host/external writes is helpful but does not itself close model ingress/in-flight work or prove a fence after coordinator loss. No production host was contacted for this implementation.

## Exact boundaries

- The `--preflight` action reads the 32-account v1/raw=false config, checks current config/metadata/admin and Compose/env/resolved gateway target/deployment hashes supplied from an **independent fresh private read**, exact old container/image/health/restart/OOM/mount/Compose identity, 512 MiB, absent raw-readiness environment entry (inspected only in memory), exact candidate image ID and all 13 allowlisted source file hashes/modes under the reviewed release path. It does not prove the built image's in-container files, current local `main == origin/main`, candidate Compose two-field diff or controlled ingress. A matching old config hash from an earlier snapshot is **not** sufficient. Failures change no live path/container; only the Docker/Compose/image inspect commands are used.
- `--seal-stopped` requires an externally stopped **exact** old container and an explicit caller acknowledgement of a durable writer/ingress fence. It repeats all gates, refuses any `clientKeys`/`clientKeyId` v2 owner schema or nonempty raw child, creates a unique root-owned mode-0700 `/root/cps-code-v1-<16 hex>/`, copies four actual authoritative sidecars including the resolved Nginx symlink target and env_file identified from current Compose, and reuses `backup_window_common.sidecars()` for manifest/source/copy validation. It copies the complete bounded non-raw DATA_DIR via the shared anchored rsync exclusion `/detailed-logs/raw/***`, checks **source → copy → source** framed path/content/UID/GID/mode parity, separately restores to `restored-v1/` and rechecks copy/source/sidecars/old STOP. There is **no** `rsync` to live data. Both phase records have `trusted:false`; the final phase is `copy-verified-boot-pending`. This proves copy parity at the observed instant, **not** an independently booted exact old image or a safe rollback snapshot after writers resume.
- An error or coordinator death before stage creation leaves live state untouched. An error afterward leaves the private stage untrusted and **does not restart old automatically**. An ambiguous external stop must be diagnosed under the independent fence before any restart; the helper never executes candidate `up`, so it cannot mistake an ambiguous up for an unmigrated v1. A stopped backup is only useful for a later cutover while the fence holds, and cannot be reused after old service writes resume. Private stage/sidecar copies are retained; do not prune them without the operator's cleanup decision.

## Operator syntax — gated, **do not execute as a live cutover**

An operator would first independently freeze current read-only hashes and verify old health, exact image, 32-account v1 schema and candidate provenance. Hashes below are placeholders, **not** the stale historical config or metadata values. Never paste credentials/config JSON into arguments or output.

```bash
HELPER=/root/<verified-private-helper-directory>/code_cutover_backup.py
# Install/verify byte-identical helper and its existing backup_window_common.py,
# backup_pause_window.py dependency in a root-only location before any stop.
ARGS=(--container-id '<fresh-full-old-container-id>' \
  --compose-sha256 '<fresh-sha256>' --config-sha256 '<fresh-sha256>' \
  --metadata-sha256 '<fresh-sha256>' --admin-sha256 '<fresh-sha256>' \
  --env-sha256 '<fresh-sha256>' --gateway-sha256 '<fresh-sha256>' \
  --deployment-sha256 '<fresh-sha256>' \
  --gateway '<fresh-verified-logical-nginx-symlink>')
python3 "$HELPER" --preflight "${ARGS[@]}"
# ONLY after a separately reviewed continuous fence, recovery owner, and
# independent exact-old-container STOP and exited-state check:
python3 "$HELPER" --seal-stopped --ack-independent-stop-and-fence \
  --stage '/root/cps-code-v1-<new-16-lowercase-hex>' "${ARGS[@]}"
```

`--seal-stopped` does **not** authorize leaving the old service stopped indefinitely; the independent stop/recovery owner must manage this outage. No live STOP command is provided here: without a tested post-stop return-to-service path, offering one would misrepresent this helper as a safe deployment procedure. A first-phase or rsync failure leaves `trusted:false`; never promote that stage, restart on an unknown tree, or repair it by modifying live config.

## Still blocking a complete switch

1. Demonstrated continuous ingress/in-flight and all-writers fence, including internal/direct paths and host/UID-1000 writers, surviving coordinator loss; independently tested stopped-old recovery. A Docker STOP, hashes and operator promise alone are not the fence.
2. Reviewed candidate Compose two-field **atomic scratch install/restore** and exact committed image in-container source/mode verification; a phase journal **before** potentially-v2 `up`; timeout/loss means possibly v2 and must not restart old. Positive admin/public/internal verification remains a separate owner.
3. Boot exact old image on the *fresh sealed private restore*, and separately rehearse complete v2+sidecar preservation, loss decision, `rollback_data_transaction` fresh `seal.json`/prepared-v1 transaction and gap/post-install recovery, compatible Compose/sidecar restore, isolated old management ingress and full active-v1 proof **before** exact old start. Do not call the rename helper on an unsealed/stale backup; do not boot old on v2. A later v2 write must be preserved, not silently rolled back.
4. No claim of production release, raw enablement, older release acceptance or bounded outage follows from these tests. If these gates cannot be supplied, remain on healthy old image with raw=false.

Local-only checks: `python3 -m unittest -v test-code-cutover-backup.py test-backup-window.py test-rollback-data-transaction.py` (from this research directory). Synthetic mocks prove failure handling in this limited scope; they do not prove actual Docker stop, backup throughput, Linux host UID boundaries, Compose switch or coordinator-death recovery.
