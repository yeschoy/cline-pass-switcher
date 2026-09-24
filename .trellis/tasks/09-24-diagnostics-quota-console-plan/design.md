# Cross-feature design map (planning draft)

## Ownership and order

This parent owns the integration contract only. Each child has a separate PRD, design, implementation gate and acceptance. Shared source owners are `server.js` for auth/quota/stats/routing, `lib/detailed-log-capture.js` and `lib/detailed-log-store.js` for diagnostic bytes, and `public/index.html` for the console. Do not run concurrent writers on these files; implement the children sequentially.

1. `09-24-separate-console-login` first. No unredacted detail data may be captured or served until client API keys cannot administer management endpoints and the admin has completed the first password change.
2. `09-24-monthly-quota-statistics` establishes the presentation and validated reference conversion for the three windows. `09-24-quota-exhaustion-protection` consumes the same quota source and config contract, not another fetch queue.
3. `09-24-model-provider-statistics` reuses existing model usage and provider-model health projections, extending the single statistics owner for attributed provider usage and reference-price calculation; does not infer real billing from the monthly reference quota.
4. `09-24-detailed-log-35mb` only after the admin gate, with a separate explicit default-off raw-body mode. It retains old sanitized groups and their seven-day contract while raw bodies expire at 48 hours. Raw bytes are a deliberate exception **only** to body sanitization; ordinary JSONL, headers, metadata and other configuration credentials stay bounded and protected.

## Cross-cutting contracts

- `DATA_DIR` remains the only owner of mutable operator data; all additions validate before atomic persistence, survive restart, and fail on malformed operator JSON without overwriting bytes. New admin secret storage is not readable via settings APIs. Raw-body access requires a real admin session, never the model client key.
- A low monthly reference balance never by itself changes routing. Account-specific quota signals trigger one existing deduped quota job and bounded temporary hold. Confirmed `status ∧ bounded content ∧ fresh monthly remaining < configurable $0.20 reference` triggers a persistent manual-release ban. 5h/week temporary holds rejoin only after a new success proves *all* windows available and no monthly ban remains.
- Price estimates use ClinePass's published per-model reference rates and explicit usage, labelled non-billing reference USD. Unknown usage, provider attribution, peak/context pricing or stale prices must not silently become zero, invented dollars or provider usage.
- Existing request status, upstream bytes, cancellation, retry/account-lease lifecycle and ordinary log privacy are not changed by any observation or raw-body capture failure. Separate cached usage/health models preserve known zero versus unknown.

## Integration/rollout boundary

No production operation is authorized by planning. Deployment, when separately requested, uses committed main HEAD and the deployment guidelines. Migrating admin auth needs a reversible plan without an API-key management backdoor; raw-body mode must remain off across migrations and rollback. The existing deployment pre-switch backup contract copies config/metadata, not detailed bodies, but unknown external backups need explicit operator guidance so 48h source retention is not represented as a backup guarantee.

## Open design gates

- Decide where the independent one-time admin bootstrap code is supplied without placing it in responses, project files or ordinary service logs; bound login attempts and session lifetime.
- Decide the supported `MB`/`MiB` display; tentatively 35 MiB per body and 512 MiB reserved payload (not RSS).
- For raw bodies, document whether the 48-hour retention policy covers operator-created backups; default recommendation is exclusion of raw logs from backups.
- Review each child's PRD for unresolved product choices before writing implementation code; this parent is not a direct implementation target.
