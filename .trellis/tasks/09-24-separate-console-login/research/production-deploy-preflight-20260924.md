# Production deployment preflight — independent administrator login

## Status

**BLOCKED before any production mutation.** User authorized commit and deployment, but the current infrastructure cannot meet this release's required remote first-login/authentication gates. Production Compose, data, image, container and proxy configuration were not changed. Do not reinterpret `curl -k` or a local loopback login as a trusted public-admin check.

## Local committed source

- Feature branch `feat/separate-console-login` committed `29b1a85` planning and `d7760f9` implementation; worktree was clean immediately before this report.
- Full local gate 258/258, syntax, Compose interpolation, diff checks and isolated fake-data Chrome 375px evidence passed. No live/paid upstream request.
- `main` remains at `9c61b60`; freshly fetched `origin/main` is eight commits behind it. Deployment rules require a committed, pushed `main` equal to `origin/main`, not an archive from this feature branch. No merge/push was done.

## Read-only production observations

- Canonical host SSH using gitignored mode-0600 identity succeeded. Python3 and Docker Compose 5.5.0 available. Production container `cline-pass-console` is running/healthy on release `20260923-085128-2431d5b8-integrated` at commit `2431d5b8…`, current image `sha256:a8468d22…`, restart count 1, OOM false, with 10 accounts in sticky mode. `GET http://127.0.0.1:3123/api/meta` returned 200. `admin-auth.json` is absent as expected on the old release; existing full detailed logging switch is on. These are safe projections only; no key, config body, Header value, raw log or production data copy was printed.
- `/opt/cline-pass-switcher/compose.yml` has environment keys only `BIND_HOST`, `DATA_DIR`, `NODE_ENV` and no `env_file`. It lacks `CLINE_PASS_ADMIN_BOOTSTRAP`, the private one-time code, public-origin/proxy-token wiring. A normal deployment that changes only `image` and `build.context` cannot pass the new admin initialization or trusted remote TLS proxy gate. New code would refuse management access until out-of-band bootstrap/first change, and suspend currently enabled detailed capture.
- The configured canonical public check `https://clinepass.yeschoy.com/api/meta` failed DNS from the deployment host and an independent external fetch; a local client saw a connection reset. This predates the proposed switch. The host Nginx config is valid but has **no** `server_name clinepass.yeschoy.com`; forced local vhost TLS presents a Cloudflare Origin CA certificate that is not browser-trusted directly and returned 404 even with a diagnostic-only insecure curl. `cloudflared` runs in host-network token mode with no config mount; its dashboard-managed public ingress and Header injection cannot be verified from this host. A remote browser first-login path is therefore **not proven**.

## Required decision / gates before proceeding

1. Establish and verify the actual browser-accessible HTTPS host and its current Cloudflare tunnel → trusted proxy → app path, including Host/Origin and stripping/replacing both `X-Forwarded-Proto` and `X-Cline-Pass-Proxy-Token`. Do not accept arbitrary private-network forwarding Headers or bypass TLS/attestation.
2. Approve a narrowly scoped **auth-migration exception** to the current two-field Compose-switch rule for private environment wiring, plus a trusted method to supply a private 64-hex reverse-proxy token and separate one-time initialization code. Never put secret values into Git, chat, commands, service logs or this report. Operators must obtain the one-time code over a trusted out-of-band channel for remote first password change.
3. Before any live mutation, copy/admin-back up current Compose, deployment state and operator config/metadata (including `admin-auth.json` when present), rehearse the exact committed image on isolated copies under UID/GID 1000:1000, and test rollback with old shared-key management ingress isolated. Keep future unredacted raw-body mode off.
4. Once the above are proven, merge to local `main`, run the full gate on committed `HEAD`, push so `main == origin/main`, then build an allowlisted immutable release and perform the normal no-build switch/health/auth/internal/public/hash checks. Any gate failure leaves or restores the old healthy container.

Production remains on the prior release; this report does not authorize a live switch or a production secret-generation operation by itself.
