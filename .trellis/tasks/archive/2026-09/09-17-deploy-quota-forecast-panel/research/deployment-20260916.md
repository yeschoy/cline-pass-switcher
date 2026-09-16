# Production deployment evidence — 2026-09-16

## Result

- **Status:** success
- **Deployment mode:** direct full switch; no canary, gray traffic, second production route, or load-balancer change was used.
- **Release/image:** `20260916-174357-529d642f4b8e-quota-forecast`
- **Source branch:** `feat/quota-forecast-panel`
- **Committed source:** `529d642f4b8ececd0a5b2975addbd8ed74488090`
- **Feature commit included:** `8b727b1 feat: add quota forecast panel`
- **Previous release/image:** `20260916-050450-b1f2170ef4a8`
- **Switch window:** `2026-09-16T17:50:50Z` to `2026-09-16T17:51:32Z`
- **Delayed stability check:** passed at `2026-09-16T17:53:03Z`

## Committed-source gate

- The deployment allowlist and `test/` had no tracked or untracked differences relative to `HEAD`; the index was empty.
- Existing dirty files were limited to unrelated Trellis/tooling paths and were excluded by `git archive HEAD`.
- Full committed application/test suite: **139/139 passed**, 0 failed, 0 skipped, 0 cancelled.
- `git diff --check HEAD` passed for the deployment allowlist and tests.
- The committed console contained `statisticsQuotaForecastTitle` before packaging.
- Archive size: 378,880 bytes.
- Archive SHA-256: `21062c7b2dc96cb04b67f0cb55f5f1c283c55458fae34e88ccacded97444145b`.
- Local and remote archive membership checks accepted only `Dockerfile`, package manifests, `server.js`, `lib/`, `public/`, `README.md`, `LICENSE`, `.dockerignore`, and `config.example.json`.
- Verified committed and installed hashes:
  - `server.js`: `9151e9185c35461a21fe13257469bf05e1fc74d98c098bb7c138662711f5bfcd`
  - `public/index.html`: `98eb0305989eeb6d236ceaf776609b50c00df3b446dc8c22e282e3fe520bb442`
  - `lib/detailed-log-capture.js`: `cec4581fc4cadf198f68f55a7766b1bac9bfb5e758d8d4cae06546abd7ba13ad`
  - `lib/detailed-log-store.js`: `18c123b35f2d465c4d977d96f726b35fc23092be029bffa38bf90a34e9f56254`
  - `lib/jsonl-log-store.js`: `6471348de5fa4b43c56eb950e5903e749a939d930299fef6c3e1ae6e896861f8`

The repository-local SSH identity existed at the exact documented path, was a regular file with mode `0600`, was gitignored, and authenticated with `BatchMode=yes` and a bounded timeout. Its contents were never read, printed, copied, uploaded, or committed.

## Read-only production preflight

| Gate | Result |
|---|---|
| Current image | `cline-pass-switcher:20260916-050450-b1f2170ef4a8` |
| Container | running / healthy |
| RestartCount / OOMKilled | `0` / `false` |
| Local `/api/meta` | 200; configured and authentication required |
| Available disk | 233,634,152 KiB |
| Account count / mode | 9 / `sticky` |
| `config.json` SHA-256 | `da99749a146bbfc266b8f9e0d024cc2db870d4da6d3221320be2f14c736dd46e` |
| `compose.yml` SHA-256 | `18c6931b96932217e9f895d787be9bc0e111e3a9fcea6de3e6c3067eaf93cacb` |
| Previous `deployment.json` SHA-256 | `6a38d06563e6210dcc965e4566e47650f19c5df6a5d0c1fef16333bd7834ee24` |
| Backup `metadata.json` SHA-256 | `f66074a79a031de94e70f2a33742ae3d70e3353af29cc6f77adf66c8f02b1a1b` |

Public ingress was already unavailable before switching. The production host could not resolve `clinepass.yeschoy.com`; direct local resolution also failed, and an independent public DNS resolver returned no A answers. This reproduces the documented pre-existing DNS dependency failure, so it was recorded as `dns_unavailable_preexisting` while all required local and internal gates remained mandatory.

Two non-mutating procedural retries occurred and were bounded safely:

1. The first remote projection helper found that host-level `node` was unavailable and exited before completing preflight; it was rerun with the existing `python3`, with no upload or production mutation before the successful preflight.
2. After upload, the first hash command had a local shell-quoting error. No release, backup, or compose change existed at that point. A read-only retry verified the remote upload hash exactly before installation continued.

## Immutable installation, backup, and switch

- The unique release and verification paths were proven absent before use.
- The uploaded archive SHA-256 matched locally and remotely before extraction.
- The release was installed at `/opt/cline-pass-switcher/releases/20260916-174357-529d642f4b8e-quota-forecast/` without overwriting another release.
- Versioned backups of `compose.yml`, `deployment.json`, `data/config.json`, and `data/metadata.json` were created before switching.
- The candidate compose was textually and semantically verified to change only:
  - image to `cline-pass-switcher:20260916-174357-529d642f4b8e-quota-forecast`;
  - build context to `./releases/20260916-174357-529d642f4b8e-quota-forecast`.
- The candidate was atomically installed, followed by one `docker compose -f compose.yml up -d --build` for the new release.
- No production configuration, account, route, quota, proxy, or NewAPI channel data was edited.

## Post-switch gates

| Gate | Result |
|---|---|
| Requested image and image ID | matched |
| Container state / health | running / healthy |
| RestartCount / OOMKilled | `0` / `false` |
| Bounded startup fatal/config/metadata/persistence scan | no indicators |
| Local `/api/meta` | 200 |
| Authenticated `/api/models` | 200 |
| Authenticated `/api/statistics` | 200; 9 account projections |
| Authenticated request-log projection | 200 |
| Authenticated detailed-log settings projection | 200 |
| Invalid quota-refresh body | 400, rejected before quota work |
| `ai-internal` alias from `new-api` | resolved `cline-pass-switcher`; `/api/meta` reachable |
| Served console marker | `statisticsQuotaForecastTitle` present |
| Account count / mode | unchanged at 9 / `sticky` |
| `config.json` SHA-256 | unchanged at `da99749a146bbfc266b8f9e0d024cc2db870d4da6d3221320be2f14c736dd46e` |
| Post-switch `compose.yml` SHA-256 | `b9bb50760aef8ae6c0b4578b937e631024d33127ea63a23181d8c3298f6de0b6` |
| Post-switch metadata SHA-256 | `5d6c5cfa2a1636cf086fe951a2beb07ba6d47e10cf0d9eeef486eac9663c4490` |
| Public ingress | `dns_unavailable_preexisting` |

The delayed stability check repeated image, running/healthy, zero-restart, non-OOM, config hash, account count/mode, local meta, internal alias, console marker, and fatal-log checks; all passed. Dynamic metadata was allowed to change and its pre-switch backup was retained.

## Rollback readiness and retained evidence

Rollback was not triggered. Before switching, the previous compose, deployment record, exact config bytes, metadata, previous release, and previous image were all retained. The transaction was prepared to restore changed config bytes if necessary, atomically restore the old compose/deployment record, run the old compose, and wait for the previous image to become healthy.

Remote evidence is retained under:

- `/opt/cline-pass-switcher/verification/deploy-20260916-174357-529d642f4b8e-quota-forecast/`
- `install.json`, `api-gates.json`, `internal-network.json`, `report.json`, `delayed-stability.json`
- `build.log`, `startup.log`, normalized compose evidence, candidate diff, source/archive hashes, and `backups/`

Final record hashes:

- `/opt/cline-pass-switcher/deployment.json`: `d5673978fa3ae261899bf6d1a53991aaefc2c161595ec1a10c6d15602b26202e`
- remote `report.json`: `e2adc3dc1a09b7a3f1c204a7156299ed4b41a553f30ba413130166a4a02c975f`

No release, image, build cache, log, backup, temporary diagnostic evidence, or production data was pruned. All persisted reports contain only safe status, count, timestamp, path, and hash fields; no proxy key, account key, Authorization header, proxy credential, request body, raw sensitive API response, or SSH private-key content was emitted.
