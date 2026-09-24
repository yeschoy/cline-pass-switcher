# Production Deployment Guidelines

> Durable deployment contract for the Cline Pass Switcher production host.

---

## Scenario: Versioned in-place production deployment

### 1. Scope / Trigger

Use this contract whenever the user asks to deploy this repository to “remote,” “the server,” or production without naming another target.

The canonical target is fixed for this project. Do not ask which server to use unless the user explicitly overrides it.

### 2. Signatures

```text
SSH target:       ubuntu@167.114.158.4:49555
Repository root:  git rev-parse --show-toplevel
SSH identity:     <repository-root>/167.114.158.4_ubuntu_49555_ed25519
Remote root:      /opt/cline-pass-switcher
Compose file:     /opt/cline-pass-switcher/compose.yml
Service/container: cline-pass-console
Runtime user:      1000:1000
Release modes:     directories 0755; regular files 0644
Local bind check: http://127.0.0.1:3123/api/meta
Public check:     https://clinepass.yeschoy.com/api/meta
```

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
IDENTITY="$REPO_ROOT/167.114.158.4_ubuntu_49555_ed25519"
ssh -o BatchMode=yes -o ConnectTimeout=10 \
  -i "$IDENTITY" \
  -p 49555 ubuntu@167.114.158.4
```

### 3. Contracts

#### Target and key safety

- “Deploy remote” means the SSH target above unless the user names another host.
- The identity file is repository-local, mode `0600`, and gitignored. Resolve it from `git rev-parse --show-toplevel`; abort if the repository root, exact file, ignore rule, or mode check fails. Never search for a fallback key or directly read, print, copy, upload, edit, or commit its contents; pass only the resolved path to `ssh`/`scp`.
- Use `BatchMode=yes` and a bounded connection timeout so authentication failures stop without an interactive prompt.
- Do not assume the host has Node.js or another helper runtime merely because the application container does. Before any mutation, verify each host-side helper used by preflight; prefer existing `python3` for bounded JSON projections or run Node only inside the known application image/container. A missing helper must stop or fall back during read-only preflight, never after the compose switch.
- Pass release names, hashes and paths to remote helpers as validated positional arguments or fixed environment values. Do not interpolate them through nested local/SSH shell quoting. A quoting failure is retryable only while no release directory, backup or compose mutation exists; record the retry in deployment evidence.

#### Release layout and source

- Normal production releases must deploy a committed `HEAD` from local `main`, with local `main` already pushed and equal to `origin/main`. Completed feature/task branches are merged into `main` and pass the full gate before release creation; do not deploy a feature branch merely because its code is committed. A feature-branch deployment is allowed only as an explicit user-approved emergency exception, must be labelled as such in evidence, and must be merged back to `main` immediately after stabilization.
- Never deploy uncommitted working-tree files. Build the upload with `git archive HEAD` from `main` and an explicit allowlist: `Dockerfile`, package manifests, `server.js`, `lib/`, `public/`, `README.md`, `LICENSE`, `.dockerignore`, and `config.example.json`.
- Install the archive under `/opt/cline-pass-switcher/releases/<release>/`. Never overwrite an existing release directory.
- A restrictive deployment `umask` must not make the Docker build context unreadable by the production runtime user. After extraction, normalize release directories to `0755` and regular files to `0644`, then verify those modes before building. `Dockerfile COPY` preserves context modes; root-owned `0600` application files make the hardened `1000:1000` container exit with `EACCES` before health checks can pass.
- Preserve the existing hardened compose settings. Change only the `cline-pass-switcher:<release>` image tag and `build.context: ./releases/<release>`.

#### Data, switching, and rollback

- Never replace, upload, print, or manually edit production `data/config.json` as part of deployment. Record its SHA-256 before and after; without a declared schema migration they must match.
- A release that intentionally normalizes a new persisted configuration field may use a predicted post-migration hash only after running the committed image against byte-for-byte config/metadata copies. The copied result must differ solely by the documented non-secret schema projection, and its SHA-256 becomes the exact post-switch gate. Preserve the original bytes for rollback; any additional live diff or hash mismatch requires config restoration and rollback. This exception never permits uploading a local config or printing secrets.
- Before switching, copy `compose.yml`, `deployment.json`, `data/config.json`, `data/metadata.json`, and the independent `data/admin-auth.json` when present into private versioned backup/verification paths. Missing admin state on a legacy release requires an explicit one-time bootstrap plan with independent private code and effective client-key seed (or separate nonempty seed when the client key is empty). Configure the public HTTPS origin and a private 64-character lowercase-hex `CLINE_PASS_ADMIN_PROXY_TOKEN` shared only with the TLS reverse proxy (which replaces the incoming proxy-attestation Header), rehearse the first password change and management-script Cookie/CSRF migration against a private data copy before live switch; never log the code, password, proxy token, cookie, CSRF token or verifier. Metadata may legitimately change while the service runs; retain its backup and report both hashes.
- Build with the exact candidate Compose/project directory that will be installed, capture its image ID, and use that exact Compose-built image for source/mode checks and any copied-data migration rehearsal. Before touching the live Compose file, start the image against an isolated data copy with the production `1000:1000`, read-only-root, dropped-capability, no-new-privileges, and tmpfs settings; require the process to remain running and reach its startup marker.
- Atomically install the already-built candidate Compose and switch with `docker compose ... up -d --no-build`. Require `cline-pass-console` to be `running`, `healthy`, on the captured image ID, with zero restarts. Never rebuild during the switch because Compose provenance labels can produce a different image identity from a prior direct build.
- Roll back the compose file and restore the previous healthy container with `up -d --no-build` when build, startup, health, local endpoint, authenticated management API, internal network alias, or config-hash validation fails. For an auth-migration rollback, retain and restore the private admin-state backup when reapplying the new release. The old image's shared client-key management bypass returns during rollback: isolate management ingress and keep detailed content capture off until the independent-login release is restored; never claim the old image preserves the new boundary. When a declared config migration was applied, rollback also restores the original backed-up config bytes before starting the previous image.
- Rollback automation must detect whether execution actually crossed the live-mutation boundary before stopping a container. A failure while preparing backups, reading modes, or staging the candidate—before Compose/data/image state changes—requires a proved no-op recovery and must not stop or restart the still-healthy old container. Before the live switch, exercise atomic replacement/restore helpers against private scratch files and require the old Compose/config hashes plus exact running image to remain unchanged.
- Do not prune releases, images, build cache, logs, or operator data during deployment.

#### Endpoint policy

- Required release gates are the local `/api/meta`, authenticated `/api/models`, `/api/statistics`, request-log and detailed-log settings projections, quota-refresh input rejection, and the `ai-internal` network alias.
- Check the public hostname when DNS is available. A DNS failure that is reproduced before switching on both the deploy host and an independent client is an external pre-existing dependency failure: report it, but do not reinterpret the deployment target or roll back an otherwise healthy release solely for that DNS condition.
- Never print `proxyKey`; read it only inside the remote process to make authenticated loopback checks, then unset it.

#### New API Chat runtime integration (operator guidance, not a deployment instruction)

- The supported path is New API → Switcher `/v1/chat/completions` over HTTP/1.1 → Cline. Switcher's default inbound between-request idle is 95000 ms, with `headersTimeout = keepAliveTimeout + 5000` (100000 ms by default), slightly longer than New API's documented 90-second outbound idle pool. Set these from the strictly bounded runtime environment in `database-guidelines.md` when the actual intermediary has different limits; do not change persisted config to tune sockets or SSE timers. Reuse is conditional on the proxy/upstream also keeping connections open.
- Disable SSE response buffering at each reverse proxy on this path. Switcher sends `: PING\n\n` downstream after a valid first `data:` event, at complete SSE event boundaries and after 25000 ms of upstream silence by default; `CLINE_PASS_SSE_HEARTBEAT_MS=0` disables only that comment. New API's upstream scanner can reset its idle window on these comments without presenting model chunks. This does **not** keep New API → final client alive: enable New API's **existing** downstream ping setting separately if required. Do not claim to have modified New API.
- An upstream that never sends a first data event still hits Switcher's 120000 ms wall deadline (including headers and any comment prelude); an already-started but permanently silent Cline stream still hits its 360000 ms upstream socket idle timeout despite downstream pings. New API's ordinary Chat path may not propagate final-client cancellation immediately before Switcher has responded with headers; the first-event deadline bounds that gap, not an instant abort.
- Roll back by setting `CLINE_PASS_SSE_HEARTBEAT_MS=0` to stop comments, or use the normal committed-HEAD rollback path for the full connection-pool change. Neither switcher nor this deployment procedure offers inbound HTTP/2/h2c, `/v1/realtime` WebSocket, or `/v1/responses` routing. No production or live-New-API verification is implied by local integration tests; Node >=18 is the target but Node 18 execution remains unverified (local mock tests ran on Node 26; Docker daemon unavailable).

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| SSH identity is missing, readable by others, or authentication fails | Stop before upload or mutation |
| A host-side preflight helper is unavailable | Use an already verified host runtime or the known container runtime while still read-only; otherwise stop before upload/mutation |
| A nested-shell/argument quoting check fails | Prove no release/backup/compose mutation occurred, then retry with positional arguments; otherwise stop and inspect state |
| Deployment orchestration fails before candidate Compose/data installation | Prove current hashes/image are unchanged and leave the healthy old container running; do not invoke a stop-first rollback path |
| Atomic replacement/restore helper fails its private scratch self-test | Stop before the live mutation boundary; preserve evidence and fix the helper before a new attempt |
| Deployment source is not `main`, or local `main` differs from `origin/main` | Stop before release creation; merge, run the full gate and push `main` first unless the user explicitly authorizes a documented emergency exception |
| Local deployment files are dirty but not committed | Archive committed `main` HEAD; do not include working-tree content |
| Release directory already exists or uploaded hashes differ | Stop before compose change |
| Extracted source or built `/app` files are not readable by runtime UID/GID `1000:1000` | Stop before compose change; use a new immutable release with normalized `0755` directories and `0644` files |
| Hardened isolated startup exits, restarts, or never reaches its startup marker | Stop before compose change and preserve its bounded logs |
| Build/start/health/image check fails | Restore previous compose and wait for previous image to become healthy |
| `data/config.json` hash changes without a declared migration, or differs from the copy-predicted migration hash | Restore the backed-up config, roll back, and report |
| Authenticated loopback API or internal network alias fails | Roll back and retain evidence |
| Public DNS was already unavailable before switching | Continue only with all required local/internal gates; report public ingress as degraded |
| An intermediary buffers SSE or has a shorter idle threshold than the heartbeat | The Switcher cannot guarantee streaming keepalive through it; configure the intermediary/interval, validate end-to-end before claiming success |
| Switcher comments arrive at New API but the final client still idles out | Enable New API's existing downstream ping where needed; Switcher comments alone cover only New API ← Switcher |
| Public endpoint fails despite working DNS | Treat as deployment validation failure and roll back |
| Deployment succeeds | Atomically update `deployment.json` with release, commit, source hashes, previous release, safe verification facts, and no secrets |

### 5. Good / Base / Bad Cases

- **Good:** archive committed `HEAD`, verify release hashes, back up state, switch two compose fields, wait for health, verify local/authenticated/internal routes, and record a safe report.
- **Good:** verify `python3` (or another chosen host helper) during read-only preflight and pass the expected archive hash as a positional argument to the remote verifier.
- **Good:** normalize the immutable release tree to `0755`/`0644`, verify the built image modes, and run the candidate successfully as UID/GID `1000:1000` with the production hardening settings before switching.
- **Base:** the public hostname has a known pre-switch DNS outage; the new container passes every local/internal gate, deployment stays active, and the DNS limitation is reported separately.
- **Bad:** ask which server to use even though the user said “remote” and this contract defines the canonical host.
- **Bad:** use `scp -r .`, which can upload gitignored credentials, local data, `.pi`, `.trellis`, or unrelated dirty files.
- **Bad:** print the admin key in logs or pass it through a parent-visible command line.
- **Bad:** extract under `umask 077`, build root-owned `0600` JavaScript files, and test only as container root; production UID/GID `1000:1000` will fail before listening.
- **Good:** a local/mock New API-style HTTP/1.1 client reuses a Switcher socket beyond five seconds and a line scanner ignores comments as chunks; an operator separately enables New API's downstream ping and disables intermediary buffering.
- **Bad:** assume host-level `node` exists or embed a local hash inside a multiply nested quoted SSH command; both can fail at an ambiguous operational boundary.
- **Bad:** promise final-client keepalive merely because Switcher emits pings, or describe local Node 26 tests as proof of production/New API/Node 18 behavior.

### 6. Tests Required

Before switching:

- for New API Chat deployments, inspect (without printing secrets) the chosen HTTP/1.1 upstream path, intermediary SSE buffering/idle settings and whether New API's own downstream ping is needed; local `test/integration.test.js` covers inbound socket reuse >5 seconds, direct and proxy tunnel reuse, comment-filtering scanner, first-data/stream-idle separation, backpressure and graceful SSE finalization, but cannot replace a staging end-to-end check against the actual topology or a Node 18 runtime run;
- prove the checked-out deployment source is `main` and local `main` equals `origin/main`;
- run the repository full test suite against committed code;
- verify the identity path is gitignored and mode `0600` without reading it;
- verify host-side helper runtime availability and argument passing during read-only preflight;
- inspect the current container/image/health, account count/mode, safe `/api/meta`, disk space, and config hash;
- verify release-tree and built-image application modes are readable by UID/GID `1000:1000`;
- exercise atomic install/restore helpers on private scratch files and prove the rollback no-op guard will not stop the old container before any live mutation;
- run the exact Compose-built candidate against isolated copied data with the production runtime user and hardening settings, and require successful startup without touching live data;
- for a declared config migration, run the committed image only against copied data, verify the exact documented structural diff, and record the predicted post-migration hash;
- verify uploaded `server.js`, `public/index.html`, and security-sensitive module hashes match local `HEAD`.

After switching:

- require healthy/current image and zero restarts;
- inspect bounded startup logs for fatal config/metadata errors;
- validate local and authenticated management projections without exposing credentials;
- assert account count/mode are unchanged and `config.json` equals either its original hash or the declared copy-predicted migration hash;
- verify the internal `cline-pass-switcher` alias;
- save a safe verification report and preserve rollback artifacts.

### 7. Wrong vs Correct

#### Wrong

```bash
scp -r . ubuntu@167.114.158.4:/opt/cline-pass-switcher
ssh ubuntu@167.114.158.4 'docker compose up -d --build'
```

#### Correct

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
IDENTITY="$REPO_ROOT/167.114.158.4_ubuntu_49555_ed25519"
git -C "$REPO_ROOT" archive --format=tar --output="$release.tar" HEAD -- \
  Dockerfile package.json package-lock.json server.js lib public \
  README.md LICENSE .dockerignore config.example.json
scp -o BatchMode=yes -o ConnectTimeout=10 -i "$IDENTITY" -P 49555 \
  "$release.tar" ubuntu@167.114.158.4:/tmp/
# Remote: verify hashes, extract into a new immutable release, then normalize
# directories to 0755 and regular files to 0644. Build with the final Compose
# path, verify the image as UID/GID 1000:1000 under production hardening, back
# up state, install the two-field Compose change, and switch with --no-build.
# On any hard-gate failure, restore the previous Compose with --no-build.
```
