# Production deployment evidence — 2026-09-16

## Source and release

- Source commit: `b1f2170ef4a8ea14d62e9eef3fc058630c294cc8`
- Release/image: `20260916-050450-b1f2170ef4a8`
- Previous release: `20260915-114348-diagnostics-quota`
- Archive SHA-256: `cab916221260328b7cedd7fd3668ce42ba8047444855796b130d56104bbf5066`
- Committed-HEAD test snapshot: 136/136 passed.
- Uploaded `server.js`, `public/index.html`, detailed capture and detailed store hashes matched the committed archive.

The release was built from the documented git-archive allowlist. The gitignored SSH identity remained outside the archive; no working-tree data, local config, task tooling or credentials were uploaded.

## Config migration gate

A byte-for-byte production data copy was mounted into the committed image before switching. The only structural config change was:

```text
accountPipeline.order = [excludeUnhealthy, quotaPool, healthSort, sticky]
```

- Original config SHA-256: `87d5ae2df08e1774ff76f35f186f27c12c8eb78469f415df3cf40403341d6089`
- Predicted/live migrated SHA-256: `f6ba3d7ec6702a87dc4d46849611c9a0a425fc52d2b39216ee213e6d0750368b`

The post-switch live hash exactly matched the copy-predicted value. Original config bytes, compose, deployment record and metadata were retained under the versioned backup path for rollback. No local config was uploaded or manually merged.

## Post-switch gates

- Container image matched the requested release.
- Container state `running/healthy`, restart count 0.
- Local `/api/meta`: 200.
- Authenticated models/statistics/request-log/detail-settings projections: 200.
- Invalid quota-refresh body: 400 before work.
- Account count remained 9 and mode remained `sticky`.
- Persisted pipeline order matched the compatibility default.
- `ai-internal` alias `cline-pass-switcher` resolved from `new-api` and `/api/meta` succeeded.
- Detailed storage failures remained 0.
- Delayed stability check retained healthy/0 restarts and the expected config hash.
- All 9 production accounts exposed complete 5-hour/weekly/monthly windows; quota routing projected 8 `fresh/hot` and 1 `fresh/warm`, with no quota error category.

## External ingress and retained artifacts

`clinepass.yeschoy.com` was DNS-unresolvable before switching from the deploy host and an independent fetcher, and remained so afterward. Per deployment policy, this pre-existing external DNS dependency did not roll back an otherwise healthy local/internal release. Public ingress is reported degraded, not verified successful.

The failed/unused earlier preflight release, final release, images, build logs, source verification, migration copies and versioned backups were retained; nothing was pruned.
