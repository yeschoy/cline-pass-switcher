# Live Cline Quota Reset-Time Evidence

Date: 2026-09-16 UTC

A read-only request from the production container to the existing account-bound endpoint returned:

- HTTP 200
- `Content-Type: application/json`
- `success: true`
- `data.limits`: three rows with `type`, finite numeric `percentUsed`, and string `resetsAt`
- row types: `five_hour`, `weekly`, `monthly`

Representative reset times:

```text
2026-09-16T01:41:26.552188975Z
2026-09-19T15:02:26.554459647Z
2026-10-12T15:02:26.556754049Z
```

All are parseable by `Date.parse()` and normalize with `Date#toISOString()` to millisecond UTC values, but `server.js:311-313` rejects them before parsing because its fractional-second regex permits only 1–3 digits. That rejection causes `parseQuotaPayload()` to classify the otherwise valid snapshot as `schema`, matching the UI failure for all accounts.

No account key, account identity, response body, or credential was copied into this evidence. The endpoint, authentication, proxy, size, timeout and failure/backoff flow do not need to change.
