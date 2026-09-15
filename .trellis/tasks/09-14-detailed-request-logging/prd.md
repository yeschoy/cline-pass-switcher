# Detailed Request Logging Mode

## Goal

Implement parent requirement **R1** in `../09-14-diagnostics-routing-config/prd.md`: make model-request troubleshooting possible by inspecting credential-redacted request headers, request bodies, final responses, and actual upstream attempts.

## Background and Evidence

- Ordinary request/error logs are deliberately restricted projections (`server.js:1041-1073`, `.trellis/spec/backend/logging-guidelines.md`). Existing exclusions of bodies/header values remain mandatory outside the new opt-in detailed store/view.
- Three chat aliases are defined at `server.js:1351`; request reading caps actual ingress at 50 MiB (`server.js:1353-1405`). `handleChat()` validates, rewrites aliases, selects accounts, retries, and returns JSON/SSE (`server.js:1706-1850`). Early validation returns before ordinary `record()`; that function alone cannot capture the approved request scope.
- SSE head buffering and terminal observation have separate paths (`server.js:1766-1819`); capture cannot wait for the full response or change normal streaming/final-result semantics.
- Management authentication and current log routes are at `server.js:1882-1884`, `server.js:1948-1969`. Configuration/log responses must not be captured indiscriminately because they can contain credentials or diagnostics themselves.
- The common native upstream transport is `server.js:1207-1235`; account tests/probes include ephemeral credentials. Full source maps and validation anchors are in `research/capture-boundaries.md` (research run `9d0112a1-9038-4113-8f53-daf27a11fd56`, workflow `e87a4f40-95d9-4fde-9db4-2d7d27138de2`).
- Existing `JsonlLogStore` scans/parses and rewrites all stored bodies and deduplicates non-error prefixes by request ID (`lib/jsonl-log-store.js:12-37,115-136`). It cannot be reused unchanged for 1 GiB of detailed request/attempt bodies.

## Confirmed Requirements

- **D1 — Switch:** Default off. A successful toggle affects new requests immediately, persists across service restarts, and is independent of account/scheduling draft save. The user accepted that enabling continues body capture until manually disabled. Failed saves must not falsely report a successful toggle.
- **D2 — Coverage/correlation:** Capture client-facing model requests and final responses, plus every locally observable upstream model call, including failures, retries, streaming, and console tests/probes. Correlate each real call with its initiating request; distinguish original client content from rewritten upstream content and the final client response.
- **D3 — Exclusions:** Configuration management, log queries, and static-resource traffic are excluded. Ordinary request/error-log behavior, statistics, and metadata exclusions remain unchanged. This is not a new protocol or packet-capture feature.
- **D4 — Sensitive values:** Retain ordinary headers and request/response content, but redact Authorization, Cookie, API keys, proxy passwords, and other recognized credentials before persistence or API exposure. This includes ephemeral test credentials and known credentials echoed in bodies. Original credential values are intentionally unavailable in logs. Arbitrary captured text must be displayed safely.
- **D5 — Body limit:** Each individual request body and response body has a capture limit of 5 MiB (5 × 1024 × 1024 bytes), including each upstream attempt and streaming response. Exceeding the limit must be explicitly marked; actual request/response forwarding must not be truncated by logging.
- **D6 — Retention:** Detailed logs use independent storage, at most 7 days and 1 GiB total (1024 × 1024 × 1024 bytes), cleaning oldest detailed records when either limit is reached. The user accepted that high volume may shorten retention below 7 days. Ordinary logs are unaffected.
- **D7 — Browsing:** An independent “详细日志” entry groups each request with request headers/body, final response, and upstream attempts. Support copying captured content and independently clearing detailed logs; do not insert detailed bodies into ordinary log views.
- **D8 — Failure/resource safety:** Diagnostic failures, interrupted/unread/truncated/unsafe-to-render content, or resource-limited capture must be reported as incomplete, never silently presented as complete. Logging cannot alter traffic outcomes, delay completion for diagnostic disk writes, break backpressure, cause duplicate finalization, or leak bodies through service errors. New APIs follow the existing management authentication boundary.

## Acceptance Criteria

- **DC1 / D1:** Missing configuration defaults off; toggle applies only after successful persistence, affects new requests without restart, and round-trips across restart. It neither submits nor discards account/scheduling drafts.
- **DC2 / D2, D3:** Route-matrix fixtures prove correlation for JSON/SSE, success/failure, retry/replacement, validation/cancellation, and console tests/probes; excluded operations create no detail records. Each actual local call is represented once rather than inferred from trace length.
- **DC3 / D4:** Ordinary headers/content are inspectable while recognized/known credentials are absent from detailed APIs, files, temporary files, and service errors. The ordinary log/metadata sensitive-data tests still pass with detailed mode enabled.
- **DC4 / D5, D8:** 5 MiB−1/exact/+1 byte cases, fragmented UTF-8/SSE/credentials, and partial bodies obey the capture limit and report completeness honestly. Client/upstream forwarding remains equivalent regardless of logging mode.
- **DC5 / D6:** Age, total-byte, restart, and oldest-first cleanup tests use small injectable limits; detailed cleanup never deletes ordinary logs. Browsing does not load the 1 GiB body corpus into memory.
- **DC6 / D7:** Operators can navigate the independent detail entry, inspect an entire request/attempt group on demand, copy sanitized content, and clear only detailed logs. Expired or cleared records produce a safe missing-state response.
- **DC7 / D7, D8:** Clear during an active request or queued write does not resurrect pre-clear captures. Stale list/detail responses cannot overwrite a newer selection or navigation state.
- **DC8 / D8:** Disk/rename/read errors, capture-budget pressure, aborts, malformed input, and redaction failures do not change proxy status/body, leak sensitive values, or leave leases/finalizers stuck. Safe store health exposes failures that cannot themselves be persisted.

## Dependencies and Scope

Implement after the bulk-concurrency and raw-editor children pass their gates to avoid concurrent console/test writers. There is no functional dependency of request capture on those features, but the logging toggle/navigation must preserve their shared draft owner.

No new routing strategy, provider retry, protocol support, quota logging, external telemetry/export service, or general database dependency. Existing public discovery/background quota traffic is not model inference; the design route matrix makes this distinction explicit. Only model HTTP calls observable by this proxy are captured, not hidden provider-gateway internals or TLS/proxy wire frames.

The user approved this plan, including its route/completeness matrix, for implementation with “开始”. This child remains planning until preceding gates pass and the parent activates it. Approval is not a claim of implementation or universal secret detection.
