# 单渠道健康重试生产发布设计

## 1. Fixed source and target

- Source branch/ref: local `main` and `origin/main`, both required to equal `9ecc84d` immediately before archive creation.
- Target: `ubuntu@167.114.158.4:49555` via repository-root identity.
- Remote root: `/opt/cline-pass-switcher`.
- Release: generated once from UTC timestamp + `9ecc84d` + `provider-health`, then frozen in evidence.
- Upload is an allowlisted `git archive 9ecc84d`, never the working tree.

The local Trellis task is deliberately uncommitted during deployment and excluded from the archive. Release members are limited to the deployment contract allowlist.

## 2. Read-only production freeze

Before creating any remote release/backup/candidate path, collect a bounded projection:

- current deployment release/commit/image and live Compose hash;
- container exact image, running/health/restart/OOM/start time;
- disk availability and old-image inspectability;
- config/metadata hashes and safe configuration counts;
- statistics version/coverage, model/provider-health row counts, ordinary-log file count/bytes;
- safe `/api/meta` and authenticated management status/top-level keys;
- internal `ai-internal` alias from `new-api`;
- public DNS/HTTP availability.

The remote process reads the admin key only internally for loopback checks and never prints it or exposes it in argv/evidence.

## 3. Immutable candidate

1. Produce a local allowlisted tar from committed `9ecc84d`; record SHA-256 and key source hashes.
2. Upload to a unique remote temporary filename and verify the exact hash.
3. Refuse any existing release/verification/candidate path.
4. Extract into `releases/<release>`, normalize directories 0755 and regular files 0644, verify member allowlist and hashes.
5. Generate candidate Compose from live Compose changing only image tag and `build.context`.
6. Build once through candidate Compose; capture the exact image ID and application file modes. All later operations use `--no-build`.

No live service/data file changes occur in this phase.

## 4. Copied-data rehearsal

Create a private verification directory with byte-for-byte copies of current config, metadata and ordinary logs. Run the exact candidate image under production UID/GID and hardening on an isolated internal Docker network.

Expected boundaries:

- `config.json`: same business projection and no unapproved route/account/rule/pipeline changes; exact hash must remain unchanged unless rehearsal proves a formatting-only rewrite caused solely by the declared metadata normalization path, in which case structural equality and predicted hash are both required.
- `metadata.json`: only `models[*].upstreamStatus[*]` may gain normalized provider-health fields (`lastSuccessAt`, `lastFailureAt`, `consecutiveFailures`, `cooldownUntil`, `failureClass`) or sanitize invalid legacy fields; safe existing status/note/checkedAt/model discovery/statistics/quota projections must remain. Any unrelated schema or fact loss blocks deployment.
- ordinary logs: source bytes remain and logs become queryable after asynchronous recovery.
- second candidate start against the migrated copy is idempotent.

The rehearsal has no external upstream path and sends no Chat request.

## 5. Backup, mutation boundary, and rollback

Immediately before switch, refreeze live hashes and repeat the copied-data prediction if metadata/logs changed. Back up:

- `compose.yml`, `deployment.json`;
- `data/config.json`, `data/metadata.json`, `data/logs/`;
- candidate Compose, archive/build/source/rehearsal facts.

Exercise atomic install/restore against scratch files. Record exact pre-mutation hashes and old image. Crossing the mutation boundary means atomically installing candidate Compose or restoring predicted migrated config if and only if rehearsal declared it necessary.

Rollback is allowed only when live state still matches the candidate or this deployment's expected files. Restore backed-up config/metadata/logs/compose/deployment and start the old exact image with `up -d --no-build`; never stop-first or rebuild.

## 6. Switch and gates

Switch with:

```text
docker compose -f /opt/cline-pass-switcher/compose.yml up -d --no-build
```

Immediate and delayed gates verify:

- exact image/running/healthy/restart/OOM;
- config predicted hash and safe counts;
- key source hashes inside the container;
- bounded startup logs;
- local meta plus authenticated accounts/models/statistics/request/error/detailed-settings APIs;
- invalid quota-refresh rejection;
- UI markers for singleton `only`, provider health/cooldown, 429 evidence, affinity, content rules and detailed logging;
- `new-api` internal alias;
- public ingress only when pre-switch DNS was available.

A final independent read-only postcheck repeats the critical gates from fresh commands.

## 7. Evidence and cleanup

Persist only hashes, counts, statuses, bounded enums and projected schema facts under the Trellis task research directory. Never persist secrets, raw production config/metadata/log records, account names/IDs, prompts or detailed-log bodies.

Trellis evidence and remote rollback artifacts are retained. Local tar/scratch helper files and remote `/tmp` upload are non-business intermediates and are removed only after successful completion and user authorization.
