# Frontend State Management

> The console is one static HTML file with DOM state and authenticated JSON API calls; it has no framework or client-side store dependency.

---

## Scenario: Account and model-routing administration

### 1. Scope / Trigger

Use this contract when changing account rows, route scope, route editing, health recovery, or the `/api/accounts`, `/api/models`, and `/api/config` payloads shared by `public/index.html` and `server.js`.

The main cross-layer risk is destructive full-list account saves: account-specific `perModel`, notes, proxy, Header, weight, and priority fields must survive edits, filtering, presets, and drawer round trips.

### 2. Signatures

Frontend entry points:

```js
loadAll()
renderAccounts()
collectAccounts()
saveAccounts()
saveModelCfg(modelId, patch)
setupUpstreams(modelId, button)
renderUpstreamSetupProposal()
testUpstreamSetup()
applyUpstreamSetup()
closeUpstreamSetup()
changeRouteScope()
copyGlobalCfg(modelId)
inheritCfg(modelId)
recoverAccount(accountId)
openAccountDrawer(index, returnButton)
closeAccountDrawer(force)
saveDrawer()
previewPreset()
applyPreset()
renderErrorRules()
addErrorRule()
updateErrorRule(index, field, value)
moveErrorRule(index, direction, button)
openAdvancedErrorRules()
applyAdvancedErrorRules()
refreshAdvancedErrorRules()
previewErrorPreset()
applyErrorPreset()
loadStatistics(visitId, announce)
statisticsQuotaForecast(data)
renderStatisticsQuotaForecast(data)
refreshStatisticsQuota(force, visitId)
startStatisticsVisit()
stopStatisticsVisit()
restoreStatisticsVisit()
generateAliases()
saveAliases()
switchSection(section)
loadLogs(nextPage)
clearLogs()
```

API signatures:

```text
GET /api/accounts
  -> { accounts: [{ ..., health, statistics: { recent24h, lifetimeRequests, lifetimeErrors } }],
       mode, active, concurrencyWaitMs, errorRules,
       accountErrorRules, accountContentErrorRules, accountPipeline, stats }

POST /api/accounts
  <- { accounts, mode, active, concurrencyWaitMs, errorRules?,
       accountErrorRules?, accountContentErrorRules?, accountPipeline? }
  -> { ok, accounts: <count>, mode, active }

GET /api/statistics
  -> {
    generatedAt, window,
    lifetime: { global: AggregateProjection },
    recent24h: { global: AggregateProjection },
    accounts: [{
      id, name, enabled, lifetime, recent24h, health,
      quota: {
        status, pool, limits, fetchedAt, lastAttemptAt, lastSuccessAt,
        errorCategory,
        refresh: { eligible, reason, state, nextAttemptAt }
      }
    }],
    models: [{ id, recent24h, coverage: { complete, from } }],
    migration
  }

POST /api/statistics/quota-refresh
  <- { force: boolean }
  -> { ok: true, refreshed, cached, deferred, skipped, failed, cancelled }

GET /api/models[?accountId=<id>]
  -> { subscription: [{ id, config, configSource, meta }], accountId, ... }

POST /api/config
  <- { scope: "global" | "account", accountId?, perModel: { [model]: RouteConfig } }
  -> { ok, scope }

POST /api/config
  <- { scope: "account", accountId, action: "inherit", model }
  -> { ok, source: "inherited" }

POST /api/probe
  <- { model, accountId? }
  -> probe result + selected accountId

POST /api/validate-upstreams
  <- { model, accountId? }
  -> { ok, accountId, summary, results, upstreams }

POST /api/test
  <- { model, accountId?, upstreams?, exclude?, pinMode?, sort?, maxRetries?, providerCooldownMs? }
  -> temporary route test result; no route persistence

POST /api/accounts/recover
  <- { id }
  -> { ok: true }

POST /api/accounts/proxy-test
  <- { accountId, proxyUrl? }
  -> { ok, proxyType?, ms?, status?, reason? }

GET /api/model-aliases
  -> { aliases, targets }

POST /api/model-aliases
  <- { aliases }
  -> { ok, count }

GET /api/logs/{requests|errors}?<filters>&limit=<1..200>&cursor=<opaque>
  -> { items, nextCursor }; request items add bounded affinity/upstream-key/cache-hit/circuit facts, never key values

DELETE /api/logs/{requests|errors}
  -> { ok: true }
```

The browser sends the proxy/admin credential as `X-Admin-Key`; it stores that credential in `localStorage` under `cps_key` and refreshes it after `/api/security` changes the proxy key.

### 3. Contracts

#### Server-state snapshots

`DATA` owns the current `/api/models` response plus the ID-joined model-statistics projection from the concurrently accepted `/api/statistics` read. `ACCS` owns the current `/api/accounts` response, including safe runtime account summaries. `loadAll()` reloads these snapshots plus security/meta/alias state; successful destructive writes reload rather than continuing from an assumed server shape. Statistics join by resolved model ID and account statistics arrive embedded by stable account ID; names are never join keys.

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
  maxRetries,
  providerCooldownMs
}
```

Editing any inherited field creates an account-owned route. `copyGlobalCfg()` explicitly loads the global view and saves its complete route into the selected account. `inheritCfg()` deletes the account's own `perModel[model]`; it does not copy global fields into the account. `providerCooldownMs` is an integer 0-300000; 0 preserves legacy provider attempts.

Probe/validation/setup use the explicit route-scope account ID when present. One setup operation keeps probe, harvest and validation on that account, builds three local proposals (cache-first strict, availability-first preferred, automatic sticky), and opens a preview. Cancel writes nothing; test sends only the proposal to `/api/test`; confirm alone calls the existing complete-route save and reloads accepted state. Changing route scope while the preview is open makes it stale and blocks test/save.

`pinMode: "preferred"` remains a round-trip configuration value, but both modes now mean switcher-owned outer attempts with one provider per HTTP request. The browser must not describe `preferred` as gateway-side `order`. `meta.upstreamStatus[provider]` is a server projection of model/provider health (`status`, success/failure timestamps, failure count/class, `cooldownUntil`, and bounded note). It is display-only: frontend sorting must never override configured provider priority or claim to be the routing authority.

#### Full account save

`POST /api/accounts` replaces the account array. The implemented route field is `perModel` (not `modelRouting`). Therefore every row collected by `collectAccounts()` must carry:

```js
{
  id, name, note, key, enabled,
  maxConcurrent, weight, priority,
  proxyUrl, headers, perModel
}
```

`id` preserves runtime-state identity. `perModel` preserves all account-specific model routes even though the account table does not edit those routes inline. Omitting `perModel` would normalize it to `{}` and erase that account's overrides.

The active radio is an array index in the submitted list. The server resolves the selected account ID before filtering empty-key rows, so a blank row before the selected row must not shift the active account.

`ACCS.accountPipeline` is a complete canonical snapshot with `quotaPool`, `healthSort`, `sticky`, an exact three-step `order`, and integer `cachePoolSize` 0-100000. The ordered DOM and cache-pool input are live draft owners. The server also recognizes complete legacy four-step input, folds `excludeUnhealthy:true` into health sorting, and returns only canonical three-step state.

#### Local account drafts and bulk concurrency

`loadAll()` hydrates mode, wait, one complete ordered `ERROR_RULE_DRAFT = errorRules`, and pipeline controls from the server snapshot. `renderAccounts()` and `renderErrorRules()` only project existing drafts: search, add/delete/reorder, drawer apply, mode changes, bulk redraw and navigation preserve the complete rule array plus temporarily invalid advanced-JSON text. The active radio reads live mode without resetting `ACCS.active`.

`BULK_SELECTION` is a transient `Set` of account object references, not names or filtered indexes. `visibleAccountRows()` retains original indexes; `updateBulkSelection()` intersects selection with current visible objects and uses that same set for names/count and application. Search changes and reload clear selection; redraw prunes hidden/deleted objects; new rows begin unselected. Duplicate names and unsaved rows must never transfer selection to another object.

`applyBulkConcurrency()` accepts only non-empty finite integers 0–100000 (0 means unlimited). Empty selection or invalid input announces an error without mutation or persistence. A valid operation changes only selected `maxConcurrent`, retains selection, and announces the draft-only result. Full hidden fields, active selection, unselected accounts, and scheduling controls remain unchanged. Only the ordinary explicit `saveAccounts()` persists the combined draft; presets retain their existing confirm-and-save behavior.

- **Good:** a pending drawer note and invalid rule text survive bulk apply and search; fix JSON before explicit save.
- **Base:** select-all targets only current name/note matches, and no matches disables selection/application.
- **Bad:** hydrate scheduling controls during every redraw, or use an account name as batch identity.

```js
// Wrong: filtered indexes can retarget after deletion/search.
selectedIndexes.forEach(i => { ACCS.accounts[i].maxConcurrent = value; });
// Correct: validate first, then mutate only current selected visible objects.
for (const account of updateBulkSelection()) account.maxConcurrent = value;
```

`test/account-draft.test.js` executes the production embedded script in Node VM to verify exact target-only changes, 0/100000 boundaries, invalid/empty no-ops, no apply-time requests, search/rename/delete/new-row/reload lifetime, live controls and drawer-note preservation, and explicit-save payloads. `test/integration.test.js` verifies ordinary combined account/scheduling API round trips with local mocks and temporary data. These checks do not prove browser focus, keyboard or responsive behavior.

#### Raw scheduling draft editor

`openRawScheduling(button)`, `validateRawScheduling(value, names)`, `applyRawScheduling()`, and `closeRawScheduling(force=false)` reuse the live scheduling controls and the unified rule draft; `RAW_SCHEDULING` is only an editor snapshot, never a second account/rule store. The complete JSON has exactly `accountMode`, `concurrencyWaitMs`, `errorRules`, `accountPipeline`, and `accountNames`; `accountPipeline` contains the three canonical booleans, the same exact order shown by visual controls, and integer `cachePoolSize` 0-100000. `accountMode` maps to the existing mode control; ordered names include all accounts, duplicates and unsaved rows regardless of search. Names are reference-only, not identities. Never project IDs, Keys, notes, proxies, Headers, account parameters, runtime state or `perModel` into this editor.

Validation precedes every control write: six modes; integer wait 0–30000; exactly three boolean pipeline keys and order permutation; bounded cache size; and the complete canonical ordered rule schema (IDs, scopes, actions, applicability, statuses, body ANY, Header, and strict reset). Unknown/missing/duplicate fields, invalid JSON numeric types, prototype-like keys, unsafe text, and changed reference names are rejected without coercion.

| Condition | Local result |
|---|---|
| Invalid live rule JSON or wait on open | Announce field error; preserve original input; do not open |
| Invalid editor JSON/schema | Keep text/dialog open; no account/control mutation or request; do not echo arbitrary values |
| Replaced `ACCS`, changed scheduling controls, renamed/reordered/replaced/deleted account objects | Reject as stale and require reopening; preserve newer draft |
| Valid apply | Update scheduling controls only, redraw without hydration, close and announce draft-only result |
| Dirty cancel/Escape | Confirm discard; cancellation never applies |
| Successful ordinary save/reload | Hydrate saved controls and clear obsolete raw draft feedback; retain any open editor text and reject its stale apply |

- **Good:** pending bulk concurrency plus raw policy changes survive the ordinary full-account save with active identity and hidden fields intact.
- **Base:** opening and clean cancellation perform no requests and leave controls unchanged.
- **Bad:** reconstruct accounts by reference names or post the six-field editor object to the destructive account API.

```js
// Wrong: saveAccounts(JSON.parse(rawSchedulingJson.value));
// Correct: validate the complete editor value, assign existing scheduling controls,
// then let the operator explicitly invoke the unchanged saveAccounts().
```

`test/account-draft.test.js` executes production projection/apply/cancel/stale and validation logic, combined bulk/raw payload preservation, and existing preset compatibility. `test/integration.test.js` covers the ordinary combined API round trip. VM/static checks are not browser keyboard/focus/responsive verification.

#### Rendering and sensitive values

All server-provided text used in HTML strings passes through `escapeHtml()` (or `jsArg()` where a JavaScript string argument is needed). Provider health renders `degraded`, active cooldown remaining time, and expired/half-open state without reordering the stable provider list. Status regions use `aria-live="polite"`. Account keys are password inputs unless the operator explicitly enables “show keys.” This is display protection only; account data comes from the management API and must be protected by the configured proxy key.

Key visibility is transient drawer UI state: every `openAccountDrawer()` clears the show control and restores `drawerKey.type = "password"`. Visibility state is excluded from `drawerValue()`, so showing or hiding an unchanged Key never marks the account draft dirty.

Raw sessions and message content must never be added to account, model, history or ordinary diagnostic state/views. Account notes, proxy URLs/authentication, account Keys and custom Header values remain owned by the authenticated drawer and must not be copied into ordinary log rows/details. Only the separately enabled detailed panel may hold sanitized captured model HTTP headers/content, under the bounded authenticated API contract in `../backend/logging-guidelines.md`; it never receives raw credentials or whole account objects.

#### Preset, alias, and log state

Preset selection owns a temporary draft only. Confirm submits the complete ordinary account payload; cancel discards it. Presets may not mutate Key, proxy, Header, note, enablement, or `perModel`.

`ALIASES` owns the `/api/model-aliases` snapshot. Batch generation edits text locally; successful save reloads aliases and models. Alias targets are server-provided known `cline-pass/*` models.

Error-rule presets are separate from scheduling presets. The cache-hit preset preserves account identity, credentials, transport, Headers, routes, pipeline booleans, and custom rules while merging stable preset rule IDs. The five rule presets read the complete ordered rule draft; merge replaces matching IDs and preserves custom rules, replace computes deletions, clear is replace-only. Preview classifies preserve/add/modify/delete; cancel is a no-op, and confirm uses the ordinary authenticated full-account save.

The top-level section is projected by `consolePanel.hidden`, `statisticsPanel.hidden`, `logPanel.hidden`, `detailsPanel.hidden`, and five navigation buttons' `aria-pressed` values. Console, statistics, request logs, error logs and detailed logs are mutually exclusive. Request and error navigation share one `logPanel`; `logType` remains the single selected-type owner, while the title and live status are projections of it.

`STATISTICS_QUERY_ID` is independent of log state. `loadStatistics()` may render only when its captured query/visit generation still matches and `statisticsPanel` is visible. A coverage count of zero, `null` overflow, missing ratio, missing quota window, or zero success samples must render as unknown/no data rather than numeric zero. The model table displays only rolling cache Token ratio (`cacheInputCachedTokens / cacheInputTokens`) plus paired-usage sample count and incomplete-window label; it does not display request hit rate. The account main table reads only each account object's stable-ID summary and never submits runtime health/statistics through `collectAccounts()`. All account/provider text is escaped, and raw quota/provider payloads never become frontend state.

#### Statistics quota visit ownership

`STATISTICS_VISIT_ID`, `STATISTICS_TIMER`, `STATISTICS_REFRESH_CONTROLLER`, `STATISTICS_REFRESH_PROMISE`, and `STATISTICS_REFRESH_VISIT` own one browser visit independently of account, raw, bulk, ordinary-log and detail state.

- Entry renders the current authenticated `GET /api/statistics`, starts one cache-aware `POST /api/statistics/quota-refresh` with `force:false`, then rereads the projection. A single five-minute timer repeats only while that visit remains visible.
- Manual refresh uses `force:true` but coalesces with an active sweep from the same visit. The button is natively disabled and labelled while busy; `statisticsStatus` announces loading, bounded outcome counts or retained-data failure.
- Section changes and `pagehide` increment visit/query generations, clear the timer and abort only the page-owned POST. `pageshow` restarts a visible statistics visit only when no timer is active. Success, catch and finally handlers all check visit/controller identity so an old request cannot render, announce, re-enable or clear a newer visit.
- Statistics reads persisted server accounts only. Disabled accounts retain last-known values but are not queried; unconfigured, unknown, partial, failed and stale values remain distinct from numeric 0%/100%. Remaining percentage is computed only from a validated finite used value, and missing/invalid reset times render unavailable.
- The total quota forecast is a pure projection of the same accepted `GET /api/statistics` snapshot. It includes only rows with `enabled === true`, `quota.status === "fresh"`, and all three finite 0–100 windows. For each included account, current availability is the minimum of the 5-hour/weekly/monthly remaining percentages; totals sum those account minima, with a maximum of `included * 100` account quota points.
- Future +2h/+8h/+24h projections assume no new consumption. A window becomes 100% only when its canonical reset is strictly after `generatedAt` and at or before the target; otherwise its current remaining value is carried forward. Missing, invalid, already-past resets or invalid `generatedAt` make that account's future projection a conservative lower bound and are counted explicitly. Disabled/non-fresh/incomplete rows are excluded and counted, never coerced to zero or full capacity. The projection is not a Token, request, monetary, or provider absolute limit.
- `loadStatistics()` renders the forecast only after its existing query/visit/visibility checks accept the snapshot. The forecast adds no request, timer, cursor, persistence, or generic store, and uses `textContent` for bounded numeric output.
- Statistics navigation/refresh never calls `loadAll()` or mutates `ACCS`, `BULK_SELECTION`, raw JSON, live scheduling controls or detailed-log state. It does not enable quota routing or persist account/configuration changes.

Request-log rows additionally render only bounded affinity type/confidence, caller/derived upstream-key source/applied state, provider-order override, provider-circuit attempt action and cache-hit true/false/unknown. Missing historical fields render unknown. Actual caller/derived keys, raw sessions and fingerprints never enter ordinary frontend state or markup.

`LOG_CURSOR` belongs to the current log type plus filter set. Starting a new query or changing filters resets it; “next” sends the opaque server cursor unchanged. The request type alone owns the `result` filter and renders `status / result`; missing historical results derive only the display label `success` or `legacy_failed` without mutating storage. The shared description distinguishes one-row-per-final-request from potentially-many-upstream-attempts. `LOG_QUERY_ID` is a generation counter: every section switch and query invalidates earlier reads, and a response may render only when both its generation and captured type still match. Clearing logs captures the selected type before the asynchronous delete and reloads only when that same log section remains visible.

#### Detailed settings and selected-content ownership

```js
api(path, body, method, asText = false, options = {})
loadDetailSettings()
toggleDetailedLogging()
loadDetails(next = false)
selectDetail(requestId)
loadDetailBody(requestId, bodyId, state)
copyDetailBody()
clearDetails()
```

The fourth `api()` argument preserves authenticated text-body reads (including 401/login and non-OK handling); do not repurpose it when adding options to this shared helper. `detailJSON()` rejects safe API errors. The details API schemas/strict filters are owned by `../backend/logging-guidelines.md`.

`DETAIL_NAV_ID`, `DETAIL_LIST_ID` and `DETAIL_SELECTION_ID` are independent generations. Every section switch invalidates list/selection/navigation; metadata/body responses require the captured generation and visible details panel, and bodies also require the selected request ID. `DETAIL_CURSOR` belongs to the current filter set: editing any filter invalidates list/selection, clears the cursor and loaded copy content, disables Next and requests a refresh. Starting a query disables Next; only its accepted response can enable it.

`DETAIL_CONFIRMED`, `DETAIL_TOGGLE_PENDING` and `DETAIL_SETTINGS_ID` own settings. A stale settings GET cannot undo a later POST; a failed POST restores the confirmed mode. Navigation away suppresses stale status messages, but a completed setting write still updates the confirmed value. Do not call `loadAll()`, `saveAccounts()` or mutate ACCS, bulk selection, raw editor or live scheduling controls for any diagnostic action.

`DETAIL_BODY_TEXT` is null during reads/invalidations; copy uses only its loaded sanitized string, not metadata, raw network errors or stale text. Clear captures navigation before awaiting DELETE, invalidates pending detail reads, removes loaded content and reloads only if that same details navigation is still visible. Missing/expired bodies remain a safe empty/error state.

- **Good:** a dirty bulk/raw draft survives settings save, filtering, copy and clear.
- **Base:** selecting a root loads only metadata; selecting one body reads only that body.
- **Bad:** reuse the ordinary `LOG_QUERY_ID` or `LOG_CURSOR`, or fetch all 50 roots' bodies at once.

```js
// Wrong: a changed filter skips newer matches using the previous query cursor.
params.set('cursor', oldCursor);
// Correct: invalidate at the input boundary, before pending reads can render.
DETAIL_LIST_ID++; DETAIL_CURSOR = null; resetDetailSelection();
```

`test/detailed-log-ui.test.js` executes production functions for five-section navigation, account/raw/bulk preservation, settings failure/staleness, list/body selection staleness, safe text/copy fallback, clear/navigation and filter/cursor invalidation. `test/ui-contract.test.js` checks DOM labels and privacy/accessibility markers. Neither proves browser interactions.

### 4. Validation & Error Matrix

| UI/API condition | Required behavior |
|---|---|
| Visual rule edit is invalid/duplicate/out of bounds | Announce the error; keep the unified draft unchanged; do not call the API |
| Advanced JSON is invalid | Preserve its text for correction; do not mutate the unified draft or call the API |
| Advanced JSON generation is stale after a visual edit/reload | Reject apply and require explicit refresh from the current draft; never overwrite newer rules |
| Error-rule preset is cancelled | discard `PENDING_ERROR_PRESET`; do not mutate the unified draft/server state |
| Rule preset merge/replace/clear is confirmed | update only status rules, preserve content order, and send the computed unified draft through `saveAccounts()`; server validation remains authoritative |
| Visual `cachePoolSize` is empty, fractional, nonnumeric, or outside 0-100000 | Announce a field error; do not construct/send a request or change the draft |
| `accountPipeline` is incomplete, contains unknown keys/non-booleans, or has invalid `cachePoolSize` | server `400`; retain/reload prior state |
| Statistics response becomes stale after navigation | ignore it; do not update hidden/newly selected content |
| A quota refresh settles after navigation, pagehide or a newer visit | Ignore stale success/catch/finally; do not update status/button/table or cancel another source |
| Manual/timer/entry refresh overlaps in one visit | Coalesce into one POST; do not queue replay work |
| Statistics page is restored after pagehide | Start one visible visit only when its timer is absent; repeated pageshow is a no-op |
| Usage coverage is zero or a field/ratio is `null` | render “no data”; do not render `0` |
| Quota window is missing/invalid or snapshot is failed/partial/stale/disabled | Show explicit unknown/last-known state and time; never infer zero or routing freshness; exclude the account from total quota points |
| Forecast reset is missing/invalid/past, or `generatedAt` is invalid | Carry the current remaining value forward, count the account once as reset-incomplete, and label future values as a conservative lower bound |
| No submitted account has a non-empty key | stop and display an error |
| Account mode is not one of the six supported scheduling modes | server `400`; retain/reload prior state |
| `concurrencyWaitMs` is not an integer in 0-30000 | server `400` |
| Account `maxConcurrent` is not an integer in 0-100000 | server `400` |
| Weight/priority is outside integer 1-100, note invalid, proxy malformed, or Header map unsafe | server `400`; retain/reload prior state |
| Existing account ID is unknown/changed or duplicated | server `400` |
| Alias text is malformed/duplicated or server target invalid | block locally when possible; server `400` remains authoritative |
| Log filter/cursor query is rejected | show safe error; do not render stale results as current |
| Detail filter edited while reads are pending | Invalidate response generations, selected/copy text and old cursor; disable Next |
| Detailed toggle fails or stale settings read completes | Preserve latest confirmed mode and every account/raw/bulk draft |
| Detail clear completes after navigation away | Do not reload another section |
| Dirty drawer closes by Escape/backdrop/button | confirm before discard and restore opener focus |
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
- **Good:** merge a built-in error preset into a live custom `418` rule; preview marks `418` preserved and confirmation round-trips both through the normal save.
- **Good:** leave the statistics panel before its request completes; the stale generation never renders, and a covered token value of zero remains distinguishable from no covered requests.
- **Good:** compute each eligible account's three-window minimum before summing; a reset exactly at a target restores only that window for that target and later targets.
- **Good:** a pending account note, bulk selection and invalid scheduling-rule draft survive entry/manual quota refresh and return to the console unchanged.
- **Base:** a disabled account displays its retained quota and last-success time but creates no page refresh request; a never-fetched disabled account remains unknown.
- **Base:** global scope has no `accountId`; model saves update global `perModel` only.
- **Base:** a new account row starts with `maxConcurrent: 0`, `weight: 1`, `priority: 100`, direct transport, empty note/Header fields, and `perModel: {}`.
- **Bad:** construct account payloads from visible table columns only and omit `perModel`; this silently deletes account-specific routes.
- **Bad:** infer account scope from the rendered badge while sending no `scope`/`accountId`; the backend defaults to global.
- **Bad:** merge an account route field-by-field with the global route; account ownership is whole-entry replacement.
- **Bad:** sum all window percentages directly, include stale/disabled rows, or treat missing reset times as an automatic 100%; each choice overstates usable capacity.

### 6. Tests Required

Cross-layer changes must assert:

- `/api/models?accountId=` reports `account` for an own route and `inherited` after `action: "inherit"`;
- provider attempts use the selected account route, while an account without an own entry uses the global route;
- preferred-mode copy says fallback is switcher-managed with singleton `only`, and health/cooldown labels render escaped without reordering configured or discovered provider lists;
- posting `/api/accounts` with the full account snapshot preserves stable IDs, `perModel`, notes, proxy/Header fields, weight/priority, mode, active account, wait, and rules;
- filtering/searching account rows or a blank-key row does not change which account is active;
- scheduling preset preview/cancel/apply changes only allowed fields and round-trips through the normal save; the cache-hit preset drafts sticky/2/5000, exposes priorities, and cancellation changes nothing;
- visual add/edit/delete/reorder and advanced JSON apply share one generation-controlled canonical rule array; invalid/stale text cannot overwrite it, and presets preview stable-ID merge/replace/clear;
- all three pipeline booleans, the three-step order, and `cachePoolSize` survive a full save; recognized legacy four-step input migrates deterministically while malformed values fail without persistence;
- statistics generation invalidation prevents stale rendering, coverage-zero/null values remain unknown, per-model cache Token summaries join by resolved ID, account summaries stay stable-ID keyed, and all rendered server text is escaped;
- statistics entry/manual/five-minute refresh coalesces per visit, aborts page ownership on leave, restores one visit on pageshow, and guards success/catch/finally from older visits;
- remaining/reset-only quota rendering preserves known 0%/100%, omits redundant used text, and labels unconfigured, disabled, unknown, partial, failed and stale snapshots truthfully without changing drafts or quota routing;
- fixed-time quota forecast fixtures assert account-minimum-before-sum, current/+2h/+8h/+24h target boundaries, 0%/100%, eligible/excluded counts, conservative missing-reset behavior, invalid `generatedAt`, no-data rendering, and update from the accepted statistics snapshot;
- alias generation/save/reload and log type/filter/cursor/clear keep separate state owners;
- request logs alone filter/render `result`, historical rows without it use a display-only fallback, and the shared description distinguishes one final request from potentially many failed attempts;
- top-level console/statistics/request/error/details sections remain mutually exclusive, request/error reuse one log owner, details keep their own generations, and stale reads or clears cannot update a different section;
- invalid scope, malformed JSON, immutable ID changes, empty account lists, and invalid rule shapes return `400` without persistence;
- account recovery clears displayed dynamic state after reload;
- every server-controlled name, reason, model, provider, and trace note is HTML-escaped before `innerHTML` use;
- keyboard-operable controls remain buttons/selects/inputs and asynchronous status remains announced.

The Node integration suite proves API route ownership/inheritance, account schema validation, aliases, logs, ID validation, and active-account filtering. `test/ui-contract.test.js` statically verifies required controls and safety markers, but it is not browser automation. Visual width, narrow-screen scrolling, focus order, keyboard-only drawer use, masking, and live interactions still require manual browser review and must not be claimed as automated coverage.

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
  ...a,
  name: readName(i),
  enabled: readEnabled(i)
}));
const accountPipeline = {
  quotaPool: pipelineQuotaPool.checked,
  healthSort: pipelineHealthSort.checked,
  sticky: pipelineSticky.checked,
  order: pipelineOrder(),
  cachePoolSize: Number(cachePoolSize.value)
};
```

The full-list save preserves hidden server-owned associations instead of rebuilding accounts from visible cells alone. Statistics and logs keep separate query generations; neither may reuse a single stale-response owner.

```js
// Wrong: an old request can update a newer or hidden statistics visit.
const data = await api('/api/statistics/quota-refresh', { force });
statisticsStatus.textContent = quotaRefreshSummary(data);

// Correct: bind POST, reread, catch and finally to one visible visit/controller.
if (visitId === STATISTICS_VISIT_ID &&
    controller === STATISTICS_REFRESH_CONTROLLER &&
    !statisticsPanel.hidden) {
  await loadStatistics(visitId, false);
  statisticsStatus.textContent = quotaRefreshSummary(data);
}
```
