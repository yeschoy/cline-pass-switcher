# Verification evidence

## Isolation

- Worktree: `/Users/lyh_god/GolandProjects/cline-pass-switcher-upstream-affinity`
- Branch: `feat/upstream-session-affinity`
- Base: `74913e0cb691c208c4d9ebc54042d0e345acf858`
- The original `feat/quota-forecast-panel` worktree and any blue-green worktree/branch were not edited.
- No production, NewAPI, CPA, account pool or paid/live upstream was accessed.

## Automated checks

Final full project gate:

```text
node --check server.js                                      PASS
for file in lib/*.js; do node --check "$file"; done        PASS
embedded public/index.html vm.Script compilation            PASS
config.example.json JSON parse                              PASS
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL \
    -u PORT npm test                                         PASS (162/162)
git diff --check                                            PASS
```

Focused evidence also passed:

- Chat caller-key preservation, Claude derived key stability, parent/child affinity and ordinary-log secrecy;
- cache-hit true/false/null from explicit final usage;
- account-scoped probe/harvest/validation and account-auth isolation from global provider health;
- provider cooldown, disabled compatibility, parameter-4xx exclusion, concurrent single-owner half-open and stale route-generation fencing;
- statistics v1/v2→v3 migration, routing coverage, future-version fail-closed and independent model-cell retention;
- one-click setup proposal strategy, scope staleness, confirm-only persistence and cooldown UI contracts;
- complete integration, ordinary/detailed logging, quota, proxy, routing and cancellation regressions.

## Browser gate

A localhost-only fixture with dummy accounts and a local mock upstream was created under `/tmp/cps-affinity-browser`; one Claude-header Chat request produced a real cache-hit log row. Both local processes were stopped after the attempt.

Real-browser verification is blocked because `agent_browser` returned:

```text
failureCategory: missing-binary
agent-browser is required but was not found on PATH
```

Therefore no claim is made for pixel-level desktop/390px layout, focus containment, keyboard interaction or native visual readability of the new setup preview/log column. Static production-script and VM checks passed, but they are not browser automation. The temporary fixture files remain pending user-approved cleanup.
