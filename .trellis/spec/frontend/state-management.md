# Frontend State Management

> The console is one static HTML file with DOM state and authenticated JSON API calls; it has no framework or client-side store dependency.

---

## Scenario: Account and model-routing administration

### 1. Scope / Trigger

Use this contract when changing account rows, route scope, route editing, health recovery, or the `/api/accounts`, `/api/models`, and `/api/config` payloads shared by `public/index.html` and `server.js`.

The main cross-layer risk is destructive full-list account saves: account-specific `perModel` routes must survive edits to names, keys, enablement, capacity, mode, active account, wait time, or error rules.

### 2. Signatures

Frontend entry points:

```js
loadAll()
renderAccounts()
collectAccounts()
saveAccounts()
saveModelCfg(modelId, patch)
changeRouteScope()
copyGlobalCfg(modelId)
inheritCfg(modelId)
recoverAccount(accountId)
```

API signatures:

```text
GET /api/accounts
  -> { accounts, mode, active, concurrencyWaitMs, accountErrorRules, stats }

POST /api/accounts
  <- { accounts, mode, active, concurrencyWaitMs, accountErrorRules }
  -> { ok, accounts: <count>, mode, active }

GET /api/models[?accountId=<id>]
  -> { subscription: [{ id, config, configSource, meta }], accountId, ... }

POST /api/config
  <- { scope: "global" | "account", accountId?, perModel: { [model]: RouteConfig } }
  -> { ok, scope }

POST /api/config
  <- { scope: "account", accountId, action: "inherit", model }
  -> { ok, source: "inherited" }

POST /api/accounts/recover
  <- { id }
  -> { ok: true }
```

The browser sends the proxy/admin credential as `X-Admin-Key`; it stores that credential in `localStorage` under `cps_key` and refreshes it after `/api/security` changes the proxy key.

### 3. Contracts

#### Server-state snapshots

`DATA` owns the current `/api/models` response. `ACCS` owns the current `/api/accounts` response. `loadAll()` reloads both snapshots plus security/meta state; successful destructive writes reload rather than continuing from an assumed server shape.

The route scope selector is explicit:

- empty value requests `/api/models` and edits `scope: "global"`;
- an account ID requests `/api/models?accountId=...` and edits `scope: "account"` with that same ID;
- `configSource` is `global`, `account`, or `inherited` as returned by the server.

`saveModelCfg()` sends a complete route entry, not a partial patch:

```js
{
  upstreams,
  exclude,
  pinMode,
  sort,
  maxRetries
}
```

Editing any inherited field creates an account-owned route. `copyGlobalCfg()` explicitly loads the global view and saves its complete route into the selected account. `inheritCfg()` deletes the account's own `perModel[model]`; it does not copy global fields into the account.

#### Full account save

`POST /api/accounts` replaces the account array. The implemented route field is `perModel` (not `modelRouting`). Therefore every row collected by `collectAccounts()` must carry:

```js
{ id, name, key, enabled, maxConcurrent, perModel }
```

`id` preserves runtime-state identity. `perModel` preserves all account-specific model routes even though the account table does not edit those routes inline. Omitting `perModel` would normalize it to `{}` and erase that account's overrides.

The active radio is an array index in the submitted list. The server resolves the selected account ID before filtering empty-key rows, so a blank row before the selected row must not shift the active account.

#### Rendering and sensitive values

All server-provided text used in HTML strings passes through `escapeHtml()` (or `jsArg()` where a JavaScript string argument is needed). Status regions use `aria-live="polite"`. Account keys are password inputs unless the operator explicitly enables “show keys.” This is display protection only; account data comes from the management API and must be protected by the configured proxy key.

Raw sessions and message content are not frontend state and must never be added to account, model, history, or diagnostic views.

### 4. Validation & Error Matrix

| UI/API condition | Required behavior |
|---|---|
| Error-rules textarea is invalid JSON | stop in `saveAccounts()`; display an error; do not call API |
| No submitted account has a non-empty key | stop and display an error |
| Account mode is not `single`, `roundrobin`, or `sticky` | server `400`; retain/reload prior state |
| `concurrencyWaitMs` is not an integer in 0-30000 | server `400` |
| Account `maxConcurrent` is not an integer in 0-100000 | server `400` |
| Existing account ID is unknown/changed or duplicated | server `400` |
| Account route or global route is invalid | server `400`; `saveModelCfg()` reloads on failure |
| Route account ID is unknown | server `400` |
| Recover account ID is unknown | server `400` |
| `/api/test` selects an unavailable account | server `409` |
| Management request gets `401` | show the login overlay and reject the API call |
| Saved/deleted account was the selected route scope | clear the stale scope, then reload |

Browser-side validation improves feedback but never replaces the server matrix.

### 5. Good / Base / Bad Cases

- **Good:** edit account A's name and capacity; `collectAccounts()` submits A's unchanged `id` and `perModel`, so its routes and cooldown/ban join key survive.
- **Good:** select account A, copy a global model route, edit it, observe `configSource: "account"`, then restore inheritance and observe `"inherited"` after reload.
- **Base:** global scope has no `accountId`; model saves update global `perModel` only.
- **Base:** a new account row starts with `maxConcurrent: 0` and `perModel: {}`.
- **Bad:** construct account payloads from visible table columns only and omit `perModel`; this silently deletes account-specific routes.
- **Bad:** infer account scope from the rendered badge while sending no `scope`/`accountId`; the backend defaults to global.
- **Bad:** merge an account route field-by-field with the global route; account ownership is whole-entry replacement.

### 6. Tests Required

Cross-layer changes must assert:

- `/api/models?accountId=` reports `account` for an own route and `inherited` after `action: "inherit"`;
- provider attempts use the selected account route, while an account without an own entry uses the global route;
- posting `/api/accounts` with the full account snapshot preserves stable IDs, `perModel`, mode, active account, wait, and rules;
- filtering a blank-key row does not change which account is active;
- invalid scope, malformed JSON, immutable ID changes, empty account lists, and invalid rule shapes return `400` without persistence;
- account recovery clears displayed dynamic state after reload;
- every server-controlled name, reason, model, provider, and trace note is HTML-escaped before `innerHTML` use;
- keyboard-operable controls remain buttons/selects/inputs and asynchronous status remains announced.

The Node integration suite proves the API route ownership/inheritance, ID validation, and active-account filtering contracts. There is currently no browser automation proving DOM round trips, escaping, or accessibility; those require manual console review or a future browser-level test and must not be claimed as automated coverage.

### 7. Wrong vs Correct

#### Wrong

```js
const accounts = ACCS.accounts.map((a, i) => ({
  name: readName(i),
  key: readKey(i),
  enabled: readEnabled(i),
  maxConcurrent: readLimit(i)
}));
```

#### Correct

```js
const accounts = ACCS.accounts.map((a, i) => ({
  id: a.id,
  name: readName(i),
  key: readKey(i),
  enabled: readEnabled(i),
  maxConcurrent: readLimit(i),
  perModel: a.perModel || {}
}));
```

The full-list save preserves hidden server-owned associations instead of rebuilding accounts from visible cells alone.
