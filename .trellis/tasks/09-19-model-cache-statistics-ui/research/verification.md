# Verification evidence

## Automated checks

Focused backend/frontend run after implementation:

```text
node --test test/ui-contract.test.js test/account-draft.test.js test/integration.test.js
88 tests passed, 0 failed
```

The full project gate also passed with 158 tests, 0 failures, plus server/lib syntax checks, embedded-script compilation and `git diff --check`.

Coverage includes:

- statistics v1→v2 migration and restart persistence;
- per-resolved-model non-stream/stream/provider-retry/account-replacement exactly-once aggregation;
- known zero, zero denominator, missing usage and rolling coverage labels;
- independent bounded model-minute eviction;
- structured provider harvest plus observed final provider;
- stable-ID account summary and exclusion from account save payloads;
- remaining-only quota text and unchanged quota forecast.

## Real-browser gate

Not verified because both available browser paths were blocked by local infrastructure:

1. `agent_browser` failed with `missing-binary`: `agent-browser is required but was not found on PATH`.
2. The approved Computer Use fallback found Google Chrome, but `orca computer get-app-state --app com.google.Chrome --restore-window --json` failed with `permission_denied`: visible Chrome windows had no accessible AX window and macOS Accessibility needs to be re-enabled.

No browser success is claimed. Desktop width, 390px horizontal scrolling, and pixel-level readability remain residual verification items.

A local fake-data server was started only for this attempted check and then stopped. Its temporary directory `/tmp/cps-ui-stats-8ELcwc` contains no production credentials/data and remains pending user-approved cleanup at the end of the overall task.
