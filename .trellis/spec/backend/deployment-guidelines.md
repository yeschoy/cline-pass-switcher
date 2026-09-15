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

#### Release layout and source

- Deploy a committed local `HEAD`, not uncommitted working-tree files. Build the upload with `git archive HEAD` and an explicit allowlist: `Dockerfile`, package manifests, `server.js`, `lib/`, `public/`, `README.md`, `LICENSE`, `.dockerignore`, and `config.example.json`.
- Install the archive under `/opt/cline-pass-switcher/releases/<release>/`. Never overwrite an existing release directory.
- Preserve the existing hardened compose settings. Change only the `cline-pass-switcher:<release>` image tag and `build.context: ./releases/<release>`.

#### Data, switching, and rollback

- Never replace, upload, print, or edit production `data/config.json` as part of deployment. Record its SHA-256 before and after; they must match.
- Before switching, copy `compose.yml`, `deployment.json`, `data/config.json`, and `data/metadata.json` into versioned backup/verification paths. Metadata may legitimately change while the service runs; retain its backup and report both hashes.
- Run `docker compose -f compose.yml up -d --build`, then require `cline-pass-console` to be `running`, `healthy`, on the requested image, with zero restarts.
- Roll back the compose file and restore the previous healthy container when build, startup, health, local endpoint, authenticated management API, internal network alias, or config-hash validation fails. Retain the failed release, image, logs, and backups for diagnosis.
- Do not prune releases, images, build cache, logs, or operator data during deployment.

#### Endpoint policy

- Required release gates are the local `/api/meta`, authenticated `/api/models`, `/api/statistics`, request-log and detailed-log settings projections, quota-refresh input rejection, and the `ai-internal` network alias.
- Check the public hostname when DNS is available. A DNS failure that is reproduced before switching on both the deploy host and an independent client is an external pre-existing dependency failure: report it, but do not reinterpret the deployment target or roll back an otherwise healthy release solely for that DNS condition.
- Never print `proxyKey`; read it only inside the remote process to make authenticated loopback checks, then unset it.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| SSH identity is missing, readable by others, or authentication fails | Stop before upload or mutation |
| Local deployment files are dirty but not committed | Archive committed `HEAD`; do not include working-tree content |
| Release directory already exists or uploaded hashes differ | Stop before compose change |
| Build/start/health/image check fails | Restore previous compose and wait for previous image to become healthy |
| `data/config.json` hash changes | Restore the backed-up config, roll back, and report |
| Authenticated loopback API or internal network alias fails | Roll back and retain evidence |
| Public DNS was already unavailable before switching | Continue only with all required local/internal gates; report public ingress as degraded |
| Public endpoint fails despite working DNS | Treat as deployment validation failure and roll back |
| Deployment succeeds | Atomically update `deployment.json` with release, commit, source hashes, previous release, safe verification facts, and no secrets |

### 5. Good / Base / Bad Cases

- **Good:** archive committed `HEAD`, verify release hashes, back up state, switch two compose fields, wait for health, verify local/authenticated/internal routes, and record a safe report.
- **Base:** the public hostname has a known pre-switch DNS outage; the new container passes every local/internal gate, deployment stays active, and the DNS limitation is reported separately.
- **Bad:** ask which server to use even though the user said “remote” and this contract defines the canonical host.
- **Bad:** use `scp -r .`, which can upload gitignored credentials, local data, `.pi`, `.trellis`, or unrelated dirty files.
- **Bad:** print the admin key in logs or pass it through a parent-visible command line.

### 6. Tests Required

Before switching:

- run the repository full test suite against committed code;
- verify the identity path is gitignored and mode `0600` without reading it;
- inspect the current container/image/health, account count/mode, safe `/api/meta`, disk space, and config hash;
- verify uploaded `server.js`, `public/index.html`, and security-sensitive module hashes match local `HEAD`.

After switching:

- require healthy/current image and zero restarts;
- inspect bounded startup logs for fatal config/metadata errors;
- validate local and authenticated management projections without exposing credentials;
- assert account count/mode and `config.json` hash are unchanged;
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
# Remote: verify hashes, back up state, switch the two compose fields,
# require health/API/data checks, and restore the previous compose on failure.
```
