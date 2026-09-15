# Thinking Guides

> Project-specific review prompts for extending this native Node service without duplicating owners or breaking cross-layer contracts.

---

## Available Guides

| Guide | Purpose | Use it when |
|---|---|---|
| [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md) | Reuse existing normalization, transport, quota, logging, and browser-state owners | Adding a helper, queue, persisted field, route, or UI state owner |
| [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md) | Trace API, persistence, browser, diagnostics, and deployment data flows | A change crosses `server.js`, `lib/`, `public/index.html`, tests, or deployment state |

## Quick Triggers

Read the reuse guide before:

- adding a new `lib/` module or helper in `server.js`;
- adding another transport, queue, scheduler, cursor, generation, or store;
- normalizing a field already used by global and account configuration;
- adding diagnostic projection or redaction logic;
- changing the shared browser `api()` helper.

Read the cross-layer guide before:

- changing an API payload, persisted JSON field, or migration;
- changing account selection, provider attempts, streaming, or cancellation;
- changing statistics/quota unknown and coverage semantics;
- changing account drafts, navigation, or stale-response handling;
- changing ordinary/detailed logging or a production release procedure.

## Review Discipline

Every finding must point to the actual source owner and an executable test or observable contract. Do not turn a hypothetical concern into a rule without tracing the current code. Conversely, never omit trust-boundary validation, data-loss prevention, credential controls, accessibility, or relevant edge cases merely to keep a change small.

Before modifying a value or contract, search all occurrences:

```bash
grep -RIn "value-or-field" server.js lib public test .trellis/spec
```

After a shared change, run the narrowest focused test first, then the complete project verification required by the backend/frontend indexes.
