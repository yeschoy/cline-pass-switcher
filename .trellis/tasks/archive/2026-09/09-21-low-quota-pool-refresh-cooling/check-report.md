# Low-Quota Pool — Independent Check Summary

## Result

Accepted after resolving a planning-text mismatch. The parent PRD requires unknown quota to remain excluded. `quotaProjection()` returns unknown for a partial snapshot; therefore a partial success with only `weekly=80` keeps `waiting-refresh`, while a partial known 100 confirms `quota-exhausted`. Only a newer successful **complete three-window snapshot**, all known values below 100, clears either disposition. Child `prd.md` R8/R9/AC and `design.md` §6 were corrected to this source contract; code/tests were not weakened.

## Reviewed Behavior

- `low=0` preserves old pool membership/selection; low>0 assigns the fixed low target, grows high only and projects actual high/low/unknown rather than claiming fillers met target roles.
- Exact 79.999/80/94.999/95/100 boundaries, known zero versus unknown, low-first/high-immediate-fallback with concurrency/RPM/hold, session binding without rebinding on temporary overflow.
- Rule and quota account-state dimensions are independent across expiry, manual recovery, identity changes and startup normalization; low account/degrade alone creates waiting-refresh/removal, post-start has no replay.
- Existing quota job remains the sole owner for deduplication/backoff/global two-slot admission. Partial known 100 can confirm exhaustion; failed/partial-non100 cannot clear it. Multiple resets, no valid reset, manual recovery and restart are covered.
- Strict startup rejects inconsistent quotaDisposition metadata before overwriting the existing bytes; pre-admission ordinary logs do not fabricate actual pool composition as all zeros; statistics UI does not claim routing is suspended while low-aware pool is off.

## Verification

- `node --check server.js`, `lib/*.js`, production inline `vm.Script`, `git diff --check`: pass.
- Focused `node --test test/low-quota-pool.test.js`: **14/14** before independent review; reviewer added further focused scenarios.
- Final `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test`: **233/233** (prior main baseline 210; no existing test removed).
- Mutation: converting `waiting-refresh` to an erroneous success-cache hit made its focused regression test fail, then source restored from a temporary backup.
- Browser verification: real Chrome/CDP at 375px, **6/6**, see `browser-verification.md`.

## Residual Risk

No dedicated stress fixture fills both global quota slots with multiple held accounts simultaneously; the shared queue and two-slot bound have existing integration coverage. No production deployment or live upstream was used.
