# Code Reuse Thinking Guide

> Search the native Node service and its production inline browser script before adding another owner for existing behavior.

---

## Search Before Writing

Use repository search to find the current owner and every caller:

```bash
grep -RIn "functionName\|route-name\|payloadField" server.js lib public test
grep -RIn "requestQuota\|quotaJobs" server.js test
```

Read the implementation and its focused tests before deciding whether to extend it. This repository favors a direct change to an existing owner over a new abstraction.

## Existing Owners to Reuse

| Boundary | Existing owner | Evidence |
|---|---|---|
| JSON configuration and metadata | `loadJson()`, `atomicWriteJson()`, `normalizeConfigAndMeta()` in `server.js` | startup and migration cases in `test/integration.test.js` |
| Global and account model routes | `normalizeRouteConfig()`, `normalizePerModelMap()`, `resolveModelConfig()` | route inheritance/override integration cases |
| Account selection and capacity | `acquireAccountLease()`, `tryLease()`, account-mode helpers | routing, overflow, and lease-release integration cases |
| Account-bound HTTP transport | `clineRequest()`, `proxyAgentFor()`, `responseHeadersFor()` | HTTP/HTTPS/SOCKS proxy integration cases |
| Quota admission | `requestQuota()` and the shared `quotaJobs`/global-slot pump | quota concurrency, cancellation, and generation tests |
| Ordinary diagnostic storage | `JsonlLogStore` and `enforceCombinedLimit()` | `test/jsonl-log-store.test.js` |
| Detailed capture/storage | `DetailRoot`, `BodyCapture`, `DetailRedactor`, `DetailedLogStore` | detailed capture/store/integration suites |
| Browser API access | `api()` in `public/index.html` | production-script VM tests |
| Browser state ownership | `DATA`, `ACCS`, `ALIASES`, and feature-specific generation/controller state | account-draft and detailed-log UI tests |

## Project-Specific Duplication Traps

### Route normalization

Do not normalize global and account `perModel` entries independently. Both persisted scopes use the same route schema and must pass through `normalizeRouteConfig()` / `normalizePerModelMap()`.

```js
// Wrong: an account-only shape can drift from the global route shape.
account.perModel[model] = { upstreams: input.upstreams };

// Correct: reuse the shared complete-entry normalizer.
account.perModel[model] = normalizeRouteConfig(input);
```

### Account-bound transport

Do not add a second direct `fetch()` path for chat, quota, probe, or account-test work that must honor an account proxy. Reuse the existing native transport boundary so credentials, proxy failure, timeout, and detailed-call capture stay consistent.

### Quota scheduling

Page refresh, routing refresh, scheduler ticks, and account-save triggers must join `requestQuota()`. A second queue or local `Promise.all(...slice(0, 2))` can violate the one-job-per-account and two-live-transport contracts.

### Browser state

Do not create a second generic store or cursor. Extend the snapshot/generation/controller that owns the feature, and preserve the shared `api()` behavior for authentication, 401 handling, response parsing, and abort signals.

### Diagnostic data

Do not copy request projection, redaction, or retention logic into route handlers. Build the approved bounded projection and pass it to the existing ordinary or detailed owner. Detailed bodies never belong in `JsonlLogStore` or `metadata.json`.

## When Extraction Is Appropriate

Extract code to `lib/` only when it owns a cohesive boundary with independent focused tests, as the three existing modules do. Keep a one-use helper in `server.js` or beside its inline-script feature when extraction would add another layer without another owner or test boundary.

## Review Checklist

- [ ] Searched the implementation and tests for the behavior, field, route, and constants being changed.
- [ ] Traced every caller of a shared helper.
- [ ] Reused the existing normalization, transport, quota, logging, or browser-state owner.
- [ ] Avoided a second queue, cursor, account store, route schema, or redaction path.
- [ ] Kept new modules cohesive and independently testable.
- [ ] Added focused coverage when shared non-trivial behavior changed.
