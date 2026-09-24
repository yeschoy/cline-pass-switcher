# Local acceptance report — raw detailed bodies (2026-09-24)

## Scope and evidence

- Default-off `rawBodyLogging` is a persist-first independent switch. Only initialized administrator sessions can read settings, metadata and body content; existing full/error sanitized records stay 5 MiB / seven days. Raw full/error captures use 35 MiB per UTF-8 body, 512 MiB shared retained reservation, distinct raw profiles, no free-form Header/list metadata, and on-demand body text with explicit warning.
- A single `DetailedLogStore` manages a private raw child and the legacy root with one 1 GiB budget and one queue. Strict timestamp+UUID and regular-file ownership permits deletion of expired raw groups after 48h even when manifest is corrupt; reads reject expired groups immediately, and on-disk deletion runs at startup/minute maintenance (or the next successful retry if storage fails), not with an exact wall-clock deletion guarantee. Suspicious entries cannot be served or removed automatically and appear in safe `rawWarnings` health. External backups/copies have no service TTL.
- Independent check found a byte-fidelity bug: default `TextDecoder` stripped a leading UTF-8 BOM. Capture and authenticated retrieval now preserve it with `ignoreBOM:true`, including restart coverage. Raw error-only tests assert failed request/response retention and exact triggering SSE event; successful attempts do not publish bodies.

## Executed verification

- `node --test test/raw-detail.test.js test/detailed-log-capture.test.js test/detailed-log-store.test.js test/detailed-log-ui.test.js` — **87/87 passed** (run after the independent check).
- `node --check server.js`; all `lib/*.js` checked; embedded production script compiled via `vm.Script` — passed.
- `env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test` — **290/290 passed** (run after the independent check).
- `git diff --check` — passed after code changes. User-facing wording/spec-only follow-up edits require a final diff check before commit.
- Synthetic local Node resource observation: six simultaneous 35 MiB bodies retained a 420 MiB reservation and reached **564 MiB RSS** (from 37 MiB baseline). This is **not** an RSS bound, target-container workload test or proof of fail-open behavior under OOM; see `research/raw-local-validation.md`.

## Not verified / release gate

- `agent_browser open file:///.../public/index.html` failed with `missing-binary`: `agent-browser` was not found on PATH. VM/static UI tests are not actual browser keyboard/focus/390px/screen-reader evidence.
- No target-container concurrent 35 MiB request/SSE and slow authenticated body download benchmark, no private production-data backup exclusion/48h expiry, no old-image rollback ingress/read-denial rehearsal. These are **required before enabling raw mode in production**; this task made no production change and needs separate deployment authorization.
- Cannot diagnose the historical screenshot rows' exact missing-content cause from list state alone. Tests distinguish ordinary truncation, sanitizer resource limits and unsafe-credential omission with synthetic fixtures, not live records.
