# Frontend Development Guidelines

> Entry point for the static administration console in `public/index.html`.

---

## Architecture

The frontend is plain HTML, CSS, and JavaScript served directly by `server.js`. It has no framework, component module tree, hooks, TypeScript, bundler, or frontend dependency. Browser state is owned by explicit snapshots, generation counters, controllers, and native DOM elements inside the one production document.

The unused framework-oriented component, hook, and type-safety templates were removed rather than documenting patterns this repository does not use.

## Guidelines Index

| Guide | Use it when changing |
|-------|----------------------|
| [Directory Structure](./directory-structure.md) | Static document organization, naming, feature placement, test layout |
| [State Management](./state-management.md) | Server snapshots, complete account drafts, raw/bulk/statistics/log/detail ownership |
| [Quality Guidelines](./quality-guidelines.md) | Native accessibility, rendering safety, responsive layout, UI/API verification |

## Pre-Development Checklist

- Trace the complete production inline-script flow and every caller before editing shared state or `api()`.
- Identify the owning snapshot/generation/controller; do not invent a second store or cursor.
- Preserve hidden account fields and temporarily invalid local drafts across redraw/navigation.
- Escape server text before `innerHTML`; use `textContent`/textarea values for arbitrary diagnostics.
- Use native controls and existing responsive wrappers; do not introduce a build system or dependency for one feature.
- Define the server validation/persistence boundary before adding browser-side feedback.

## Quality Check

- Compile the extracted production `<script>` with `vm.Script`.
- Run the focused production-VM tests plus `test/ui-contract.test.js`.
- Run `npm test` and `git diff --check`.
- Check stale success/catch/finally paths across section changes and aborted requests.
- For interactive/layout changes, collect real-browser keyboard, focus, dialog, live-status, and narrow-width evidence; do not describe static/VM tests as browser automation.
- Confirm no account/configuration write occurs before the existing explicit save action.

**Documentation language:** English.
