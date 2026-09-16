# Design: Direct Production Deployment of Quota Forecast Panel

## Release Boundary

Deploy the current committed `HEAD` from branch `feat/quota-forecast-panel`. Generate a tar archive with `git archive HEAD` and the deployment-spec allowlist only. Unrelated dirty files remain outside the archive by construction.

Release identity is immutable and unique, using a UTC timestamp, short source commit and `quota-forecast` suffix. The remote release directory and image tag use that same identity.

## Preflight

1. Resolve repository root and exact repository-local SSH identity path without reading the identity contents.
2. Require identity existence, mode `0600`, gitignore match, `BatchMode=yes` authentication, and bounded connect timeout.
3. Record local source commit, archive SHA-256 and hashes for `server.js`, `public/index.html`, and security-sensitive `lib/` modules from committed `HEAD`.
4. Read only safe remote projections: current compose/deployment identity, container image/status/health/restarts/OOM, disk space, config hash, account count/mode, and safe `/api/meta`.
5. Probe public DNS/endpoint before switching. A reproduced pre-existing DNS outage is recorded but does not replace required local/internal gates.

No configuration migration preflight is required because the application change is frontend-only and introduces no persisted field.

## Install and Direct Switch

1. Upload the committed allowlist archive to a unique temporary path.
2. Refuse to continue if the target release directory exists.
3. Create the release directory, extract the archive, and verify archive plus key-file hashes against local committed values.
4. Save versioned copies of compose, deployment metadata, config and metadata under the release verification/backup area.
5. Produce a candidate compose that changes only:
   - image tag to `cline-pass-switcher:<release>`;
   - build context to `./releases/<release>`.
6. Atomically install the candidate compose and run `docker compose -f compose.yml up -d --build` once. There is no canary or traffic split.

## Gates and Rollback

After switching, require within bounded waits:

- container running/healthy, zero restarts, not OOM-killed, requested image;
- bounded startup logs free of fatal config/metadata/persistence indicators;
- local `/api/meta` 200;
- authenticated `/api/models`, `/api/statistics`, request logs and detailed-log settings 200;
- malformed quota refresh request rejected before work;
- `ai-internal` resolves the `cline-pass-switcher` alias and reaches `/api/meta`;
- served console HTML includes `statisticsQuotaForecastTitle`;
- account count/mode equal preflight values;
- `data/config.json` hash exactly equals the preflight hash.

Any hard-gate failure triggers rollback: restore the backed-up compose, run compose up, require the previous image/container to become healthy, retain all evidence, and report failure. Because no migration exists, production config is never rewritten or restored unless an unexpected mutation occurred; if it did, restore the exact backed-up bytes before starting the previous image.

## Success Record

Write a bounded secret-free verification report and atomically update `deployment.json` with release, full source commit, previous release, archive/key-file hashes, timestamps and safe gate results. Preserve release directories, images, build cache, logs, backups and temporary diagnostic evidence.

## Security

The admin key is used only inside the remote process for loopback checks and is never echoed or placed in a parent-visible command line. Reports contain only safe booleans/counts/hashes/statuses. SSH identity contents and account credentials are never read into agent output.
