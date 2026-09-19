# Code and performance findings

## Scope inspected

- `server.js`, `lib/jsonl-log-store.js`, `public/index.html`
- statistics, account routing, model probing, error-rule validation and ordinary-log tests/specs
- screenshots supplied for the model table and quota column
- archived task `09-18-optimize-detailed-log-scan` and prior local session evidence

## Confirmed findings

### Per-model cache statistics do not exist yet

- `GET /api/statistics` projects global and per-account aggregates only (`server.js:2333-2337`).
- Persisted `META.statistics` has `lifetime.global`, `lifetime.accounts`, and minute buckets with `global`, `accounts`, and `health`; there is no model aggregate (`server.js:256-347`, `server.js:1148-1166`).
- Cache request hit rate is already defined consistently as `cacheHitRequests / cacheKnownRequests`, while cache Token ratio is `cacheInputCachedTokens / cacheInputTokens` (`server.js:1100-1124`, `server.js:1176-1178`). Missing explicit upstream usage remains unknown; numeric zero remains known.
- The model table is rendered from `/api/models` and currently has no statistics snapshot (`public/index.html:294-299`, `public/index.html:450-491`, `server.js:2184-2194`).

### Why the screenshot can show upstream count 0

- The column is the literal length of `meta.upstreams` (`public/index.html:450-465`). It is not the number of successful requests and not proof that the model has no usable upstream.
- A successful probe independently records `pipeline`, `canonicalSlug`, and `lastProvider`, which explains why the screenshot can show “Vercel”, a canonical model and `openai-compatible-private` while the count is zero (`server.js:928-972`).
- For planner/Vercel models, the persisted upstream list is currently built only from the deliberate harvest result and `fallbacksAvailable`; it omits the already observed `finalProvider` (`server.js:952-967`).
- The harvest parser accepts only a string-valued `json.error`; an object envelope such as `{ error: { message: ... } }` produces no list (`server.js:890-925`).
- Therefore the screenshot’s 0 means “the discovery list was empty”, not “there is no actual upstream”. The UI should distinguish unknown/not-discovered from a true count and the backend should retain a safely observed final provider.

### Ordinary JSONL logging is the remaining hot-path problem

- The detailed-log store was already optimized in commit `d6c0087` with a bounded in-memory inventory. Its archived task explicitly excluded ordinary JSONL logs.
- `JsonlLogStore` still performs synchronous filesystem work:
  - constructor calls full `compact()` before `server.listen()`;
  - each append calls `files()` and `statSync()` to find the active segment;
  - every 100 appends reads, parses, deduplicates and rewrites the complete stream;
  - every finalized request runs `enforceCombinedLimit()`, which enumerates and stats both streams;
  - each query synchronously reads, parses, filters and sorts the complete corpus.
- Prior production evidence showed about 10.7 MiB of ordinary JSONL being synchronously parsed/rewritten before listening, causing health checks to receive connection failures during cold start. The detailed store’s asynchronous recovery was not that blocking cause.
- A local temporary-directory baseline on the current code appended 5,000 representative records in 3,607.9 ms (721.6 microseconds/record) and queried 50 matching rows in 8.3 ms. The command removed its temporary directory immediately.
- The performance work should target ordinary request/error JSONL only, preserve fail-open traffic semantics and retain the existing projection/security/cursor/retention contracts.

### Error-rule editor and schema

- The current UI exposes presets plus one three-row “advanced JSON” textarea (`public/index.html:237-240`). Saving parses that textarea and posts the complete account snapshot (`public/index.html:1005`).
- The server currently accepts only exact numeric HTTP status keys 100-599 and actions `ignore`, `cooldown`, or `ban`; unknown fields are rejected (`server.js:157-174`, `server.js:252-263`).
- Runtime lookup uses only normalized status (`server.js:1846-1850`). Response-content matching from the earlier planning scope is not implemented.
- A visual row editor can reuse one rule-draft owner and keep advanced JSON as an explicit expert view; it must not create a second independently mutable account store.

### Quota column duplication

- `quotaLimit()` renders both `已用 X%` and `剩余 (100-X)%`, plus reset time (`public/index.html:1030`).
- The supplied screenshot confirms this is visually redundant. Rendering only remaining percentage can be done without changing the quota API or persistence semantics.

## Relevant tests and specs

- Ordinary store: `test/jsonl-log-store.test.js`, `.trellis/spec/backend/logging-guidelines.md`
- Statistics/routing: `test/integration.test.js`, `.trellis/spec/backend/quality-guidelines.md`
- Production inline UI: `test/ui-contract.test.js`, `test/account-draft.test.js`, `.trellis/spec/frontend/state-management.md`, `.trellis/spec/frontend/quality-guidelines.md`
- Cross-layer rules: `.trellis/spec/guides/cross-layer-thinking-guide.md`
