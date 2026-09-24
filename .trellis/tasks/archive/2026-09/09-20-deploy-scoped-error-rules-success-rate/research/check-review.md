# Independent deployment check review

## Result

The deployed runtime and retained deployment evidence satisfy the production integrity gates. No production defect or rollback condition was found. One workflow completion gate remains open: the task research directory is still untracked, so the sanitized evidence has not yet been committed/pushed and the task has not been archived. The delegated check explicitly prohibited committing, switching, restarting, production mutation, cleanup, or task archival.

## Fresh read-only postcheck

At `2026-09-20T05:25:48.524922+00:00`, a new bounded remote projection verified:

- exact image `sha256:615df03dddc5883a769024e5f34146d6fbaf02a13cc9694feab3d1a16939ce55`;
- running/healthy, restart count 0, OOM false;
- live Compose hash exact and byte-equivalent to the backed-up Compose after exactly one image-tag and one build-context replacement;
- immutable release tree present with all directories 0755 and regular files 0644;
- container source hashes equal committed `HEAD` for server, UI and diagnostic modules;
- live config hash equals the copied-data prediction, with 10 accounts / 8 enabled, sticky mode, wait 2000, five canonical account-scope ignore rules and the canonical three-step pipeline;
- statistics v4, truthful account/Provider tracking starts, 85 Provider status rows, 10 quota rows and no hard-quarantined Provider rows;
- authenticated accounts/models/statistics/request-log/error-log/detailed-settings APIs return JSON 200; invalid quota-refresh input returns JSON 400;
- the `new-api` internal alias reaches the public metadata endpoint;
- the final deployment record points to the exact release/commit/new and previous images;
- final backup hashes, previous image availability, rollback record and atomic helper remain present;
- public DNS still fails with the same bounded `gaierror` category.

The first postcheck invocation used the unprivileged SSH user and stopped on the owner-only `deployment.json` with `PermissionError`. It was read-only and made no remote change. The retry used non-interactive `sudo -n` only for the same bounded projector and passed.

## Acceptance review

1. **Source gate — passed.** Local `HEAD`, `main` and `origin/main` all equal `c78d8bbb552943910af341733950cde656cf8c1c`; required commits are ancestors. The deterministic allowlisted archive and all five critical source hashes reproduce the retained candidate evidence. The retained full gate is 169/169 tests, and identity path/gitignore/0600 plus BatchMode SSH are evidenced.
2. **Read-only baseline — passed.** The preflight records the previous exact image, health/restart/OOM, file/log hashes, safe schema/count projections, authenticated/local/internal APIs, and remote plus independent public DNS baseline without raw business data.
3. **Immutable candidate — passed.** The unique release, exact Compose-built image, 0755/0644 modes and two-line image/context-only Compose change are evidenced and freshly rechecked.
4. **Copied-data migration — passed.** `backup-final2` proves exact business projection, five ordered canonical rules, folded three-step pipeline, v3→v4 migration with empty direct-health owners, 85 normalized Provider rows, old-fact preservation, ordinary-log byte preservation/queryability and second-start byte idempotence.
5. **Backup/rollback — passed.** Final versioned backup hashes, old image, scratch restore, drift guard, crossed-boundary record and no-build rollback references are retained and freshly present.
6. **Post-switch container/data — passed.** Exact image, health, zero restarts/OOM, source/config hashes and safe schema projections passed immediate, delayed, independent and fresh checks. Delayed UI/source truth follows from its exact immutable image identity; immediate markers and independent source hashes bind that image to the committed UI.
7. **Immediate/90-second/independent gates — passed.** All retained API/internal/log gates point to the same image/Compose/config. The fresh check repeats every required authenticated API, invalid quota rejection and internal alias gate.
8. **Operational non-interference — passed with stated evidence boundary.** The predicted config hash and exact business projection prove no business-config change beyond declared migration. Ordinary logs retained the same hash through the deployment evidence, and the deployment report attests that no real model request or NewAPI/CPA operation was issued. Fresh inspection shows `new-api` still running with restart 0 and a start time before this deployment. An arbitrary external CPA non-change is procedural/negative evidence and cannot be independently reconstructed from this repository alone.
9. **Public baseline — passed as degraded external dependency.** Remote and independent clients both had pre-switch DNS failure; retained and fresh postchecks reproduce `gaierror`, so it is not a rollback condition.
10. **Evidence lifecycle — pending.** Sanitized evidence exists and passes review, but the research directory is untracked. Commit/push and Trellis archival remain for the main session.

## Local evidence validation

- All 10 JSON evidence files parse successfully.
- Cross-file commit/image/Compose/config/backup/deployment hashes are consistent.
- Credential-shaped, email/account-name, UUID-v4, credential-URL, Bearer/JWT/private-key marker and sensitive JSON-key scan found zero hits.
- No trailing whitespace was found in task artifacts.
- `git diff --check` passed.

## Residual risks

- No paid/model failure was injected, by design; production failover behavior relies on the 169-test local mock suite rather than a live fault injection.
- Direct success-rate windows are intentionally immature. The fresh projection has one account-health and one Provider-health cell, which is expected post-migration accumulation and must not be interpreted as a mature 24-hour rate.
- Public ingress remains unavailable because of the pre-existing DNS failure.
- No cleanup was performed; Trellis evidence and all production release/image/backup/log artifacts remain retained.
