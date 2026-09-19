# Verification evidence

## Automated checks

Focused checks:

```text
node --test test/ui-contract.test.js test/account-draft.test.js test/detailed-log-ui.test.js test/integration.test.js
```

Covered behavior:

- strict persisted/API `accountContentErrorRules` normalization and old-client omission preservation;
- rule count, UTF-8 byte, keyword, exact-field, status-range and cooldown bounds;
- first matching content rule, range filtering, `ignore` terminal behavior and exact-status fallback;
- nested HTTP-200 error envelope, non-stream, pre-stream SSE, post-start SSE without replay, and provider retry on the same account;
- current message, custom Header and account Key absence from metadata and ordinary error logs;
- one `ERROR_RULE_DRAFT` shared by visual rows, presets, raw scheduling and explicit save;
- visual add/edit/delete/reorder, escaped keywords, invalid no-op, advanced invalid/stale rejection and atomic apply;
- account/bulk/raw/statistics/detail navigation draft preservation.

Full project gate:

- server and all `lib/*.js` syntax checks passed;
- production inline script compiled with `vm.Script`;
- `npm test`: 161 passed, 0 failed;
- `git diff --check` passed.

## Real-browser gate

Not verified because the browser infrastructure remains unavailable in this session:

- `agent_browser`: `missing-binary` (`agent-browser` is not on PATH);
- approved Computer Use fallback: Chrome AX access returned `permission_denied` and requires macOS Accessibility re-authorization.

No keyboard/focus/narrow-width browser success is claimed. Native controls, focus calls, stale generations and responsive wrappers are covered statically/through the production VM only.
