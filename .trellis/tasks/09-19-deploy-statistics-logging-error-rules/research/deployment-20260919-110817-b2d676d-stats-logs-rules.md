# Production deployment report — 2026-09-19

## Result

- Status: successful after all immediate, delayed and independent read-only gates passed.
- Release: `20260919-110817-b2d676d-stats-logs-rules`
- Source: `b2d676d11e0d4422aef83854670b6bceb89401a0`
- Exact image: `sha256:fb5d9de7dc6643201a333ed47e7064464df3615598cd0fb3c91ad3ffc2f91cf2`
- Previous release: `20260918-070946-2e7dc37-empty-content-r3`
- Previous exact image: `sha256:a5ffbbc7a1185e69bf3d9e6767d80ff86bb20762dce456d90833d6179e0f1d7d`
- Successful switch: `2026-09-19T11:19:10.299253Z`
- Delayed gate: 153.07 seconds after switch.

No NewAPI/CPA configuration was changed and no real model request was sent.

## Committed-source gate

- Production archive came only from committed `HEAD` and the documented allowlist.
- Archive SHA-256: `9b7ff1f5a010af30847d88c79e4c8d17036cc566cee795b145fa73bf20d6d89c`.
- Server/lib syntax and the production inline script compiled.
- Independent `npm ci` and full test run: 161 passed, 0 failed.
- Production allowlist diff and archive-member checks passed.
- SSH identity was verified as the fixed gitignored regular file with mode 0600 without reading its contents.
- The initial broad repository diff check found pre-existing whitespace only in non-production `.agents/.trellis` files and stopped before upload; the production allowlist was then checked independently and passed.

## Candidate and copied-data rehearsal

- The immutable release tree uses directory mode 0755 and regular-file mode 0644.
- Candidate Compose changed only image and build context.
- The image was built once through the final Compose path. Rehearsal and production used the same exact image; switch and rollback paths did not rebuild.
- Production-copy source at rehearsal: 10 accounts, sticky, cache pool 5, wait 2000 ms, five status rules, no content-rule field, statistics v1 and two ordinary-log files.
- Rehearsal config diff was exactly `accountContentErrorRules: missing -> []`.
- Statistics migrated v1→v2 while preserving global/account facts and adding empty model buckets/coverage.
- The copied ordinary log bytes were preserved. `/api/meta` became reachable in about 332 ms; request logs returned explicit 503 while recovery was in progress, then request/error log queries both returned 200 by about 411 ms.
- The first rehearsal attempt safely stopped because Docker's internal network exposed no host port. Production was unchanged. The second attempt used container-internal loopback and passed under UID/GID 1000, read-only root, cap-drop ALL, no-new-privileges, tmpfs and an internal network.

## Production migration and configuration

The live configuration SHA-256 changed from:

- `196309103302e3796d7ddc19f9901489f60798d843d908bd5af892d6bd7d398b`
- to predicted `3661444eeb0ba540f59b660c310256b7981273fdd76578aaa01adfaed0cbba4d`.

The only semantic config change was adding empty `accountContentErrorRules`. These current production facts were preserved:

- 10 accounts;
- sticky mode;
- `cachePoolSize=5`;
- `concurrencyWaitMs=2000`;
- five status rules;
- zero content rules.

Statistics is now version 2. Ordinary logs recovered and remained queryable.

## Operational incident and recovery

The first switch-script attempt failed before installing the candidate Compose because a path-mode expression called `.stat()` on the filename string. Its automatic rollback handler contained the same expression. It had already stopped the old container before hitting that error, causing a brief production interruption.

Important boundaries:

- Compose, deployment, config and data had not been modified.
- The old exact image remained present.
- The service was immediately restored with the original Compose via `docker compose -f compose.yml up -d --no-build`.
- Recovery reached healthy on the old exact image with restart count 0 and OOM false; its recovered start time was `2026-09-19T11:16:12.369948611Z`.
- Exact outage start was not available from retained Docker event history, so no unsupported duration is claimed.

Before retry, the failed evidence and first backup were preserved, a new backup was frozen, atomic replacement was tested on private scratch files, and rollback was changed to avoid stopping the container when Compose/image state had not changed. The second switch attempt passed.

## Post-deployment gates

Immediate, 153-second delayed and fresh independent checks all passed:

- candidate exact image, running/healthy, restart 0, OOM false;
- live source hashes match committed `server.js`, UI and three logging modules;
- `/api/meta`, authenticated accounts/models/statistics/request logs/error logs/detailed settings: 200;
- invalid quota-refresh payload: 400 before work;
- account stable-ID summaries and statistics model projection present (16 models at verification);
- visual error-rule/model-cache/upstream-discovery UI markers present;
- detailed logging remained enabled and authenticated;
- `new-api` could resolve and reach the `cline-pass-switcher` internal alias;
- bounded startup/runtime logs contained no configured hard-failure markers.

The public hostname remained unresolved from both the production host and the independent local client before and after switching. This is the documented pre-existing DNS dependency failure and did not override successful local/internal gates.

## Rollback readiness and retention

- The previous exact image remains available.
- Private `backup-attempt2` contains the original Compose, deployment record, config, metadata and ordinary logs.
- Rollback uses the previous exact image with `up -d --no-build`; no rebuild is allowed.
- The failed attempt, immutable release, candidate image, build cache, logs, backups and remote evidence were retained.
- Remote evidence: `/opt/cline-pass-switcher/verification/deploy-20260919-110817-b2d676d-stats-logs-rules/`
- Local redacted evidence: `.trellis/tasks/09-19-deploy-statistics-logging-error-rules/research/deployment-20260919-110817-b2d676d-stats-logs-rules/`

## Cache-pool observation boundary

The older cache-pool task's original size-2 / 5000 ms window had already been superseded by a later production size-5 / 2000 ms configuration before this deployment. This release preserved size 5 / 2000 ms but introduced another restart/statistics-version boundary. No continuous 24-hour or 70% cache-hit result is claimed from the old window; a future validation must freeze a new baseline and window.
