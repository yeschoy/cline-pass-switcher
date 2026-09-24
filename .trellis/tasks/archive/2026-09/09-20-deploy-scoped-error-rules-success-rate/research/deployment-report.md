# 双维度错误规则与成功率生产部署报告

## Result

- Status: deployed successfully.
- Source: `main == origin/main == c78d8bbb552943910af341733950cde656cf8c1c`; required commits `cb19f2e` and `1008fc8` are ancestors.
- Release: `20260920-045938-c78d8bbb-scoped-rules-rate`.
- Exact Compose-built image: `sha256:615df03dddc5883a769024e5f34146d6fbaf02a13cc9694feab3d1a16939ce55`.
- Previous release/image: `20260919-193220-9ecc84d-provider-health` / `sha256:52664183bc13d52828051a066b1de549500ebabdb394ae71492225f16f75154f`.
- Switch: atomic Compose install followed by `docker compose up -d --no-build`; no rebuild occurred at switch time.
- No real Chat/model or paid request was sent. NewAPI/CPA and operator business settings were not edited.

## Source and candidate gates

- Identity exact path, gitignore and mode `0600` passed; BatchMode SSH passed.
- Syntax/embedded-script/JSON gates and the complete 169/169 test suite passed on committed source.
- Allowlisted archive SHA-256: `42a24a4932f1b66f34bcca1d2a6f55c220d446d85e49d95853bcb96972f58433`.
- Immutable release directories/files were normalized to 0755/0644.
- Candidate Compose changed exactly the image and build-context lines.
- Candidate Compose SHA-256: `fda0377477082e9fb89a0cd2b9a2c2bc6951c1a0e0054e06a7c28cc030a81f59`.
- The image passed UID/GID 1000:1000 readability and exact source-hash checks for server, UI and diagnostic modules.

## Read-only production baseline

Before mutation, production was running/healthy on the previous exact image with restart count 0 and OOM false. The safe projection was 10 accounts / 8 enabled / sticky / wait 2000 / cache pool 5 / 5 legacy status rules / 0 legacy content rules / statistics v3 / 85 Provider status rows. Local and authenticated management endpoints, ordinary logs, detailed settings and the internal `new-api → cline-pass-switcher` alias passed.

Public DNS for `clinepass.yeschoy.com` failed with `gaierror` from both the deploy host and an independent local client before switching. The same pre-existing external condition remained after deployment.

## Copied-data migration rehearsal

The exact candidate image ran twice against fresh frozen production copies with network none, UID/GID 1000:1000, read-only root, dropped capabilities, no-new-privileges and tmpfs.

- Five legacy status rules migrated to five ordered canonical account-scope ignore rules; legacy mirrors stayed exact.
- The legacy four-step order folded/deduplicated to `healthSort → quotaPool → sticky`; flags, cache size and all other business configuration stayed exact.
- Statistics migrated from v3 to v4 with empty account/Provider direct-health owners and truthful tracking starts; old counters, quota/model facts and migration facts stayed exact.
- All 85 Provider state rows gained the canonical bounded state shape without losing prior facts.
- Ordinary logs were byte-identical and queryable after asynchronous recovery.
- The second candidate start was byte-idempotent for config, metadata and ordinary logs.
- Predicted/live post-migration config SHA-256: `4d4c33a327d19d98f1ce13e193ce74d2b7c367a740ce087191495951a0e07245`.

A later normal metadata advance on the still-running old service triggered the pre-mutation guard. `backup-final2` and a fresh two-start rehearsal repeated the same migration and idempotence proof from the newer frozen bytes before switching.

## Backup and rollback

Final rollback source: `/opt/cline-pass-switcher/deployments/20260920-045938-c78d8bbb-scoped-rules-rate/backup-final2`.

It contains versioned Compose, deployment, config, metadata and ordinary-log copies with recorded hashes. The previous image remains inspectable. The exact atomic replacement helper passed private install/restore scratch tests. Remote `rollback-ready.json` records the crossed boundary, old/new exact images, backup, candidate Compose, drift guard and no-build rollback requirement.

No release, image, build cache, log, detailed log, backup or operator data was pruned.

## Immediate, delayed and independent gates

All three gate sets passed:

- exact candidate image; running/healthy; restart count 0; OOM false;
- exact candidate Compose and predicted config hashes;
- 10 accounts / 8 enabled, five canonical rules, canonical three-step pipeline;
- statistics v4 with account/Provider tracking starts and 85 canonical Provider rows;
- local `/api/meta`; authenticated accounts/models/statistics/request logs/error logs/detailed settings all returned 200;
- invalid quota-refresh input returned 400 without upstream work;
- internal alias returned the public meta projection;
- server/UI/security-sensitive module hashes and canonical-rule, Provider recovery, account/Provider success-rate, coverage, three-step pipeline, affinity, detailed-log and cache-pool markers matched committed source;
- bounded startup logs contained no fatal config/metadata/statistics/permission/runtime indicators;
- remote and independent clients retained the pre-existing public DNS failure.

Remote `deployment.json` was atomically updated only after the immediate, 90-second delayed and fresh independent postcheck all passed.

## Pre-mutation attempts

`deployment-attempts.md` retains three bounded attempts:

1. invalid Docker long-form mount syntax stopped before any rehearsal container was created;
2. the first structural verifier assumed the wrong folded pipeline order;
3. final live metadata advanced normally before mutation, causing the strict freeze guard to stop and require `backup-final2` plus a fresh rehearsal.

Every attempt occurred before the live mutation boundary. No attempt stopped or restarted the healthy old production container.

## Residual boundary

- Public ingress remains degraded solely because DNS was already unavailable before deployment; all local/authenticated/internal gates are healthy.
- Direct success rates begin with truthful v4 migration coverage and require real production samples over time; this deployment does not claim a mature 24-hour rate immediately.
- Non-business intermediate artifacts are intentionally retained pending explicit cleanup approval; Trellis evidence and production release/image/backup/log artifacts must remain.
