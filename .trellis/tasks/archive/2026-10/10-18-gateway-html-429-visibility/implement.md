# Implement checklist

1. [x] Change gateway backoff key from `proxyUrl` to `account.id`; rename helper for clarity; update call sites.
2. [x] On non-JSON HTTP 429 + `text/html`, set message `upstream gateway rate limited (HTML throttle)` and `type: rate_limit_error`.
3. [x] Extend workflow integration test: sibling account must not wait for throttled account’s window; existing no-cool/same-route + message assertions remain.
4. [x] Update `quality-guidelines.md` to per-account backoff; note IP hypothesis unverified.
5. [x] Validate: `node --check server.js`; `node --test test/workflow-integration.test.js` (30/30); `git diff --check`.

## Rollback

Revert the commit / image; no DATA_DIR migration.
