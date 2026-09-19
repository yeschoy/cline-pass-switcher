# 单渠道健康重试生产部署报告

## Result

- Status: deployed successfully.
- Source: `origin/main@9ecc84dc8ea6cd59422b7935a97e4af701d8d242`.
- Release: `20260919-193220-9ecc84d-provider-health`.
- Exact image: `sha256:52664183bc13d52828051a066b1de549500ebabdb394ae71492225f16f75154f`.
- Previous release/image: `20260919-172057-3ccb929-upstream-affinity` / `sha256:5a26c0c0fd6f78b0c19fc72d840f00cfcb87e990e74d1e32646843ff56577935`.
- Switch used the exact Compose-built image with `docker compose up -d --no-build`; no rebuild occurred after candidate build.
- No real Chat/model request was sent. NewAPI/CPA and business configuration were not modified.

## Source and immutable candidate

- Local `main` and `origin/main` matched the committed source.
- Committed allowlist archive SHA-256: `20a7303a2b0cffd5542f7b7cfb2fde9eac0a040b369855d3db4b51836b8cd748`.
- `server.js` SHA-256: `45fb7f125b40c2f1666f4540400836f7d4d01b6209ecb98baaa9163d591f3c47`.
- `public/index.html` SHA-256: `73b69da9bbef1f6e05e5eb5259a87c9f020e79ac504d4aba755368c11c17b445`.
- Syntax gates and full 166/166 tests passed against committed source.
- Release directories/files were normalized to 0755/0644; the image passed runtime-user readability and server syntax checks as UID/GID 1000:1000.
- Candidate Compose differed from live Compose only at image and build-context lines.

## Read-only baseline

Before mutation, production was healthy on the previous exact image with restart 0 and OOM false. Safe configuration projection remained 10 accounts / 8 enabled / sticky / wait 2000 / cache pool 5 / 5 status rules / 0 content rules / 16 global routes / 0 nonzero configured provider cooldowns. All authenticated management APIs returned 200.

The internal `new-api → cline-pass-switcher` alias was healthy. The first helper reused an old Node-based probe, but current `new-api` has no Node executable; a bounded wget probe verified the alias instead. Public DNS for `clinepass.yeschoy.com` remained unavailable before and after deployment.

## Copied-data rehearsal

The exact candidate image ran against frozen production-data copies with production UID/GID, read-only root, dropped capabilities, no-new-privileges, tmpfs, and no external network.

- `config.json` bytes and semantics were unchanged.
- All 78 existing `models[*].upstreamStatus[*]` rows were normalized to the declared provider-health shape.
- Existing status/note/checkedAt facts were preserved; health timestamps/counters/cooldown/class fields were bounded and added as designed.
- Metadata outside provider health was unchanged; statistics stayed v3.
- Ordinary logs were unchanged and became queryable after recovery.
- A second candidate start was byte-idempotent for config, metadata, and ordinary logs.

The first rehearsal comparison intentionally stopped before live mutation because it compared against moving live metadata instead of a frozen input. `rehearsal2` corrected the evidence owner and passed.

## Backup and rollback

Immediately before the switch, current Compose/deployment/config/metadata/ordinary logs were copied into the private deployment verification directory and hash-verified. The old exact image remained inspectable. Atomic install/restore helpers passed a private scratch rehearsal.

`rollback-ready.json` records the crossed mutation boundary, previous exact image, final backup path, no-build rollback requirement, and drift guard. Production release/image/log/cache/backup artifacts were not pruned.

## Immediate, delayed, and independent gates

All three gate sets passed:

- exact image matched; running/healthy; restart 0; OOM false;
- config hash matched the copied-data prediction;
- container `server.js` and UI hashes matched committed source;
- all 78 provider health rows had the normalized shape;
- accounts/models/statistics/request logs/error logs/detailed settings returned 200;
- invalid quota-refresh input returned 400;
- internal alias passed via wget;
- singleton provider, health/cooldown, 429 scope, affinity, content-rule and detailed-log source markers were present;
- bounded startup logs contained no fatal config/metadata/statistics/permission indicators;
- 90-second delayed checks and a fresh independent postcheck repeated the critical facts.

`deployment.json` was atomically updated only after these gates passed.

## Pre-mutation attempts

Three bounded issues were retained in `deployment-attempts.md`:

1. a read-only metadata projection lacked a collection type guard;
2. the internal alias helper assumed Node existed in `new-api` and safely fell back to wget;
3. the first rehearsal compared with moving live metadata rather than its frozen input.

All occurred before the live mutation boundary. No attempt stopped or restarted the healthy old service.

## Residual boundary

- Public DNS remains a pre-existing external dependency failure; local, authenticated, internal-network, and container gates are healthy.
- No real provider failure or paid model request was injected, so this deployment verifies release integrity and management/data boundaries rather than claiming live provider failover behavior.
