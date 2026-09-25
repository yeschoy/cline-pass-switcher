# Backend Development Guidelines

> Entry point for the native-Node proxy, persistence, diagnostics, testing, and production deployment contracts.

---

## Architecture

The backend is an ESM Node service centered on `server.js`, with cohesive storage/capture modules under `lib/`, native `node:test` coverage, JSON state under `DATA_DIR`, and Docker-based production deployment. Read the scenario-specific guide before changing a shared boundary.

## Guidelines Index

| Guide | Use it when changing |
|-------|----------------------|
| [Directory Structure](./directory-structure.md) | File placement, module ownership, runtime/test/deploy layout |
| [Persistence Guidelines](./database-guidelines.md) | JSON configuration, metadata, migration, identity, atomic writes |
| [Error Handling](./error-handling.md) | API errors, upstream classification, cancellation, fail-open diagnostics |
| [Administrator Authentication](./admin-auth-guidelines.md) | Independent console login, bootstrap, sessions, CSRF, route/transport gates and rollback |
| [Client-Key Account Pools](./client-key-guidelines.md) | Private key inventory, owner migration, exclusive chat/catalog routing, management API and old-image rollback gate |
| [Quality Guidelines](./quality-guidelines.md) | Account routing, transport, statistics, quota jobs, security, integration tests |
| [Logging Guidelines](./logging-guidelines.md) | Ordinary JSONL logs and opt-in detailed capture/storage/APIs |
| [Deployment Guidelines](./deployment-guidelines.md) | Canonical production host, key-path safety, versioned releases, verification, rollback |

## Pre-Development Checklist

- Identify every caller of a shared `server.js` helper before changing it.
- Read the exact persistence/logging/routing/deployment contract for the affected boundary.
- Preserve operator `DATA_DIR` files and use temporary data/local upstreams in tests.
- Validate trust-boundary input completely before mutation or network work.
- Keep credentials, message bodies, raw sessions, proxy details, and internal owner state out of ordinary projections.
- Prefer Node/platform APIs and existing modules over new dependencies or abstraction layers.

## Quality Check

- Run focused `node --test` coverage that can fail for the changed behavior.
- Run `node --check` for touched runtime modules.
- Run `npm test` with real credential/base environment overrides unset for integration work.
- Run `git diff --check` and inspect the complete affected flow.
- Use temporary/local fixtures; never validate against production data or credentials.
- For deployment, archive committed `HEAD`, verify hashes, preserve `config.json`, and require rollback-ready health/API checks.

**Documentation language:** English.
