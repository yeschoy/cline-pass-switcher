# Current Detailed Diagnostic Drop Contract (read-only, 2026-09-23)

## Observation (safe aggregate, no bodies read)

- On the newly deployed process, detailed `health.dropped` matched the count of full-detail roots marked `resource-limited` at two independent observations (208/208 and later 514/514). `health.failures=0`, `health.corrupt=0`; ordinary error rows were 0 during the corresponding window.
- A `resource-limited` root can still have an accessible metadata manifest and some sanitized body descriptors. Therefore `dropped` is an **event count for diagnostic omission/rejection**, not a count of failed model requests or necessarily missing detail roots.
- Ordinary request traffic remained successful in the observed window. This is a diagnostic quality/safety-budget question, not an upstream error classification.

## Exact increment owners to replace, without changing capture behavior

| Owner | Existing location / branch | Why it increments |
|---|---|---|
| `server.js` | `DetailRoot.active >= 128` before dispatch | concurrent capture activity fence |
| `server.js` | caught exception while starting `root.attempt()` after native `req.end()` | attempt capture setup failure; model request remains fail-open |
| `lib/detailed-log-capture.js` | `DetailRoot.attempts.length >= 256` | per-root attempt limit |
| `lib/detailed-log-capture.js` | `DetailRoot.finalize()` error/full profiles when any body is `resource-limited` | **one root-level increment**, even if several bodies were omitted |
| `lib/detailed-log-store.js` | `publish()` before admission, pending >=128 or store not accepting | queue/close admission |
| `lib/detailed-log-store.js` | `publish()` generation mismatch, expired timestamp, invalid ID (two gates) | stale/expired/invalid publication |
| `lib/detailed-log-store.js` | missing/invalid previously open root, missing root directory, requireOpen entry removed | open-root/association loss |
| `lib/detailed-log-store.js` | manifest >1 MiB or group >1 GiB | serialized publication size fence |
| `lib/detailed-log-store.js` | inventory/admit refuses space | storage budget/admission fence |

`failure()`/`health.failures` and `health.corrupt` are independent signals; do **not** relabel them as `dropped`. The store health object initializes process-local counters in the constructor (`lib/detailed-log-store.js`).

## Resource-limited subcauses already present in code

- `BodyCapture.add()` sets `limited` when the shared 64 MiB retained/encoded `CaptureBudget.reserve()` fails; its output-expansion reservation in `materialize()` can fail too. Ordinary 5 MiB-per-body truncation alone is **`truncated`**, not necessarily a `dropped` event.
- `DetailRedactor.add()` marks `limited` when it exceeds 256 distinct secrets or 64 KiB of secret bytes.
- `DetailRedactor.learn()` and `prefix()` mark `limited` on depth >64 or work >16,384 visited nodes.
- `DetailRedactor.text()`/`known()` mark `limited` on >16,384 matches/scan tokens or >5 MiB of input/projected output work; `body()` can also stop at a resource limit.
- `BodyCapture.materialize()` returns a `resource-limited` descriptor if its own budget or the group redactor is limited. `DetailRoot.finalize()` counts the group once. The current store has no per-cause counter, so the exact production subcause **cannot be proven** from existing metadata alone.

## API/UI owners

- `GET /api/logs/settings` and `GET /api/logs/details` currently serialize the store `health` projection; it has `{failures,dropped,corrupt,lastFailure}` and is authenticated, default-off capture settings.
- `public/index.html` uses `DETAIL_*` visit/selection generations and `api()` for authenticated detail settings and listing. `#detailsStatus` renders `存储失败 N · 诊断丢弃 N · 损坏记录 N`. The reason breakdown belongs to that owner as safe text-only projection; it must not enter ordinary request/error JSONL or metadata.
- Focused owners: `test/detailed-log-capture.test.js`, `test/detailed-log-store.test.js`, `test/detailed-log-ui.test.js`, `test/ui-contract.test.js`, `test/integration.test.js`.
