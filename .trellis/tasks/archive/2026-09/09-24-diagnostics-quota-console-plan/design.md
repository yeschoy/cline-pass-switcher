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

The planning artifact itself does not authorize production operations. The operator subsequently authorized a committed/pushed-main release; the new image is now running and healthy, but the production deployment record still awaits complete administrator acceptance. Deployment and any finalization follow the deployment guidelines. Migrating admin auth needs a reversible plan without an API-key management backdoor; raw-body mode must remain off across migrations and rollback. The baseline deployment contract requires config/metadata backup, and the previous production release procedure additionally copied detailed logs into a private backup. Therefore a future 48h raw-body source TTL cannot be claimed for existing or new backups: raw diagnostics must be excluded from backups or covered by a separately enforced backup-expiry policy before raw capture is enabled.

## Resolved design choices and remaining release gates

- The admin bootstrap used a separate private one-time code, independent initialized verifier/session, bounded login attempts and session lifetime; no client-key management fallback. The authorized admin-login production migration is complete; the four later child implementations were subsequently deployed as default-off raw code in release `20260924-173240-32a150e3-diagnostics`. Final administrator acceptance remains pending.
- Raw text is an independent default-off mode: **35 MiB per body / 512 MiB shared retained reservation**, plus the 64 MiB sanitized-subset cap, neither an RSS cap. The deployed 512 MiB container lacks the required explicit readiness flag and ≥2 GiB limit, so raw cannot be enabled there. Valid owned raw groups become unreadable at 48h and are removed on startup/minute maintenance, including corrupt manifests; unknown/suspicious files remain inaccessible, undeleted and health-visible. Old sanitized groups keep 5 MiB/7d in the same store. Physical deletion can lag an IO failure or outage.
- External backups are not subject to the store TTL. The deployment contract now requires raw directory exclusion or an independently enforced private 48h expiry before any separately authorized raw production enablement; old-image management ingress/read-denial must be rehearsed on private copies. Target-container memory and actual-browser raw-panel acceptance also remain release gates.
- Each child was reviewed, implemented, checked, committed and archived independently. Parent local integration findings are in `integration-report.md`; this parent coordinates outstanding release gates, not direct code implementation or production readiness.
