# Operator-requested administrative closure — 2026-09-27 UTC

The operator requested that all remaining Trellis tasks be marked complete after being told that production raw-detail enablement had not passed its gates. Archiving is an administrative closure, **not** acceptance of live raw capture. Leave the unchecked PRD acceptance boxes unchanged.

- As of the last production release evidence, `rawBodyLogging=false`, the raw-readiness flag was absent, and the container memory limit was 512 MiB. The code-only release did not enable raw capture; see the latest deployment record under the archived 09-27 feature task.
- Sustained target-memory HTTP/SSE/admin-download testing, backup privacy/expiry, old-image rollback isolation, authenticated real-browser verification and a separately approved live cutover remain unverified or incomplete. Existing 2 GiB isolated stress results did not clear the full gate.
- This closure did not modify the production service, configuration, secrets or rollback backups. Reopening raw enablement requires a new explicit authorization and the original safety gates; a `completed` Trellis status is not that authorization.
