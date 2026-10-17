# Design: per-account HTML 429 backoff + clearer message

## Boundaries

- Owner: `server.js` gateway throttle map + non-JSON upstream unwrap message.
- Spec: `quality-guidelines.md` (backoff key semantics), `logging-guidelines.md` (projection unchanged except message/note text).
- Tests: `test/workflow-integration.test.js` gateway HTML 429 case; extend for two accounts sharing `proxyUrl`.

## Behavior

### Before

- Backoff map key = `account.proxyUrl || ''` (same proxy or all direct accounts share one window).
- Non-JSON 429 body message = `upstream returned an invalid error response` / `upstream_error`.

### After

- Backoff map key = stable `account.id` (missing id treated as empty string only as fail-safe; production accounts always have id).
- Same account: concurrent HTML 429s still share that account’s window; streak/1s→8s/jitter/`GATEWAY_THROTTLE_RETRIES=1` unchanged.
- Different accounts (even same `proxyUrl`): independent windows.
- Success still clears only that account’s key.
- Still bypass `errorRules` / no durable cooldown / no provider health sample / same-provider one retry.
- When `upstreamStatus===429` && `responseContentType==='text/html'` && no JSON body: client message like `upstream gateway rate limited (HTML throttle)`, `type: rate_limit_error`. Other non-JSON failures keep the generic invalid-response wording.

### Explicit non-goals

- Prove or disprove IP-based throttling.
- Rotate proxy/account on HTML 429.
- Assign a configured `ruleId` or durable cooldown.

## Compatibility

- Ordinary log fields `errorScope` / `scopeEvidence` / `ruleId=null` / `matchedBy:default` unchanged.
- NewAPI and clients will see a different 429 message string; treat as intentional.

## Rollout / rollback

- Code-only; no DATA_DIR schema change. Rollback = revert release image.
