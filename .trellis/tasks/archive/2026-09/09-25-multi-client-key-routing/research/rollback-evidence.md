# Synthetic old-image rollback rehearsal

UTC: 2026-09-25 10:11. Script: `research/rollback-check.mjs`. Baseline is the fixed commit `cc17ac7` (`git show cc17ac7:<path>`), not moving HEAD. Candidate is the **uncommitted local** `server.js`/`lib/`/`public/` at execution time. Node's installed local dependencies are shared read-only by symlink. Both service versions ran exclusively against process-private temporary `DATA_DIR` clones and one loopback mock upstream. Administrator verifier, login Cookie/CSRF and both client keys were synthetic; no production data, live key, paid upstream, deployment, push or commit was used. The script removes temporary trees and terminates child processes in `finally`, prints only bounded boolean/status summaries, never raw JSON/logs/secrets.

## Sequence

1. Old image started with one synthetic legacy client/account and independent initialized admin fixture. Authenticated chat generated `metadata.json` statistics and a log. Entire v1 data tree, including `admin-auth.json`, config, metadata and log, was backed up privately (4 files).
2. New image started from a complete v1-backup clone. It migrated the old account under `legacy` with the same stable account ID. Using an actual independent admin login/session/CSRF, it created an additional client key, saved a second account owned by the new ID, and chatted using both keys. Full v2 tree backed up separately (5 files); history request count grew.
3. Old image started **only on a disposable clone of v2**. Login, read and full account save were tried; both config and metadata of that disposable clone were then compared with the private v2 backup. One legacy-key chat on the old image deliberately tested whether the foreign account could be attempted.
4. A *different* clone restored the complete v1 backup byte-for-byte **before** old image startup. Old admin login, stable account ID and legacy-key chat were tested. The v2 backup remained byte-identical throughout.
5. Separate synthetic clones checked open/empty-key legacy chat and nonempty `PROXY_KEY` startup precedence. An admin security save changed the running key; restarting with the environment override reapplied it.

## Runs

- Run 1 (repository cwd): `node --check .trellis/tasks/09-25-multi-client-key-routing/research/rollback-check.mjs && node .trellis/tasks/09-25-multi-client-key-routing/research/rollback-check.mjs` — exit 0, `result: pass`.
- Run 2 (`/tmp` cwd): `node /Users/lyh_god/GolandProjects/cline-pass-switcher/.trellis/tasks/09-25-multi-client-key-routing/research/rollback-check.mjs` — exit 0, same results. The script finds the repo root by walking upward from its own location.

Both runs: `oldV2Starts=true`, `startupInventoryRetained=true`, `startupOwnersRetained=false`, `oldViewHasOwners=false`, `oldLegacyChatStatus=200`, `oldLegacyReachedTeam=true`, `oldSaveStatus=200`, `saveInventoryRetained=true`, `saveOwnersRetained=false`, `saveStableIdsRetained=true`, `historyCountAfterOld=4`, `historyNotReduced=true`, `configBytesChanged=true`, `metadataBytesChanged=true`, `v1RestoredOldChat=true`, `v2BackupPreserved=true`, `emptyKeyAnonymous=true`, `envOverrideStartupOnly=true`. v1/v2 full backup file counts were 4/5. No secret values, raw JSON, or log contents were printed.

## Decision / limits

**Unsafe to put the old image directly on v2.** It does not reject v2. Its startup normalization drops `accounts[].clientKeyId` in the disposable clone, even though the additional `clientKeys` array happened to survive startup and full save. The old model scheduler ignores ownership: in `single` mode with the foreign account active, a legacy-key request reached that account's mock upstream. The old admin full save succeeded and left owners absent. Config and metadata bytes changed on the old-on-v2 clone; its aggregate history count did not decrease, but that is **not** proof that every v2 historical record/field remained compatible. Restored old v1 does not promise access to v2-only keys, owners or post-upgrade history; retain the untouched private v2 backup for future recovery.

Rollback precondition: fence writes, preserve separately the *entire* v2 state (including admin state/logs where applicable), restore the *entire* pre-upgrade v1 backup atomically/safely **before** starting old code, and isolate old-image management ingress; do not attach old image to mutable v2 or claim it provides multi-key isolation. Synthetic rehearsal does not verify Docker image identity, container hardening, old-image raw-detail handling, multi-process consistency, actual proxy/TLS ingress or production backup timing. No production rollout is authorized or attempted.
