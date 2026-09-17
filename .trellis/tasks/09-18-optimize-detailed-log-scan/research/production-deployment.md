# Production deployment report

## Release

- Release: `20260917-213954-d6c0087-detail-index`
- Commit: `d6c00870693835084e7baa474405733314e2ce3e`
- Archive SHA-256: `0edfd98d2eefd8d8054f80dd8ac663c81c183c7190cbe2e8168267ad0f58ca19`
- Image ID: `sha256:d14535c4a8e68fd19522979bf6fbc1d12eb3a9265bb46cb9b4f04190bff635d1`
- Previous image ID: `sha256:ab68a343c7200929e792eee3d2bbb65f06927eca9d3843fa56ff9353ab4c1471`
- Production verification: `/opt/cline-pass-switcher/verification/deploy-20260917-213954-d6c0087-detail-index`

Committed-source validation passed 151/151 tests before upload. The archive contained only the deployment allowlist and excluded tests, Trellis state, local agent state and the SSH identity.

## Temporary mitigation and drift

Detailed logging was first disabled through the authenticated loopback API with the key held only in remote-process memory. Another operator/process restored the exact pre-mitigation config at 2026-09-17 21:05:51 UTC. Deployment stopped before upload/switch, the owner explicitly approved reapplying the mitigation, and the second disable again changed only `detailedLogging: true -> false`.

Mitigation evidence:

- `/opt/cline-pass-switcher/verification/mitigation-20260917-204317-disable-detailed-logging`
- `/opt/cline-pass-switcher/verification/mitigation-20260917-213921-reapply-disable-after-drift`

## Switch and gates

The candidate Compose differed only in image tag and build context. Before switching, production compose, deployment, config and metadata were backed up. Automatic rollback restored the previous exact image/config on any hard gate failure; rollback was not needed.

Passed immediately and again after 90 seconds:

- exact candidate image;
- running / healthy;
- restart count 0;
- OOM false;
- mitigated config SHA-256 unchanged;
- authenticated models, statistics, request logs and detailed settings APIs;
- invalid quota-refresh rejected with 400 before work;
- `ai-internal` alias visible from `new-api`;
- account count 10 and mode `sticky` unchanged;
- no bounded fatal/config/metadata/persistence log signal.

The public hostname had no DNS result from both local and production preflight, so it remained the documented pre-existing external degradation and did not invalidate local/internal gates.

## Detailed logging restoration

After the delayed gate, the authenticated API restored `detailedLogging=true`. The only semantic config change was the boolean toggle, and the final config SHA-256 returned exactly to the original value:

`9c4d1727a225bb383a5ed40fb60d262f1f43c6667b646985859ddfac8756ea14`

A loopback `/v1/models` request returned 200 and produced a visible detailed record. Detailed-store health after restoration:

- failures: 0
- dropped: 0
- corrupt: 0
- captureDropped: 0
- retainedPayloadBytes: 0

## Five-minute CPU observation

300 one-second process samples after detailed logging was restored:

- average Node CPU: 0.040% of one core
- maximum Node CPU: 2.998% of one core
- P95 Node CPU: 0.000%
- samples >= 50%: 0
- samples >= 80%: 0
- RSS start: 76.25 MiB
- RSS maximum: 83.53 MiB
- RSS end: 83.44 MiB
- container healthy, restart 0, OOM false

The previous once-per-minute single-core saturation pattern did not recur.

## Source hashes

- `server.js`: `11742c8d33c94f211914277b904d3dc1c2344aaeca13ea3fb9245d76bd26412d`
- `lib/detailed-log-store.js`: `5d8a25aa36cbf8a9b857f486e7ae855d2dba99a5c7954dc8e3c7ac8d0e6d294d`
- `lib/detailed-log-capture.js`: `9af7ab1090b4ef2b2cee971a2bc5cfc20f70527bc6f4e3550a8bcd8f2ac44a5f`
- `public/index.html`: `8bac00406459e941b0d366789cf99946c2398e76582d3ddffd442ba4d6c46834`

No release, image, build cache, production backup or log was deleted.
