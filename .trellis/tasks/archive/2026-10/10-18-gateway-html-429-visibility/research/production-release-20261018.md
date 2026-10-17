# Production release — HTML 429 per-account backoff (2026-10-18)

**Machine release deployed; administrator acceptance pending.**

- Source: pushed `main` `4fbe78278b575b058559e5e85ccd24c83fbdc814` (equal to `origin/main` at switch)
- Release: `20261018-4fbe782-html429-acct`
- Image: `sha256:53337e02b09983e9895268f2ce27a69544e54c835891390f9f61f3dcf944caa7`
- Previous: `20261015-211840-06639e6-proxy-health` / `sha256:f0b7903f3cab687636489a29c589a36ee567f722919e31ab71bf8f4cdcc56ee2`
- Archive SHA-256: `167dec217e6caa8d1e9b00b7dc5c743319bac3ad552645b03826fece02f1e981`
- Config: unchanged `fef5128b06a7b23bba93715f8478a29f3363436b701b32bfa5d66a8bf6993cd8` (no schema migration)
- Local gate: full suite 513/513 before push
- Post-switch: running/healthy, restarts 0, local/internal/public `/api/meta` 200, client-key-only protected routes 401, 39 accounts, workflow enabled/healthFilter preserved, statistics v6, raw off
- `deployment.json.status`: `awaiting-admin-acceptance` (no independent admin session in this agent)

Private backups/release tree retained; no prune.
