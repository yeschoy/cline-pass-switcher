# Frontend Quality Guidelines

> Executable UI contracts for the static Cline Pass administration console.

---

## Scenario: Responsive account administration and diagnostic views

### 1. Scope / Trigger

Use this contract when changing `public/index.html` account management, presets, the account drawer, model aliases, or request/error logs.

The console is a single static HTML file with authenticated JSON calls. Server validation remains authoritative, while the browser must preserve hidden account state and prevent accidental destructive changes.

### 2. Signatures

```js
loadAll()
renderAccounts()
collectAccounts()
pipelineNumberDraft()
pipelineIntegerDraft(id, label, min, max)
cachePoolSizeDraft()
openAccountDrawer(index, returnButton)
closeAccountDrawer(force)
saveDrawer()
previewPreset()
applyPreset()
previewErrorPreset()
applyErrorPreset()
previewRetryPreset()
applyRetryPreset()
closeRetryPreset()
addRetryRule()
updateRetryRule(index, field, value)
moveRetryRule(index, direction, button)
deleteRetryRule(index)
openAdvancedRetryRules()
applyAdvancedRetryRules()
refreshAdvancedRetryRules(force)
loadStatistics(visitId, announce)
statisticsQuotaForecast(data)
renderStatisticsQuotaForecast(data)
refreshStatisticsQuota(force, visitId)
startStatisticsVisit()
stopStatisticsVisit()
restoreStatisticsVisit()
generateAliases()
saveAliases()
setupUpstreams(modelId, button)
testUpstreamSetup()
applyUpstreamSetup()
switchSection(section)
loadLogs(nextPage)
clearLogs()
```

Relevant APIs:

```text
GET/POST /api/accounts
GET      /api/statistics
POST     /api/statistics/quota-refresh
POST     /api/accounts/proxy-test
GET/POST /api/model-aliases
GET      /api/logs/{requests|errors}
DELETE   /api/logs/{requests|errors}
```

### 3. Contracts

#### Responsive layout

- The page uses the available desktop width up to 1800px; it must not restore the old 1200px cap.
- Wide tables live in `.table-wrap { overflow-x: auto }` rather than squeezing fields until unusable.
- Account names have at least a 240px desktop column and a full-value `title`. Common email-style names remain inspectable.
- At widths below 600px, page/drawer padding decreases, but controls remain reachable and tables scroll horizontally.

#### Account table and drawer

The main table is a status summary. Its cache/success/failure cells come from each authenticated account object's stable-ID runtime projection, never the editable/repeatable account name. It shows rolling cache Token ratio and direct 24-hour account success rate with sample/coverage facts. Disabled, cooling, and hard quarantine are separate dispositions; missing, overflowed or incomplete coverage remains explicit. Full name, note, Key, capacity, weight, priority, proxy URL, custom Header map, and account-route summary are edited in the right-side account drawer. Runtime `health`, `statistics`, active counts, quota, cache roles and the `ACCS.cachePool` min/max/target/binding summary are projections only and never enter `collectAccounts()`.

The drawer:

- is a labelled `role="dialog"` with `aria-modal="true"`;
- moves focus into the form and returns focus to the opening control;
- closes on Escape/backdrop/Close only after confirming dirty drafts;
- masks account Key and proxy URL by default;
- resets the Key visibility control and input type on every open, while excluding visibility-only state from the dirty-draft snapshot;
- keeps proxy/error feedback in an `aria-live` region;
- exposes the per-minute RPM limit as a labelled native number input `#drawerRpm` (`<label for="drawerRpm">` plus `type="number" min="0" max="100000"`), hydrates it from the account's `maxRpm || 0`, and clamps any out-of-range/fractional draft silently to `0..100000` in `saveDrawer()`;
- saves into the local complete account snapshot, then requires the explicit account-config save for persistence.

`collectAccounts()` must preserve every hidden field:

```js
{
  id, name, note, key, enabled,
  maxConcurrent, maxRpm, weight, priority,
  proxyUrl, headers, perModel
}
```

Filtering by name/note changes rendering only; it must not change account indexes, active-account identity, or the submitted full list.

#### Bulk concurrency controls

Bulk selection uses native row checkboxes with escaped account-name labels, separate from active/enabled controls. Current-search select-all exposes native checked/indeterminate/disabled state. A labelled number input has `min=0`, `max=100000`, and `step=1`; application still validates the complete input before mutation. Empty targets disable apply. A bounded scrolling `textContent` summary lists full selected names/count, and `aria-live` feedback announces errors and local application. Persistent guidance explains that changes remain a draft until “保存账号配置” and that changing search clears selection, not edits. Selection and hydration contracts are in `state-management.md`.

`test/ui-contract.test.js` checks these native/label/live-region markers; `test/account-draft.test.js` executes actual production logic. Keyboard-only row/select-all use, mixed-state announcement, stable focus after apply, full-name readability and desktop/narrow layouts still require browser review.

#### Raw scheduling modal

The raw scheduling entry opens a native `<dialog>` with `showModal()`, title/help associations, a labelled JSON textarea, native apply/cancel buttons, and separate `aria-live` error/draft feedback. Guidance must identify current-page draft state, pool-wide policy, reference-only full names, runtime eligibility constraints, and the separate “保存账号配置” persistence step. Use textarea `.value` and feedback `.textContent`, never interpolate raw JSON into HTML.

The modal focuses the textarea on open and returns focus to its opener after apply/close. Native `cancel` (Escape) is prevented and routed through dirty-text discard confirmation; declining keeps the editor open. Width/max-height/overflow and wrapped textarea text keep long names inspectable. Validation and stale errors preserve text for correction; see `state-management.md` for exact schema and draft ownership.

`test/ui-contract.test.js` checks native modal/label/live-region/wrapping markers; production VM tests check cancel routing and explicit focus calls, not actual browser focus containment. Keyboard open/apply/cancel/Escape, discard prompts, focus containment/return, long duplicate names and narrow viewport scrolling remain required manual browser checks.

#### Presets and pipeline controls

The three canonical pipeline rows (`quotaPool`, account `healthSort`, and `sticky`) are native draggable elements with visible handles, current position numbers, independent enablement checkboxes, and native up/down button equivalents. Mouse drop and keyboard-operable buttons call the same DOM reorder owner, update first/last disabled states, and announce the draft-only result through `aria-live`. Disabled steps remain orderable and retain their positions; reordering never sends a request.

The seven scheduling presets produce an editable draft and preview. They may change only scheduling fields and merge stable-ID canonical error rules. The cache-hit preset sets sticky mode, `cachePoolSize: 2`, `cachePoolMaxSize: 2`, `cachePoolLowQuotaSize: 1` (auto-growth inert) and a 5000 ms wait while exposing priorities for review; when applied onto a draft whose max is smaller, `previewPreset()` raises max to at least min and shows that change. Presets never mutate names, Keys, enablement, proxy, Header maps, model routes, custom rules or the three pipeline toggles.

The error-rule panel owns one complete ordered `ERROR_RULE_DRAFT` array and renders native controls for stable ID, account/provider-model scope, Provider/model applicability, statuses, body ANY, Header, action, and cooldown reset. Operators can add/edit/delete/reorder rules; invalid changes are announced without mutating the draft. Its advanced JSON is a generation-checked `<details>` snapshot with explicit apply/refresh.

The five error-rule presets are `standard`, `fast`, `conservative`, `observe`, and `clear`. They read the complete current array and show preserve/add/modify/delete groups. Merge replaces only matching stable IDs and preserves custom rules; replace may delete them; clear forces replacement.

The request-level retry editor owns `RETRY_RULE_DRAFT` and renders a native table (`#retryRuleBody`) of stable ID, fixed `stop` badge, status-code input, body-ANY textarea and up/down/delete buttons with a labelled `#retryRuleFeedback` `aria-live="polite"` region. A labelled advanced-JSON `<details>` (`#advancedRetryRulesJson`) snapshots the draft and exposes apply/refresh. Every server- or operator-provided value (ID, statuses, needles) renders through `escapeHtml()`. The only retry preset is the manual “invalid system message stops retry” preview (`#retryPresetModal`), which merges the stable retry ID and the paired provider-model `ignore` rule into both drafts and persists atomically through the ordinary account save; cancel changes nothing.

The paired preset and retry rules never render a needle, matched fragment, candidate rate or raw rule condition into any exported/logged projection. The provider mode select labels are `首选固定+健康回退` (strict) and `Switcher 健康自动选择` (preferred); the removed `严格钉住`/`优先+回退` wording must not return, and the option `title` must explain that strict pins the source-order first attempt then falls back by Provider-model 24-hour success rate, while preferred uses that health order from the first attempt.

Cancel discards the relevant draft. Confirm submits through the ordinary complete account save, so the server applies the same validation as manual edits. No persistent selected-preset state exists. Pipeline controls submit the three canonical booleans plus the exact DOM order and the six bounded integer fields (`cachePoolSize`, `cachePoolMaxSize`, `cachePoolLowQuotaSize`, both session-binding TTLs and `sessionBindingMaxEntries`). Empty, fractional, nonnumeric, or out-of-range drafts — including `cachePoolLowQuotaSize > cachePoolSize`, `cachePoolMaxSize < cachePoolSize` and `sessionBindingFallbackTtlMs > sessionBindingExplicitTtlMs` — block visual save and preset preview without coercion or a request. Authenticated account rows may display only safe runtime `cachePoolRole` active/standby and `cachePoolQuotaRole` high/low/unknown labels; these fields are never submitted as static account configuration. A positive-low effective pool prioritizes low before high; low=0 preserves legacy priority/ID selection.

The fieldset legend is “会话命中条件门与未命中调度步骤（可选）” and the help paragraph explains that sticky + healthSort is a binding gate (“已有绑定先命中”) while the remaining sorted steps only order the current active set; it must not claim that 越靠前优先级越高 or read the gate’s position as a linear priority. A persistent read-only runtime line (default `#cachePoolRuntime`, `aria-live="polite"`) reports `当前目标 <targetSize>（最小 <minSize> / 上限 <maxSize> / 低额度槽 <lowSize>）`, `实际高 <high> / 低 <low> / 未知 <unknown>` and `会话绑定 <已启用|未启用>，当前 <size> / <maxEntries> 条`, written only with `textContent` from `ACCS.cachePool`; it is display-only state and never enters `collectAccounts()`. The raw scheduling modal’s help text distinguishes low=0 `priority/稳定 ID` membership from positive-low role-aware quota membership and mentions `grow-one` and the `sticky+healthSort` binding gate. The separate `#pipelineOrderHelp` states that the saved sticky position is compatibility-only. New number controls carry native `min`/`max`/`step` attributes: `cachePoolSize`/`cachePoolMaxSize`/`cachePoolLowQuotaSize` 0-100000 (`low <= min <= max`), `sessionBindingExplicitTtlMs`/`sessionBindingFallbackTtlMs` 60000-604800000, `sessionBindingMaxEntries` 1-100000; each is associated with a `<label for=...>` and the shared `cachePoolHelp` description.

#### Provider setup preview

Each model row exposes one native “one-click setup” button. It uses the current route-scope account, runs probe then validation, and opens a labelled modal with an announced status and a native strategy select for cache-first strict, availability-first preferred, or automatic sticky. Proposal text is assigned with `textContent`. Cancel is a no-op; testing sends a temporary route only; confirmation is the sole persistence edge and delegates to `saveModelCfg()`. A changed route scope invalidates the preview. Account auth/proxy/quota faults remain visibly distinct from provider verdicts and are never auto-excluded as global provider failures.

The model route controls also expose bounded `providerCooldownMs` 0-300000. Zero is the explicit off/compatibility value. The complete route save must retain this field together with upstreams/exclude/pinMode/sort/maxRetries.

#### Provider routing status

The model table preserves discovered/operator Provider order. It displays direct Provider-model success rate/sample/coverage and separate cooling/hard-quarantine state, with a native exact recovery button for actionable state. These labels and the static configuration list never sort or reorder to claim the runtime selection; ordering belongs to the Switcher (strict health retry or preferred health selection) and is only projected as bounded strategy evidence. All Provider text remains escaped before HTML insertion.

#### Model aliases

The alias editor uses one `alias = cline-pass/target` pair per line. Batch generation removes `cline-pass/` and applies the optional common prefix/suffix. Duplicate/malformed rows are rejected in the browser for feedback, and the complete object is still validated by the server.

After successful save, reload the server snapshot. Do not optimistically claim aliases that the server rejected.

#### Top-level sections, statistics, and logs

The top navigation exposes five mutually exclusive sections: console, statistics, request logs, error logs, and detailed logs. The active native button uses `aria-pressed="true"`; the other buttons are false. Selecting statistics or a log section hides the complete console panel. Do not implement navigation with anchors, `scrollIntoView()`, or duplicate section DOM.

The statistics panel owns an `aria-live` status, horizontally wrapped table, independent query/visit generations, one refresh controller/promise and one five-minute timer. Entry performs a prompt projection read, one cache-aware quota sweep and a follow-up read; the manual native button forces only the success-cache decision and coalesces while busy. Section changes and `pagehide` abort page ownership, while guarded `pageshow` restores one visible visit without duplicating an active timer. Stale success/catch/finally paths cannot update another visit.

Each quota window labels the remaining percentage, its community-reference dollar equivalent (a snapshot value whose aggregate eligibility depends on freshness), and an available reset time; the redundant used percentage is not rendered. `waiting-refresh` and `quota-exhausted` are separate from manual disablement/rule quarantine; only an effective positive-low pool may label them `暂停路由`. Low=0 or dormant pool must not misreport paused routing from a retained state. Known 0%/100% remain numeric; unconfigured, disabled, unknown, partial, failed and stale/last-known states remain explicit without color alone. The status shows last success/attempt and queued/fetching/due state separately from routing `fresh/unknown`. Viewing or refreshing never enables quota routing, mutates account/raw/bulk drafts, or imports unsaved accounts. Missing/overflowed statistics and zero coverage still render as no data. Account/provider text is escaped, and Keys, proxy/Header/note values, raw traces/messages/sessions, owner state and raw quota responses never render.

The subscription-model table is horizontally wrapped and joins the accepted statistics snapshot by resolved model ID. Each row displays only the rolling 24-hour cache Token ratio, explicit paired-usage request count and cached/input Token counts; request hit rate stays in the statistics panel and is not duplicated in the model table. A known zero ratio renders `0.0%`, no paired samples render “no data,” a zero denominator remains non-computable, and migration/cell-loss coverage is visibly labelled incomplete. Provider count displays “not probed” or “not discovered” instead of a false numeric zero; an observed provider is not marked validated until `upstreamStatus` says so.

The quota forecast appears between the statistics summary and account table as four responsive cards: current, +2h, +8h and +24h. Each displays both monthly remaining and immediately usable **community-reference dollar equivalents**, not official/actual bills or balances. The assumed whole pool has one Cline Pass plan (operator-confirmed), and the screenshot-derived reference caps are $10 for 5h, $25 for weekly, $50 for monthly. Each window's remaining equivalent is `cap * (100 - percentUsed)/100`; monthly totals need only fresh valid monthly data while immediate totals need fresh valid data for all three and sum per-account minimum dollar equivalents. A monthly-only partial may be routing-unknown and still contribute to the monthly estimate without making routing fresh. Enabled/snapshot/attempt-success/error/15-minute checks are independent of `quota.status`; a disabled, unconfigured, stale, failed or invalid row is excluded. Separate included/excluded/unknown counts and generated/acquisition times accompany the cards; known zero remains numeric. Future cards assume no new consumption and restore **the matching cap** only when its validated reset is strictly after `generatedAt` and no later than that target. Missing/invalid/past resets carry current remaining amounts and show separate per-horizon incomplete-reset counts and lower-bound labels; unusable `generatedAt` excludes rows. The same-plan assumption and source, formula, non-billing caveat, future mixed-plan reassessment and refresh cadence are visible as text, not color-only. Values are written with `textContent`; no server-controlled account text enters the forecast markup.

Request and error sections share one bounded filter, table, cursor, and clear implementation. The request view is labelled “最终请求结果（每个请求一条）”; the error view is labelled “上游失败尝试（同一请求可能多条）” and explicitly warns that attempt count is not failed-request count. `switchSection()` selects the type, updates the visible title/status/description, invalidates pending log reads, and starts a first-page load. `loadLogs()` ignores a response whose query generation or selected type is stale. “Next” sends only the server-provided cursor. Changing a filter or type resets the cursor. Clear captures the selected type before awaiting deletion, requires explicit confirmation naming that type, and reloads only if the same log section is still visible.

Request status renders `status / result` and offers the request-only `result` filter. The request table directly labels the bounded affinity key kind/confidence, caller/derived upstream key source, whether a usable field was sent, provider-order override, and cache hit/miss/unknown. Provider circuit actions remain bounded attempt enums in details. Never render the actual caller/derived key or any fingerprint. Historical rows without `result` display `success` for 2xx/3xx or `legacy_failed` otherwise; this fallback does not rewrite or claim to correct historical JSONL. Error status continues to render attempt status/upstream status.

Ordinary request/error views render only projected log fields. Never render raw request/response bodies, Header values, proxy URLs, account notes, or credential-like data in those views. The independently opt-in detailed panel below is the only approved sanitized-body/header display exception.

#### Detailed log panel

`detailsPanel` has its own labelled fifth navigation button and never reuses ordinary `logPanel` state. Show persistent default-off/content/privacy warnings, explain error-only versus full capture and full-mode precedence, retain the 5 MiB per-body and seven-day/1 GiB limits, and show that independent administrator authentication is always required even when the client proxy key is empty. Both checkboxes are disabled until settings load and while either independent settings POST is pending. Failure restores both last confirmed modes without touching account drafts.

The list shows metadata only, including profile, HTTP/outcome/result and capture state. `selectDetail(requestId)` loads headers, attempt metadata and body descriptors into `textContent`; `loadDetailBody()` loads one sanitized `text/plain` body into a labelled readonly textarea. Body buttons identify client/attempt request/response, completeness and captured/observed byte counts. Do not automatically load every body on a page. Use escaping/`jsArg()` for button/table HTML and text nodes or textarea `.value` for arbitrary captured content.

An error-row “view error detail” button exists only with validated capture intent. It switches sections, retrieves the group on demand, and requires exact `attemptIndex + detailCallId` agreement before showing that attempt or body. No intent says it was not enabled then; `no-response` and `stream-transport-failed` remain distinct; a 404 says only that the group may be expired, cleared, capacity-dropped or publication-failed. Never guess from array order or global health.

`#detailsDropReasons[aria-live="polite"]` presents the process-since-start count of diagnostic omissions/rejections, not failed model requests or necessarily missing detail roots. `renderDetailHealth()` uses fixed Chinese `DETAIL_DROP_LABELS`, nonnegative safe integer counts and `textContent` to show only nonzero buckets such as capture memory, redaction secret/work/output and store queue/capacity; it ignores unexpected server keys and shows “原因暂不可用” for missing/invalid/inconsistent breakdowns (unknown total stays “未知”). This read-only aggregate comes from the authenticated detail settings/list health, never from a selected root, manifest, ordinary log or account draft. See `../backend/logging-guidelines.md` for the complete fixed enum; do not introduce arbitrary reason text or per-request attribution.

Copy uses only `DETAIL_BODY_TEXT` obtained from the authenticated body API, is disabled until loading completes, announces failure and focuses/selects the readonly text as fallback. Clear explicitly names detailed logs and preserves ordinary logs. Filter edits invalidate stale results/cursors and ask for refresh; Next stays disabled during pending/invalidated queries. Draft/navigation ownership is in `state-management.md`.

`test/detailed-log-ui.test.js` executes production-script VM coverage for safe text/copy, settings rollback, stale list/selection/body/clear and filter invalidation, and bulk/raw/account draft preservation. It does not prove browser clipboard permissions, keyboard focus, announcements, responsive layout or visual readability; those remain manual acceptance items.

#### Rendering safety

Every server-controlled value inserted via `innerHTML` passes through `escapeHtml()`; JavaScript string arguments use `jsArg()`. Prefer `textContent` for drawer/status text. Authentication failures continue to show the login overlay rather than rendering partial sensitive state.

### 4. Validation & Error Matrix

| UI condition | Required behavior |
|---|---|
| Drawer Header JSON is malformed | keep drawer open, show error, do not mutate account draft |
| Name/note/number/proxy/Header fails server validation | keep/reload prior server state and show safe error |
| Drawer `#drawerRpm` draft is empty, fractional, negative or above 100000 | Clamp silently to a `0..100000` integer in `saveDrawer()`; do not send the out-of-range value to the server |
| Server-provided account `rpm` projection is missing/partial | Render `RPM 不限` or the safe numeric fields only; never render a timestamp array or window internals |
| Drawer is dirty and user presses Escape/backdrop/Close | ask before discarding |
| Proxy test on unsaved account | explain that the account must be saved first |
| Scheduling or error-rule preset is cancelled | no account, rule, pipeline, or global field changes |
| Cache-pool min/max/low is empty, fractional, nonnumeric, or out of range | Block visual save/preset preview without coercing to zero or sending a request; server strict validation remains authoritative |
| `cachePoolMaxSize < cachePoolSize`, `cachePoolLowQuotaSize > cachePoolSize`, or a fallback TTL exceeds the explicit TTL | Block visual save/preset preview and announce the cross-field error; do not send a request |
| Binding TTL is outside 60000-604800000, or entries cap is outside 1-100000 | Block visual save/preset preview without coercion or a request |
| Visual rule edit is invalid or duplicate | Announce the error and keep the unified draft unchanged |
| Advanced rule JSON is invalid or stale | Preserve the text; reject apply without mutating the current draft or sending a request |
| Visual retry-rule edit or advanced retry JSON is invalid or stale | Announce the error and keep `RETRY_RULE_DRAFT` unchanged; reject stale apply without a request |
| A retry needle contains markup/control bytes | Render it escaped (and reject control bytes); never inject it as HTML |
| Paired retry preset is cancelled | change neither `RETRY_RULE_DRAFT` nor `ERROR_RULE_DRAFT` and send no request |
| Paired retry preset is confirmed | validate both drafts, merge stable IDs (custom rules preserved), then submit the ordinary full-account save |
| Rule preset merge/replace/clear is confirmed | Submit the live computed status draft plus unchanged ordered content rules through the normal complete API |
| Scheduling preset is confirmed | submit a complete account snapshot without changing pipeline flags |
| Statistics request resolves after section change | ignore it by generation/visibility check |
| Quota refresh resolves after navigation/pagehide or a newer visit starts | Ignore stale success/catch/finally; do not mutate the hidden/new visit or its button |
| Statistics is restored after pagehide | Start one visible visit only when no timer is active; repeated pageshow does nothing |
| Quota data is disabled, partial, failed, stale or missing a reset | Keep explicit last-known/unknown labels and times; never infer zero/freshness |
| Forecast row is disabled, stale or failed | Exclude and count it in each total; enabled unknown is separately counted, never converted to zero |
| Fresh monthly-only quota has routing status `unknown` | Include it in monthly estimates only; never make routing or immediate three-window estimates fresh |
| Forecast reset or `generatedAt` is unusable | Carry current window equivalent forward and label affected future totals as lower bounds; invalid `generatedAt` excludes all rows rather than claiming current freshness |
| Statistics coverage is zero or a field/ratio is `null` | render no data rather than numeric zero |
| Alias row lacks `=` or duplicates an alias | block save and identify the row/alias |
| Top section changes while a log query is pending | invalidate the old query; it must not update hidden or newly selected log state |
| Log filter changes | reset cursor before querying |
| Clear log selected | confirm with the captured type, delete only that type, and reload only if that same section remains visible |
| API returns `401` | show login overlay and reject the operation |
| Either detailed settings save fails | Restore both confirmed checkboxes; keep account/bulk/raw drafts unchanged |
| Detail body missing/expired or read rejected | Announce safe missing state; no stale body/copy content |
| Details filter changes during a read | Invalidate list/selection; reset cursor and disable Next until refreshed |
| Detail health has zero or nonzero fixed reason buckets | Announce the process-since-start total through the live region; list only nonzero buckets (or “无原因分项” for valid all-zero counts), with fixed labels and `textContent` |
| Old or malformed detail health lacks safe, sum-consistent fixed counts | Show “原因暂不可用” without inferring old counts |
| Detail health has an extra key, including markup-like text | Ignore it; render only known safe buckets through `textContent`, never inject extra keys or values as HTML |
| A detail settings/list read resolves after navigation or a newer read | Keep the last accepted visible aggregate; do not announce stale counts or alter toggles/drafts |
| Clipboard write fails | Announce failure; select loaded sanitized text for manual copy |
| Active provider cooldown | show bounded remaining/expiry state; do not move other providers out of artificial priority order |
| Expired provider cooldown | show half-open eligibility and retain the provider's original position |
| Narrow viewport | maintain usable controls and horizontal table scrolling |

### 5. Good / Base / Bad Cases

- **Good:** open an account by its original table index after filtering, edit proxy/Header values, save the draft and full list, then reload without losing `id` or `perModel`.
- **Good:** preview “保守防封”, inspect the capacity/rule changes, cancel, and observe an unchanged account snapshot.
- **Good:** merge a rule preset into a live custom status, observe the custom status in “preserved,” then cancel without changing the textarea.
- **Good:** preview the “无效 system 消息停止重试” preset, confirm, and observe exactly one retry stop plus one paired provider-model `ignore` saved while custom rules remain.
- **Good:** switch rapidly from statistics to request logs, errors, and console; only the current section remains visible and stale responses cannot replace its state.
- **Good:** keyboard entry/manual refresh announces progress and preserves a pending account note, bulk selection and invalid scheduling-rule draft; a 500px viewport scrolls the wide table without document overflow.
- **Good:** forecast cards wrap with `auto-fit/minmax`, expose a labelled region/live update, show distinct monthly and immediate community-reference dollar estimates, separate coverage and acquisition time, and explain the assumptions in text.
- **Good:** the labelled native `#cachePoolLowQuotaSize` input blocks low > min, the `aria-live` runtime line reports target/low slots and actual high/low/unknown from `ACCS.cachePool`, and account/status labels distinguish waiting refresh from quota exhaustion without echoing raw quotas.
- **Base:** a disabled account shows retained quota/time or unknown and is never queried by page refresh. A retained quota hold when low=0 is not labelled as routing paused.
- **Base:** an old account shows weight 1, priority 100, direct proxy status, and empty note/Header fields.
- **Base:** a new account row shows `maxRpm: 0` and the table renders `RPM 不限` from the server projection.
- **Good:** an account with `rpm: { limit: 10, used: 3, reserved: 1, retryAt: null }` renders `RPM 10 · 窗口内 3+1待发` through `escapeHtml` and never renders `timestamps`/`head`.
- **Base:** no log records renders an empty-state row and disables next page.
- **Bad:** rebuild account objects from visible table cells; hidden routes/proxy/Header fields will be erased.
- **Bad:** put raw server JSON into a log `<pre>`; future fields could expose secrets.
- **Bad:** encode preset logic in the backend and UI independently; values will drift.
- **Bad:** render a retry needle as raw HTML, or project a needle/matched fragment/provider success-rate into ordinary logs, metadata or UI state.
- **Bad:** render RPM window internals (`timestamps`, `head`, reservation lists) or reuse the server-projected `rpm` fields as editable account configuration.
- **Bad:** derive actual role counts from target slots, coerce missing quota to numeric zero, or insert arbitrary server quota/state reason text into `innerHTML` unescaped.
- **Bad:** multiply the minimum remaining percentage by $50, present a community-derived estimate as actual dollars/billing, or make a future card look exact when reset timestamps are incomplete.

### 6. Tests Required

`test/ui-contract.test.js` provides static executable checks for:

- 1800px responsive container, table wrappers, and account-name width;
- seven bounded scheduling presets plus five unified-draft error-rule presets and one manual paired retry-stop preset, native status/content rows, ordered keyboard buttons, generation-checked advanced JSON, retry-editor `aria-live`/escaping, cache-pool input/role/help contracts, merge/replace/clear diffs, cancel behavior, and forbidden-field absence;
- account-scoped one-click provider setup modal/strategy/proposal/test/confirm/cancel boundaries, stale scope rejection, and bounded provider cooldown input;
- labelled modal/drawer semantics, Escape handling, focus return, dirty confirmation, and `aria-live` feedback;
- account snapshot preservation for hidden fields, canonical `errorRules`, all three pipeline booleans, the three-step order, and every bounded pipeline integer (`cachePoolSize`, `cachePoolMaxSize`, `cachePoolLowQuotaSize`, both TTLs, `sessionBindingMaxEntries`);
- the labelled bounded `#drawerRpm` input (`min=0`/`max=100000`), `maxRpm` in the account snapshot, new-row/`collectAccounts()` default `0`, drawer clamping and the safe `rpm` summary rendered only through `escapeHtml` without any `rpm.timestamps`/`rpm.head` access — `test/ui-contract.test.js` asserts the label/bounds/snapshot/clamp/escape markers and `test/account-draft.test.js` executes the clamping and draft-preservation behavior;
- cache-pool help/runtime text: the gate/miss-pipeline legend and help wording, the `aria-live` runtime line showing target/min/max/low, actual high/low/unknown and binding size/cap, native bounds and labels on all six number inputs, and the absence of the removed “越靠前优先级越高” claim; `test/ui-contract.test.js` checks DOM/marker contracts and `test/account-draft.test.js` (`low quota slots share the live pipeline draft, raw editor and server runtime projection`) executes draft/actual projection behavior;
- five mutually exclusive top sections with one statistics panel, one shared ordinary-log DOM, one independent details panel, explicit active state, and no anchor/scroll shortcut;
- statistics stale-response guards, escaped server text, unknown/known-zero rendering, table wrapping, and forbidden sensitive fields;
- statistics entry/manual/timer coalescing, abort and pageshow restoration ownership; remaining/reset-only quota text plus disabled/partial/error/stale states; draft preservation and routing-independent refresh;
- model-table Token ratio/sample/coverage and provider-discovery states, plus stable-ID account cache/health/failure summaries that never enter save payloads;
- the labelled responsive four-card quota forecast, truthful community-reference dollar units and same-plan assumptions, `textContent` rendering, exact fixed-time monthly/immediate calculations with each window's own cap, independent eligibility/exclusion/unknown counts, reset boundaries, lower-bound fallback, invalid snapshot time, and no-data state;
- log query invalidation, filters/pagination, captured-type clear controls, request-only result filtering, safe historical fallback, bounded affinity/cache/circuit/health labels, explicit final-request versus failed-attempt wording, and model-alias batch controls;
- preferred-mode singleton-attempt wording, stable provider ordering, escaped `degraded`/cooling/half-open health labels, and no health-rank sort;
- the request-level retry editor/preview contract: labelled `#retryRuleBody` rows and `aria-live` feedback, escaped needles, generation-checked advanced JSON, and the `首选固定+健康回退`/`Switcher 健康自动选择` mode labels with the removed `严格钉住`/`优先+回退` wording absent;
- `test/account-draft.test.js` production-VM cases `retry rule visual/advanced drafts are bounded, escaped and preserve a paired preset on cancel` and `raw scheduling editor round-trips retryRules, rejects invalid retry drafts and detects stale retry edits`; `test/integration.test.js` covers the strict retryRules API/omission/restart round trip and retry-stop behavior;
- independent full/error-only detailed settings, precedence/privacy/retention/auth warnings, safe metadata/text and on-demand copy/clear controls; `test/ui-contract.test.js` checks the `#detailsDropReasons` live marker, while `test/detailed-log-ui.test.js` runs the production renderer with nonzero fixed reasons, old missing fields, invalid/unsafe counts, ignored injected keys and a stale read, asserting text-only rendering and account-draft isolation; `test/integration.test.js` covers authenticated settings/list aggregate parity and restart reset. Production VM tests also verify cursor reset, exact double-token matching and honest missing/transport states. None of these tests proves actual screen-reader announcement, focus or responsive readability: check the detailed panel in a real browser at narrow width with keyboard/focus/ARIA before claiming that acceptance.

`test/low-quota-pool.test.js` (`low slot configuration, legacy omission and invalid bounds preserve bytes`, `pre-admission capacity rows do not fabricate zero pool composition`) covers server-authoritative bounds and null-versus-actual composition with local mocks; it does not prove UI interaction. Manual browser review remains required for visual width, narrow-screen scrolling, low input focus/keyboard entry, live announcement, focus order, keyboard-only drawer use, password masking, preview readability, and log/alias interaction. Static string tests must not be reported as visual browser automation.

Run the embedded script syntax check used by the test suite, `npm test`, and `git diff --check` after changing the console.

### 7. Wrong vs Correct

#### Wrong

```js
const accounts = visibleRows.map(readVisibleColumns);
```

#### Correct

```js
const accounts = ACCS.accounts.map((account, index) => ({
  ...account,
  enabled: readEnabled(index)
}));
const accountPipeline = {
  quotaPool: pipelineQuotaPool.checked,
  healthSort: pipelineHealthSort.checked,
  sticky: pipelineSticky.checked,
  order: pipelineOrder(),
  ...pipelineNumberDraft()
};
```

Treat the server snapshot as the complete object owner. A filtered/status table is a projection, not the source of truth. Do not render `Number(value) || 0` for coverage-sensitive statistics; test coverage first and preserve the difference between unknown and known zero. In particular:

```js
// Wrong: guess roles from configured targets or always call a retained hold "paused".
const actualLow = ACCS.accountPipeline.cachePoolLowQuotaSize;
const paused = !!account.state?.quotaDisposition;

// Correct: display accepted runtime composition and gate pause by effective role routing.
const actualLow = ACCS.cachePool?.actual?.low;
const roleAware = (ACCS.accountPipeline?.cachePoolLowQuotaSize ?? 0) > 0 &&
  (ACCS.accountPipeline?.cachePoolSize ?? 0) > 0 &&
  (ACCS.mode === 'sticky' || ACCS.accountPipeline?.sticky === true);
const paused = roleAware && !!account.state?.quotaDisposition;
```

Use `textContent` for the aggregate runtime line and `escapeHtml()` for server-controlled row strings. These VM/static contracts do not substitute for real-browser responsive/ARIA review.
