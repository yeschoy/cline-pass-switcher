# Cross-Layer Thinking Guide

> Trace data through the native HTTP server, JSON persistence, inline browser script, diagnostics, and deployment boundary before changing a shared contract.

---

## Map the Actual Flow

Use the flow that matches the change.

### Account configuration

```text
public/index.html draft
  -> collectAccounts()
  -> authenticated POST /api/accounts
  -> complete server validation
  -> normalizeAccount() / shared route normalizers
  -> saveConfig() + saveMeta()
  -> loadAll() reloads server snapshots
```

The browser owns drafts; the server owns validation and persistence. Because the API replaces the account list, hidden `id`, proxy/Header, note, scheduling, and `perModel` fields must survive every projection and round trip.

### Chat request

```text
HTTP body
  -> handleChat() validation
  -> extractSessionIdentity()
  -> acquireAccountLease()
  -> resolveModelAlias() / resolveModelConfig()
  -> runChatChain() through account-bound native transport
  -> client response + idempotent finalization
  -> statistics and bounded ordinary/detailed diagnostics
```

Account choice occurs before provider attempts. Stream completion, cancellation, lease release, statistics, and logs share one lifecycle and must be reviewed together.

### Detailed diagnostics

```text
included HTTP route
  -> DetailRoot / BodyCapture observation
  -> group-wide credential discovery and sanitization
  -> asynchronous DetailedLogStore publication
  -> authenticated metadata/detail/body APIs
  -> on-demand text rendering in public/index.html
```

This path observes traffic but must not change forwarded bytes, response timing semantics, lease completion, ordinary JSONL, or metadata exclusions.

### Production release

```text
committed HEAD
  -> allowlisted git archive + source hashes
  -> immutable versioned release directory
  -> two-field compose switch
  -> health/local/authenticated/internal/public checks
  -> config-hash verification or rollback
```

The SSH identity and production data stay outside the archive and must never be printed or committed.

## Boundary Ownership

| Boundary | Owner | Required check |
|---|---|---|
| Untrusted JSON/body/query input | route handler in `server.js` | strict endpoints validate the complete shape before mutation/network work; preserve documented legacy compatibility only where it already exists |
| Persisted configuration/runtime metadata | persistence helpers in `server.js` | distinguish missing files from malformed/unreadable files; preserve durable bytes on failed validation |
| Account-bound credentials and proxies | `responseHeadersFor()` / `clineRequest()` | downstream credentials never become upstream credentials; configured proxy failure never falls back direct |
| Account and model snapshots | `DATA` / `ACCS` / `ALIASES` | reload accepted server state after destructive writes |
| Stale asynchronous UI work | feature-specific generations/controllers | success, catch, and finally all verify current ownership |
| Ordinary diagnostics | request/error projections and directory-level `JsonlLogGroup` | strict allowlist; no bodies, Header values, sessions, notes, or credentials |
| Detailed diagnostics | capture/redactor/store boundary | sanitize before publication; failures remain fail-open for model traffic |
| Deployment switch | canonical production contract | preserve config, verify hashes/health, retain rollback artifacts |

## Change Procedure

1. Identify the source of truth and every consumer.
2. Write down the exact input/output fields, null/unknown semantics, and failure status.
3. Search `server.js`, `public/index.html`, `lib/`, and `test/` for each changed field or route.
4. Update the owning validator/normalizer once; do not reimplement it in each consumer.
5. Preserve compatibility fields intentionally, such as `upstream` beside `upstreams` and display-only handling for old log rows without `result`.
6. Test the round trip and at least one invalid/stale/cancellation case appropriate to the boundary.

## High-Risk Cross-Layer Checks

### Full account saves

A table row is only a projection. Verify that filtering, drawer edits, presets, bulk concurrency, and raw scheduling keep complete account objects and stable IDs before `POST /api/accounts` replaces the array.

### Unknown versus zero

Statistics and quota data distinguish missing/invalid values from a known numeric zero. Preserve `null` and coverage labels from normalization through JSON, browser state, and rendering.

### Request lifecycle

For chat changes, inspect request-body limits, abort propagation, first-SSE-event handling, account/provider failover, idempotent finalization, lease release, statistics, ordinary logs, and detailed capture together.

### Credential projection

Search every destination: response bodies/headers, `metadata.json`, ordinary JSONL, detailed manifests/bodies, console output, and browser HTML. Redaction is defense in depth; first build the smallest approved projection.

### Deployment state

Never validate a release by uploading the working tree. Confirm the archive comes from committed `HEAD`, the identity is resolved from the repository root, production `config.json` hashes match, and every rollback gate has retained evidence.

## Verification Checklist

- [ ] Complete data flow and source owner identified.
- [ ] New/strict trust-boundary validation happens before mutation/network work; any retained permissive behavior is an identified legacy contract.
- [ ] Persistence distinguishes `ENOENT` from corruption and uses atomic replacement.
- [ ] Hidden account fields and stable IDs survive browser/API/persistence round trips.
- [ ] Unknown/zero and stale/current semantics survive API and rendering.
- [ ] Cancellation and stale async work cannot publish into a newer owner.
- [ ] Ordinary and detailed diagnostic boundaries remain separate.
- [ ] Focused production-code tests plus `npm test` cover the affected path.
- [ ] Deployment changes preserve the canonical target, key path, config hash, and rollback gates.
