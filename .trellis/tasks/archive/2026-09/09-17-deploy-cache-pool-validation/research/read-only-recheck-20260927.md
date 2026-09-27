# Cache-pool read-only recheck — 2026-09-27

## Scope and outcome

The operator selected read-only acceptance of the **existing** cache pool, not deployment of the current feature branch. This check made no production POST, configuration/service change, release, paid chat request, or cleanup. SSH used the fixed gitignored 0600 identity with BatchMode, and private JSON was parsed only inside a remote `sudo -n python3` process; only bounded non-secret projections were output.

**Result: not yet eligible for a continuous-window acceptance decision.** The original size-2 / 5000 ms experiment cannot be validated from the current production window. The later configuration and release boundaries recorded in `version-boundary-20260919.md` and `version-boundary-20260920-affinity.md` remain applicable.

## Current production snapshot

- Observation: 2026-09-27 20:15:36.746 UTC; repeated container/config-mtime check at 20:16:51 UTC.
- Deployment record: `20260927-raw-off-4d4ee87`, commit `4d4ee8798f20a03e842d5cd52f21188bd1f0f88a`, `awaiting-admin-acceptance`. This read-only check does not complete independent administrator acceptance.
- Container: exact image `sha256:bd49772e0a42a2f4f90bc35ce32408485d411caca46efe40c4b13c959105669d`, running/healthy, restart count 0, OOM false, started 2026-09-27 20:09:18.619657 UTC. Loopback `/api/meta` returned 200. The repeated check found the same image/start, health and zero restarts/OOM.
- Configuration: sticky mode; 45 accounts, 43 enabled; per-owner cache-pool minimum 5, maximum 100, low-quota target 1, persisted current target 5; `concurrencyWaitMs=1000`. Config mtime 2026-09-27 20:09:18.583 UTC, unchanged at the repeated check. This differs from the original approved 2-account/5000 ms experiment; this check did not attribute those intervening operator changes.
- Persisted statistics schema version 5. The rolling 24-hour bucket projection contained 9,444 known cache requests and 9,083 cache hits (96.1775%), with 9,489 total requests and 10 errors. The cache-input token projection was 3,420,138,880 / 3,477,531,663 (98.3496%). **These are mixed rolling-window observations across earlier configuration/release boundaries, not a current-policy 24-hour result and not proof of the 70% acceptance criterion.** They also do not establish latency, overflow or account-health guardrails.

## Required next observation

If the operator wants acceptance of the **current size-5 policy**, freeze a new baseline and a stable start no earlier than the later of current process startup and configuration activation. With no further release, restart or policy change, 2-hour warmup plus a full 24-hour formal window would end **no earlier than 2026-09-28 22:09:18.620 UTC**. At that time, aggregate the exact UTC window, check at least 1,000 known-cache samples and all PRD guardrails, and distinguish unknown coverage from zero. Any subsequent code/config change, restart or incomplete statistics coverage invalidates that proposed window and requires a new boundary. The original size-2 result must remain unverified; do not silently re-label size-5 traffic as its outcome. A failed guardrail is report-only; no automatic production modification or rollback.
