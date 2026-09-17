# Verification

## Automated checks

Executed after the final full-scope `trellis-check` fixes:

```text
node --check server.js                                      PASS
node --check lib/jsonl-log-store.js                         PASS
env -u DATA_DIR -u CLINE_PASS_KEY -u PROXY_KEY \
    -u PUBLIC_BASE_URL -u PORT -u BIND_HOST npm test        PASS (146/146)
git diff --check HEAD                                       PASS
```

Focused coverage includes configuration migration/strict validation/old-client preservation, dormant non-sticky behavior, quota owner withdrawal on mode changes, stable priority+ID active selection, soft-state stability, hard-state replacement, immediate no-active standby, capacity waiting/standby overflow/429, safe request-log projection, complete frontend drafts, raw scheduling and cache preset preview/cancel/apply.

## Real-browser evidence

A temporary localhost-only instance used three dummy accounts and a localhost fake upstream. It did not contact production or external model providers and was removed after validation. Browser: Chrome 153 on macOS through local CDP.

Artifacts:

- `research/browser-validation.json`
- `research/browser-desktop.png`
- `research/browser-narrow.png`

Observed:

- 1280×900: document width stayed within the viewport; cache-pool input/help, two `缓存活跃` rows, one `缓存备用` row and full long account names/titles rendered; all table wrappers retained horizontal overflow ownership.
- Cache preset: preview showed pool `0 → 2`, wait `2000 → 5000`, three editable priorities; cancel left the local draft at pool 0/wait 2000, cleared pending state, and the persisted localhost server value remained 2.
- Raw scheduling dialog: opened with focus on the JSON textarea, contained `cachePoolSize`, closed through Escape, and returned focus to the opener.
- Pipeline keyboard-equivalent control updated the ordered draft and polite live status.
- Accessibility tree exposed the cache-pool label, cache preset and raw-config button; the live region was `aria-live="polite"`.
- 390×844: document width equaled viewport width, cache input and preview button remained visible, and the 980px account table scrolled inside a 340px `.table-wrap` rather than overflowing the document.

## Scope and residual risk

- NewAPI, CPA, production configuration, containers and deployment state were not modified.
- Production rollout was not performed, so no claim is made that request cache-hit rate has reached 70%.
- NewAPI still does not deliver an explicit session key; Switcher continues to rely on its existing message-HMAC fallback for this traffic.
- A later separately approved production trial must enforce the PRD’s 24-hour/1,000-sample target and rollback guardrails.
