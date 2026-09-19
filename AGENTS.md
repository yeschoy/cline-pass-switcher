<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

# Project-Specific Instructions

## Start With the Actual Contract

1. Before editing, read the relevant entry point and the scenario guide it links:
   - Backend: `.trellis/spec/backend/index.md`
   - Frontend: `.trellis/spec/frontend/index.md`
   - Cross-layer behavior: `.trellis/spec/guides/index.md`
2. Search `server.js`, `lib/`, `public/`, `test/`, and the specs for every affected route, field, helper, and caller. Do not infer a shared contract from one call site.
3. Treat the specs as intended behavior and the implementation/tests as executable evidence. If they disagree, identify the mismatch instead of silently following whichever is more convenient.
4. Preserve unrelated working-tree changes. Never clean, overwrite, stage, or reformat paths outside the requested scope.
5. `README.md` and `config.example.json` are operator-facing documentation, not substitutes for tracing the implementation and tests.

## Repository Shape and Owners

- This is a native Node.js ESM service (`node >= 18`) with no application framework, build step, TypeScript layer, ORM, router, or service container.
- `server.js` owns startup, HTTP/authentication, configuration and metadata, account selection/leases, upstream transport, routing, statistics, quota work, management APIs, and static-file serving.
- `lib/jsonl-log-store.js` owns bounded ordinary request/error JSONL storage.
- `lib/detailed-log-capture.js` and `lib/detailed-log-store.js` own opt-in capture, sanitization, retention, and detail retrieval.
- `public/index.html` is the complete browser console: one HTML document with CSS and inline JavaScript, served directly by `server.js`.
- `test/*.test.js` uses `node:test`: focused storage/capture tests, production-script VM/static UI tests, and black-box integration tests.
- `Dockerfile`, `docker-compose.yml`, and `deploy/` own deployment packaging. Mutable operator state belongs under `DATA_DIR`, even though the repository root remains a legacy default.
- Runtime dependencies are intentionally limited to the existing HTTP/SOCKS proxy agents. Prefer Node platform APIs and existing owners.

## Change Rules

- Make the smallest coherent change in the current owner. Do not add a second queue, scheduler, store, cursor, normalization path, transport, or state owner.
- Extract into `lib/` only for a cohesive boundary with focused independent tests. Avoid one-use classes, factories, repositories, and interfaces.
- Do not add a framework, frontend toolchain, dependency, or broad refactor unless the task explicitly requires an architecture change.
- Preserve documented compatibility behavior unless the requested change explicitly replaces it. Existing management endpoints are not uniformly strict; do not accidentally redesign their response shapes while fixing another concern.
- Validate complete untrusted input before mutation, persistence, account leasing, or network work. Server validation remains authoritative even when the browser also validates for feedback.
- Reuse the existing same-directory atomic JSON write path. Missing files may use defaults; malformed or unreadable operator JSON must fail without overwriting the original bytes.
- A persisted or API schema change is cross-layer work: update normalization/strict validation, migration and round-trip behavior, browser snapshots/drafts, tests, operator docs/examples when relevant, and the reusable spec contract.
- Preserve missing/unknown versus known numeric zero for usage, health, quota, statistics, and coverage values.

## High-Risk Flows

### Accounts and routing

- `POST /api/accounts` replaces the account list. Every full save must retain stable `id`, `note`, `proxyUrl`, `headers`, `perModel`, `maxConcurrent`, `weight`, `priority`, enablement, active selection, error rules, and pipeline state.
- Account `perModel[model]` is a complete override, not a field merge with the global route. Reuse the shared route normalizers for both scopes.
- Account selection happens before provider attempts. Provider retries stay on that account; only the documented pre-stream cooldown/ban path may replace it.
- Downstream authorization must never become upstream authorization. Account proxy failure must never retry directly.

### Chat lifecycle

- Review body limits and validation, alias/route resolution, account leasing, provider attempts, proxy use, SSE first-event behavior, cancellation, idempotent finalization, lease release, statistics, ordinary logs, and detailed capture as one lifecycle.
- Preserve upstream statuses and error meaning. Do not replay after client-visible stream output, turn cancellation into a health failure, or infer missing usage values.
- Diagnostic persistence/capture failures are fail-open for model traffic unless a management endpoint is explicitly changing persisted diagnostic configuration.

### Browser console

- Reuse `api()` and the feature's existing snapshot/generation/controller owner. Do not introduce a generic client store or rebuild complete objects from visible table cells.
- Destructive writes reload accepted server state. Search/filter/redraw/navigation must preserve unsaved drafts and invalidate stale async responses only within the owning feature.
- Escape every server-controlled value before `innerHTML`; use `textContent` or textarea values for arbitrary diagnostics. Use `jsArg()` for generated JavaScript arguments.
- Keep native semantic controls and accessibility behavior. Interactive changes must consider keyboard operation, focus entry/return, `aria-live`, dialogs, clipboard fallback, and narrow-width scrolling.

## Security and Runtime Data

- Never print, expose, commit, copy into fixtures, or casually inspect `config.json`, `metadata.json`, `data/`, account keys, proxy credentials, custom Header values, admin keys, or the repository-local SSH identity.
- Tests must use temporary `DATA_DIR` directories and local mock upstream/proxy servers. Never use production data, credentials, or paid/live upstreams.
- Ordinary logs are strict bounded projections: no bodies, Header values, raw sessions, messages, notes, proxy URLs, or credentials.
- Detailed logging is separate, authenticated, default-off, bounded, sanitized, and retrieved on demand. It does not relax ordinary-log or metadata exclusions.
- Do not deploy or operate on production unless explicitly asked. Before any deployment work, read `.trellis/spec/backend/deployment-guidelines.md`; deploy committed `HEAD`, preserve operator data, avoid exposing credentials, and retain a tested rollback path.

## Verification

Run the narrowest test that can fail for the changed behavior first:

```bash
# Browser console contracts and production inline-script behavior
node --test test/ui-contract.test.js test/account-draft.test.js test/detailed-log-ui.test.js

# Ordinary or detailed diagnostics
node --test test/jsonl-log-store.test.js
node --test test/detailed-log-capture.test.js test/detailed-log-store.test.js

# HTTP, persistence, routing, quota, proxy, streaming, and cross-layer behavior
node --test test/integration.test.js
```

Before reporting a completed code change, run all checks relevant to the touched scope and then the full project gate:

```bash
node --check server.js
for file in lib/*.js; do node --check "$file"; done
node --input-type=module -e 'import fs from "node:fs"; import vm from "node:vm"; const html=fs.readFileSync("public/index.html","utf8"); new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);'
env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT npm test
git diff --check
```

- VM/static frontend tests are not browser automation. Use real-browser evidence when acceptance depends on layout, focus, keyboard behavior, native dialogs, clipboard behavior, or responsive scrolling.
- If a required check cannot run, report the exact command or behavior not verified and why. Distinguish verified facts from assumptions.

## Documentation

- Keep reusable project specifications under `.trellis/spec/` in English, matching the existing spec language.
- Update a spec only when the executable contract or a reusable convention changes; keep task-specific investigation notes out of permanent guidance.
- Keep operator-facing examples synchronized when configuration fields, environment variables, routes, or deployment behavior change.
