# Drop-Reason Counters — Final Local Check

**Accepted locally, not deployed/pushed.** The feature leaves capture limits, redaction, data-plane traffic and existing `health.dropped` semantics unchanged; every former detailed-diagnostics increment is now routed through `DetailedLogStore.recordDrop()` and assigned exactly one of 14 fixed counters. Counts are aggregate, process-local and not backfilled from old manifests. `health.failures/corrupt` remain independent.

## AC mapping

1. Initial zero, fixed keys, sum invariant, admission fences and full/error multi-body one-root counting: `test/detailed-log-store.test.js` and `test/detailed-log-capture.test.js`. The only remaining direct detailed `health.dropped++` is inside `recordDrop()`; ordinary `JsonlLogGroup` has an unrelated owner.
2. Small injected capture budgets and bounded fixture input exercise capture-budget, secret, work/output and store queue/stale/open-root/size/capacity reasons. Root priority `captureBudget > redactionSecretLimit > redactionWorkLimit > redactionOutputLimit > redactionOther > other` has a focused multi-limit fixture. Plain per-body truncation and safety-only omission do not increment dropped.
3. `failure()` and `corrupt` stay independent; `MAX_SAFE_INTEGER` saturation freezes both total and distribution. Existing fail-open response, byte/stream lifecycle and reservation release tests remain green.
4. Two authenticated API health projections share fixed safe numerics; no per-request identity/body/header/secret in ordinary JSONL, metadata, detailed manifest/descriptors or service messages. Restart initializes the counters to zero.
5. Production inline JS VM/UI tests cover fixed labels, `textContent`, stale views/old API payloads, extra-key safety and account-draft isolation. Real Chrome 375px smoke **7/7**, see `research/browser-verification.md`.
6. Node 26 gate: server/lib syntax, production inline-script `vm.Script`, focused detailed capture/store/UI and integration suites, `git diff --check` and full `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test` **248/248** (baseline 242; no deleted/skipped cases). Node 18 was not re-run for this new feature.

## Independent mutation discrimination

- Deliberately classifying the store queue refusal as `other` caused the focused store test to fail: expected `storeQueue=1`, actual 0.
- Deliberately putting redaction-secret priority before capture-budget caused the focused multi-body root test to fail: expected `captureBudget=1`, actual 0.
- Source files were restored byte-for-byte from temporary backups after each experiment. No product defect was found during independent check; no production data was inspected for this implementation.

## Residual

The historical production `dropped` count cannot be retroactively classified. Future per-reason counters begin only after a process running this code starts. The feature is not deployed; no claim about the specific limit hit by historical traffic is made. Retained temporary mutation backups and Chrome artifacts require operator consent before cleanup; Trellis task evidence stays in the repository.
