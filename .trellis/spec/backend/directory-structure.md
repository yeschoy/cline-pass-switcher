# Backend Directory Structure

> The project is a small native-Node service, not a framework application.

---

## Runtime Layout

```text
server.js                         HTTP server, configuration, routing, statistics, quota jobs
lib/jsonl-log-store.js            ordinary request/error JSONL storage
lib/detailed-log-capture.js       bounded detailed HTTP capture and sanitization
lib/detailed-log-store.js         detailed-log persistence, retention, query, and clear
test/*.test.js                    node:test unit, VM/UI-contract, and integration suites
public/index.html                 static administration console served by server.js
Dockerfile                        production image
docker-compose.yml                loopback-bound application deployment
deploy/                           optional Caddy all-in-one deployment
data/                             gitignored runtime configuration, metadata, and logs
```

There is no `src/`, router framework, service container, ORM, build output, or generated backend code. `package.json` sets ESM with `"type": "module"` and supports Node 18+, while the production image currently uses Node 22 Alpine.

## Ownership Boundaries

### `server.js`

Keep behavior in `server.js` when it coordinates several runtime owners: HTTP authentication and routes, account selection/leases, upstream transport, JSON configuration, statistics, quota scheduling, and static-file serving. Examples include `handleChat()`, `dispatch()`, `requestQuota()`, and `normalizeConfigAndMeta()`.

Before changing a shared helper, inspect every route and background caller. Request transport, leases, stream finalization, logging, statistics, and quota jobs deliberately share lifecycle state.

### `lib/`

Extract a module only when it owns a cohesive, independently testable boundary:

- `JsonlLogGroup` owns both ordinary segmented JSONL streams, their combined retention budget and pagination.
- `DetailRedactor`, `BodyCapture`, and `DetailRoot` own bounded capture/sanitization.
- `DetailedLogStore` owns the separate detailed-log filesystem and serialization queue.

Do not create one-use service classes, controller wrappers, repositories, factories, or interfaces around code that still has one implementation. Keep modules dependent on Node standard APIs unless the existing proxy agents are required.

### Runtime data

All mutable runtime files belong under `DATA_DIR`; defaulting to the repository directory is a compatibility behavior, not a reason to add runtime files to source control. `config.json`, `metadata.json`, `data/`, the production SSH identity, `node_modules/`, and build output are gitignored.

Static source must never read or write operator data during tests. Integration fixtures use temporary `DATA_DIR` directories and local upstream/proxy servers.

## Naming and File Placement

- Runtime modules and tests use lowercase kebab-case: `detailed-log-store.js`, `detailed-log-store.test.js`.
- Test files mirror the behavior boundary rather than the implementation function count.
- Public browser assets stay under `public/`; currently the entire console is `public/index.html`.
- Production deployment assets stay at the repository root or under `deploy/`; host-specific deployment rules belong in `.trellis/spec/backend/deployment-guidelines.md`.
- New persisted files require an explicit owner, retention/security contract, and temporary-directory tests before being added.

## Examples and Anti-Patterns

**Good:** add a retention invariant to `DetailedLogStore` and its focused test, then cover the HTTP projection in `test/integration.test.js`.

**Good:** keep an account-routing fix in the shared `requestQuota()`/admission path so routing, page refresh, and account-save callers inherit it.

**Bad:** create separate quota schedulers for the statistics page and routing pipeline; they would bypass the global admission owner.

**Bad:** place request bodies in the ordinary JSONL store or add UI source files that require an unconfigured bundler.

## Verification

Use the narrowest focused `node --test` command while iterating, then run:

```bash
node --check server.js
for file in lib/*.js; do node --check "$file"; done
npm test
git diff --check
```
