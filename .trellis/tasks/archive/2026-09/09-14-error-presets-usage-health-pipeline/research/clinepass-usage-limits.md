# ClinePass usage-limit endpoint research

## Conclusion

A live authenticated endpoint exists and is used by independent production clients:

```text
GET https://api.cline.bot/api/v1/users/me/plan/usage-limits
Authorization: Bearer <Cline API key>
Accept: application/json
```

The endpoint is not currently listed in Cline's public API overview/reference and the open-source `cline/cline` tree did not expose the route string. Treat it as a semi-documented provider contract: validate strictly, cache a last-known-good projection briefly, and fail open to ordinary routing when unavailable or changed.

A credential-free request on 2026-09-14 returned the expected Cline authentication error rather than 404, confirming the route is live:

```json
{"error":"Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account."}
```

## Verified payload shape

CodexBar's current ClinePass provider and tests validate this shape:

```json
{
  "success": true,
  "data": {
    "limits": [
      { "type": "five_hour", "percentUsed": 12.5, "resetsAt": "2026-07-16T10:20:30Z" },
      { "type": "weekly", "percentUsed": 34, "resetsAt": "2026-07-20T00:00:00Z" },
      { "type": "monthly", "percentUsed": 56.75, "resetsAt": "2026-08-01T00:00:00Z" }
    ]
  }
}
```

- Known `type` values: `five_hour`, `weekly`, `monthly`.
- `percentUsed` is a finite number. The external CodexBar client clamps it to 0–100; this project intentionally uses a stricter routing contract and rejects out-of-range values as a schema failure instead of creating a confident pool from a changed payload.
- `resetsAt` is optional/null; when present it is an ISO-8601 timestamp.
- Unknown limit types are ignored; malformed known rows must not replace a prior valid snapshot.
- CodexBar uses a 15-second timeout and classifies 401/403, 429, 5xx, other HTTP, JSON, and schema failures separately.

## Official product semantics

Cline's official ClinePass documentation confirms three limits:

- rolling 5-hour usage;
- calendar-week usage;
- calendar-month usage.

The documentation directs users to the Cline dashboard for current percentages but does not document the usage-limits endpoint in the public API reference.

## Sources

- Cline official ClinePass limits: https://docs.cline.bot/getting-started/clinepass
- Cline public API overview: https://docs.cline.bot/api/overview
- CodexBar implementation: https://raw.githubusercontent.com/steipete/CodexBar/main/Sources/CodexBarCore/Resources/Plugins/clinepass.ts
- CodexBar contract tests: https://raw.githubusercontent.com/steipete/CodexBar/main/Tests/CodexBarTests/ClinePassPluginTests.swift
- CodexBar provider documentation: https://github.com/steipete/CodexBar/blob/main/docs/providers.md
- dsh-spend independent implementation: https://raw.githubusercontent.com/nonewind/dsh-spend/main/lib/providers/quota-clinepass.js
- Earlier investigation history and fallback evidence: https://github.com/diegosouzapw/OmniRoute/issues/9740

## Integration constraints

- Never persist or log the account API key or Authorization header.
- Do not call the endpoint in the request-selection critical path.
- Refresh asynchronously with bounded concurrency and timeout.
- Keep only projected percentages/reset timestamps/fetch status keyed by stable account ID.
- On fetch/auth/schema failure, do not infer remaining quota from local token usage and do not mutate ban/cooldown state.
- Stale/unavailable quota becomes `unknown`; ordinary health/account-mode routing remains available.
