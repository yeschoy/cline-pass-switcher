# Production deployment preflight — independent administrator login

> Historical pre-switch snapshot. The `.io` correction and subsequent live migration are recorded in `deployment-handoff-20260924.md`; do not treat the earlier `.com` DNS failure or prior-release status below as current.

## Status

**Read-only baseline; no production mutation yet.** The initial DNS blocker below was traced to an incorrect `.com` hostname. The operator corrected the actual public address to `https://clinepass.yeschoy.io` and reiterated deployment authorization; see the correction section below. A trusted proxy and private bootstrap delivery remain mandatory before switching. Production Compose, data, image, container and proxy configuration were not changed. Do not reinterpret `curl -k` or a local loopback login as a trusted public-admin check.

## Local committed source

- Feature branch `feat/separate-console-login` committed `29b1a85` planning and `d7760f9` implementation; worktree was clean immediately before this report.
- Full local gate 258/258, syntax, Compose interpolation, diff checks and isolated fake-data Chrome 375px evidence passed. No live/paid upstream request.
- `main` remains at `9c61b60`; freshly fetched `origin/main` is eight commits behind it. Deployment rules require a committed, pushed `main` equal to `origin/main`, not an archive from this feature branch. No merge/push was done.

## Read-only production observations

- Canonical host SSH using gitignored mode-0600 identity succeeded. Python3 and Docker Compose 5.5.0 available. Production container `cline-pass-console` is running/healthy on release `20260923-085128-2431d5b8-integrated` at commit `2431d5b8…`, current image `sha256:a8468d22…`, restart count 1, OOM false, with 10 accounts in sticky mode. `GET http://127.0.0.1:3123/api/meta` returned 200. `admin-auth.json` is absent as expected on the old release; existing full detailed logging switch is on. These are safe projections only; no key, config body, Header value, raw log or production data copy was printed.
- `/opt/cline-pass-switcher/compose.yml` has environment keys only `BIND_HOST`, `DATA_DIR`, `NODE_ENV` and no `env_file`. It lacks `CLINE_PASS_ADMIN_BOOTSTRAP`, the private one-time code, public-origin/proxy-token wiring. A normal deployment that changes only `image` and `build.context` cannot pass the new admin initialization or trusted remote TLS proxy gate. New code would refuse management access until out-of-band bootstrap/first change, and suspend currently enabled detailed capture.
- The configured canonical public check `https://clinepass.yeschoy.com/api/meta` failed DNS from the deployment host and an independent external fetch; a local client saw a connection reset. This predates the proposed switch. The host Nginx config is valid but has **no** `server_name clinepass.yeschoy.com`; forced local vhost TLS presents a Cloudflare Origin CA certificate that is not browser-trusted directly and returned 404 even with a diagnostic-only insecure curl. `cloudflared` runs in host-network token mode with no config mount; its dashboard-managed public ingress and Header injection cannot be verified from this host. A remote browser first-login path is therefore **not proven**.

## Corrected hostname and remaining gateway gate

The operator supplied `https://clinepass.yeschoy.io`. Both a local client and the deployment host resolved it and received HTTPS `200` with successful TLS validation on `/api/meta`. The current `config.json` still has the old `.com` public-base hostname; the candidate must override `PUBLIC_BASE_URL` to `.io` via private runtime configuration rather than editing operator config bytes. Host Nginx has no `.io` vhost; forcing the origin TLS vhost returned diagnostic 404. Read-only `cloudflared` configuration-update log projections show the `.io` tunnel goes to **`http://127.0.0.1:3123` directly**. This corrects only the DNS finding above: the tunnel still does not place the independent proxy token, so the auth gate would reject remote login after an ordinary image-only release.

A scoped exception to the two-field Compose switch is necessary: bind the application at host loopback 3124 while preserving its container/network 3123, insert a host-loopback Nginx gateway at tunnel target 3123 that overwrites attestation Headers, and supply private runtime admin variables through a root-private env file. Public HTTPS and trusted proxy behavior must be checked as one path; backup and rollback must include both proxy and port binding. User first-change credential delivery through a private operations channel remains to be established before live switch. The amended deployment guideline specifies this one-time case. None of these changes have been made on the host.

## Required decision / gates before proceeding

1. The `.io` HTTPS edge and direct tunnel-to-app path are confirmed. Rehearse the scoped Nginx gateway, Host/Origin and replacement of both `X-Forwarded-Proto` and `X-Cline-Pass-Proxy-Token`; do not accept arbitrary private-network forwarding Headers or bypass TLS/attestation.
2. Prepare the one-time **auth-migration exception** to the two-field Compose-switch rule and establish a trusted out-of-band method for the administrator to receive the independently generated initialization code (and to perform first password change). Never put secret values into Git, chat, command arguments/output, service logs or this report.
3. Before any live mutation, copy/admin-back up current Compose, deployment state and operator config/metadata (including `admin-auth.json` when present), rehearse the exact committed image on isolated copies under UID/GID 1000:1000, and test rollback with old shared-key management ingress isolated. Keep future unredacted raw-body mode off.
4. Once the above are proven, merge to local `main`, run the full gate on committed `HEAD`, push so `main == origin/main`, then build an allowlisted immutable release and perform the normal no-build switch/health/auth/internal/public/hash checks. Any gate failure leaves or restores the old healthy container.

Production remains on the prior release; this report does not authorize a live switch or a production secret-generation operation by itself.
