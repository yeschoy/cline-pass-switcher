# Research: config / admin API / UI / tests for a dynamic proxy pool

- **Query**: Config load/normalize/save + hot reload; admin API proxy exposure + spec rules; admin UI drawer/list patterns; test harness and fake proxies; size concerns. Planning a top-level proxy pool that accounts reference.
- **Scope**: internal (read-only)
- **Date**: 2026-10-20
- Line numbers refer to `server.js` (6885 lines) / `public/index.html` (2265 lines) at HEAD `b336318` plus uncommitted working tree.

---

## 1. Config load / normalize / save / reload

### Files

| Path | Role |
|---|---|
| `server.js:29-34` | `CONFIG_PATH = DATA_DIR/config.json`, `META_PATH`, `SELECTION_COUNTERS_PATH`, `ADMIN_PATH` |
| `server.js:58-115` | `DEFAULT_CONFIG` (no proxy-pool field today) |
| `server.js:117-136` | `loadJson()` (ENOENT -> fallback, parse error -> throw `cannot read config.json`) and `atomicWriteJson()` (tmp file `file.pid.ts.tmp`, keeps existing mode else 0600, `renameSync`, pretty 2-space by default) |
| `server.js:154-157` | `loadedConfig = loadJson(CONFIG_PATH, {})`; `config = { ...DEFAULT_CONFIG, ...loadedConfig }` |
| `server.js:216` | `saveConfig()` = `atomicWriteJson(CONFIG_PATH, config)` + `markProbeConfigWrite()` |
| `server.js:661-671` | `normalizeProxyUrl(value, {strict})` |
| `server.js:814-833` | `normalizeAccount()` |
| `server.js:1434-1525` | `normalizeConfigAndMeta({persist})`, called once at `:1526` with `persist:true` |
| `server.js:2387-2405` | `ACCOUNT_CONFIGURATION_FIELDS`, `configurationRevision()`, `checkConfigurationRevision()` |
| `server.js:2850-2871` | `accountInputError()` strict per-account validation |
| `server.js:2872-2886` | `normalizeAccountList()` |
| `server.js:2888-2937` | `applyAccountConfig(next)` — diff-driven runtime invalidation |
| `server.js:2938-2997` | `RESTART_ONLY_CONFIG_FIELDS`, `ENV_PINNED_CONFIG_FIELDS`, `reloadConfigFromDisk()` |
| `server.js:2998-3003` | `reloadConfigOnSignal()`; `server.js:6872` `process.on('SIGHUP', ...)` |
| `server.js:6753-6765` | `GET /api/config` (port/perModel/knownModels only) and `POST /api/config/reload` |

### normalizeProxyUrl (`server.js:661-671`)

```js
if (raw.length > 2048) throw ...; const u = new URL(raw);
if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) || !u.hostname || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw ...
// port 1..65535; returns u.toString()
} catch { if (strict) throw new Error('proxyUrl must be an http, https, socks5 or socks5h URL without path/query/hash'); console.warn('[配置] 已禁用一个非法账号代理 URL'); return ''; }
```
Non-strict (startup/normalizeAccount) silently converts an invalid URL to `''` (= direct). Strict mode used by `accountInputError` (`:2863`), `/api/accounts/test` (`:6609`), `/api/accounts/proxy-test` (`:6407`). Output is `URL#toString()` so `http://h:1` becomes `http://h:1/`.

### normalizeAccount (`server.js:814-833`)
Builds an explicit object with exactly: `id, name, note, key, enabled, maxConcurrent, maxRpm, clientKeyId, weight, priority, proxyUrl, headers, perModel`. **Any unknown account-level field (e.g. a future `proxyPoolId`) is dropped**. `maxRpm`/`clientKeyId` inherit from `previous` (stable id) when omitted — pattern for an "older client omits field → preserve" rule.

### Unknown top-level fields
- Startup: `{...DEFAULT_CONFIG, ...loadedConfig}` (`:157`) keeps unknown top-level keys in memory; `saveConfig()` writes the whole object, so they survive.
- `POST /api/accounts`: `next = { ...config, accounts, accountMode, ... }` (`:6538-6541`) → all other top-level fields (incl. unknown) preserved.
- `POST /api/security`: `next = { ...config }` (`:6643`) → preserved.
- **Reload** (`:2942-2997`): `pick(field)` only for the hard-coded hot list; `next = { ...config, <hot fields> }` (`:2984-2988`). A field present only in the file (not in live `config`) is ignored; when some other hot field changed, `persisted = {...next}` is written back (`:2991-2994`) → a file-only new field is **overwritten with the live value / removed from the file**. If nothing in the hot list changed, `return { changed }` without writing (`:2990`) and the file keeps it but runtime ignores it. A new `proxyPools` field must be added to the pick list (or to `RESTART_ONLY_CONFIG_FIELDS`) explicitly.
- `RESTART_ONLY_CONFIG_FIELDS` (`:2939`): `port, apiKey, proxyKey, clientKeys, publicBaseUrl, upstreamBase, providerProbeIdentityKey, providerProbeSchedule, detailedLogging, errorDetailLogging, rawBodyLogging, errorDetailMigrationVersion` — any of these differing → whole reload refused.

### Startup normalization (`normalizeConfigAndMeta`, `:1434-1525`)
Pattern per field: `const x = normalizeX(config.x); if (JSON.stringify(x) !== JSON.stringify(config.x)) { config.x = x; dirty = true; }` (e.g. workflow `:1445-1446`, quotaProtection `:1447-1448`, pipeline `:1475-1476`, accounts `:1479-1485`). Canonical-but-malformed fields throw (startup fails, file bytes preserved: e.g. `poolFullWaitMs` `:1466`, `errorRules` strict `:1470`). If dirty → `saveConfig(); saveMeta()` (`:1524`). A new top-level pool would be normalized here (startup) and also inside `reloadConfigFromDisk` + `POST /api/accounts` (strict).

### Save path validation (`POST /api/accounts`, `server.js:6494-6559`)
1. Body must have `accounts` array, valid `mode`, `concurrencyWaitMs` 0..30000, `poolFullWaitMs` (`:6496-6501`).
2. Optional top-level fields: omitted → current server value (`requestedX = config.x`, `:6502`); present → strict normalizer, 400 on error (`:6504-6526`).
3. `accountInputError(body.accounts)` (`:6531`): per account checks id (must exist unless reload), name, note, key, maxConcurrent, maxRpm (strict integer), weight/priority, `normalizeProxyUrl(a.proxyUrl,{strict:true})` + headers (`:2863`), clientKeyId, perModel. Does **not** reject unknown account fields (they're dropped by `normalizeAccount`).
4. `normalizeAccountList()` (`:6534`) → `next` object (`:6538-6541`).
5. `checkConfigurationRevision(body.expectedConfigurationRevision)` (`:6543`), optional; stale + identical draft → 200 `unchanged:true`; stale + different → 409 (`:6547-6553`).
6. `atomicWriteJson(CONFIG_PATH, next)` **before** `applyAccountConfig(next)` (`:6556-6557`) — write-then-publish; a failed rename leaves runtime untouched.

### Config revision mechanism (`server.js:2387-2405`)
```js
const ACCOUNT_CONFIGURATION_FIELDS = Object.freeze([
  'accounts', 'accountMode', 'activeAccount', 'concurrencyWaitMs', 'poolFullWaitMs',
  'sessionProviderAffinityEnabled', 'quotaProtection', 'errorRules', 'retryRules',
  'accountErrorRules', 'accountContentErrorRules', 'accountPipeline', 'accountWorkflow',
]);
function configurationRevision() { ... sha256(JSON.stringify(snapshot)) }
```
`GET /api/accounts` returns `configurationRevision` (`:6487`); reload response returns it (`:6758`); `/api/account-workflow/reset-counts` requires it (`:6466`). The UI sends `expectedConfigurationRevision` only when `WORKFLOW_SUPPORTED` (`public/index.html:1790`). A pool field saved via `/api/accounts` would need to be in this list to be covered by optimistic concurrency and `accountConfigurationEqual()` (`:2399`).

### What reload/save invalidates (`applyAccountConfig`, `server.js:2888-2937`)
- Always: `Object.assign(config,next)`, `probeRevision++`, `abortScheduledProbes()`, `clientCatalogs.clear()`, `workflowHealthCache.clear()`, `normalizeCachePoolTarget` (`:2896-2898`); end: `markProbeConfigWrite({preserveProbeCells:true})`, `saveMeta()`, `RR_COUNTER=0`, `strategyCounters.clear()`, **`pruneProxyAgents()`**, `scheduleQuotaRefresh()`, `notifyCapacityWaiters()` (`:2934-2936`).
- Per account (`:2904-2913`):
  - key/proxyUrl/clientKeyId/enabled/headers changed → delete that account's provider-probe cells.
  - deleted → `invalidateQuotaAccount(clearSnapshot,deleted)`, `clearProviderCircuitForAccount`, `invalidateSessionBindingsForAccount(credentialsChanged)`, `clearRpmState`.
  - **`current.key !== previous.key || current.proxyUrl !== previous.proxyUrl`** → clear quota snapshot, provider circuits, session bindings, `META.accountStates[id]` (keeps only `protectionMonthlyAt`), RPM state (`:2908`).
  - clientKeyId change → bindings; disable → quota/circuit/bindings; perModel diff → per-route circuits/probe cells.
- Proxy identity also appears in: `probeIdentityDigest()` (`:1321-1330`, HMAC over accounts incl. `proxyUrl`; digest change wipes probe cells in `markProbeConfigWrite` `:224-226`), quota job identity (`:4374`, `:4438`, `:4449` compare `job.proxyUrl`), session-provider memory guard (`:1699`), account-still-saved guard (`:5513`).

---

## 2. Admin API exposure of proxyUrl

### Auth boundary
`dispatch()` `server.js:6228`: `managementRoute = p.startsWith('/api/') && p !== '/api/meta' && !modelRoute`; management responses `Cache-Control: no-store`, no CORS (`:6231`, `:6160`). Spec: every `/api/*` except `/api/meta` + auth exchange requires the independent admin Cookie session + CSRF (`.trellis/spec/backend/quality-guidelines.md:119`; matrix in `test/admin-auth.test.js:39`).

### GET /api/accounts (`server.js:6475-6493`)
```js
accounts: config.accounts.map((a) => { ... return { ...a, state: ..., activeCount, rpm, health, selectionCount, ..., quota, statistics } })
```
`...a` → **full plaintext `key`, `proxyUrl` (incl. user:password), `headers`, `note`** returned to the authenticated admin. No server-side masking. Test `test/integration.test.js:1209` asserts round-trip of `proxyUrl`; `:1232-1235` re-posts the GET payload with `http://user:password@...` proxy.

Other proxy-bearing endpoints:
- `POST /api/accounts/proxy-test` (`:6402-6425`): `{accountId, proxyUrl?}`; requires a **saved** accountId; leases the account + RPM permit, real `chat/completions` with `ephemeralProxy:true`; response `{ok, proxyType, ms, status}` or `{ok:false, proxyType, ms, errorCategory:'proxy', reason}` where reason redacts the URL/user/password (`:6421-6423`).
- `POST /api/accounts/test` (`:6603-6625`): optional `proxyUrl` override, `errorCategory: proxyUrl ? 'proxy' : 'network'`.
- `GET /api/statistics` → `proxyHealth: proxyHealthProjection()` (`:6455`, impl `:3850-3881`): credential-free ids from `proxyEndpointKey()` (`:976-984`, `scheme://host[:port]`), plus `accounts:[{id,name}]` per endpoint.
- `GET /api/config` returns only `port, perModel, knownModels` (`:6753`); there is no generic "dump config" endpoint.
- Legacy precedent of admin-plaintext secret: `GET/POST /api/security` returns `proxyKey` plaintext (`:6638-6660`; spec `admin-auth-guidelines.md:30` calls it an intentional compatibility exception). Additional client keys are **list = id/name only**, secret revealed once (`client-key-guidelines.md:48`, README:128).

### "Public" vs admin fields
- Public (`/api/meta`, unauthenticated): `{authRequired, proxyBase, configured}` only (`:6238-6240`).
- Ordinary projections (logs/statistics/metadata): only credential-free `proxyEndpointKey`, `proxyError` boolean, `errorCategory:'proxy'` (`:3963`, `:3981`, `:6052`, `:6142`).
- Admin account administration: full account object.

### Redaction helpers that enumerate proxies
- `redactSecrets()` `server.js:5201-5210`: seeds = apiKey, client keys, active client secrets, `PROXY_KEY`, and **for every account** `key, proxyUrl, header values, decoded URL username/password`; then generic regex `(?:https?|socks5h?):\/\/[^\s]+` → `[REDACTED_PROXY]`. Used by `safeReason()` (`:1711`), `errText`.
- `boundedProviderNote()` `:268-277` (same seeds, 160 chars).
- `ordinaryFailureReason()` `:5213-5219` → `new DetailRedactor(seeds)` with `account.proxyUrl`.
- Detailed capture root seeds `:6216` and per attempt `redactor.url(proxyUrl || account?.proxyUrl)` (`lib/detailed-log-capture.js:492`).
- **`DetailRedactor` cap**: `lib/detailed-log-capture.js:61-64` — `if (this.secrets.size >= 256 || this.secretBytes + bytes > 64 * 1024) { this.markLimited('redactionSecretLimit'); return; }`; once limited, `text()` returns `'[OMITTED: redaction resource limit]'` (`:131`, `:192`). Constructor seeds each secret plus `url(secret)` username/password, each with decoded/escaped variants (`:47`, `:56-66`).

### Spec rules (quoted)
- `.trellis/spec/backend/quality-guidelines.md:246`: "Account keys, proxy URLs/authentication, Header values, and notes are intentionally static account configuration in `config.json` and are returned only through authenticated account administration. They must not appear in `metadata.json`, ordinary JSONL logs, traces, error bodies, or diagnostic headers."
- `quality-guidelines.md:251`: "`proxyAgents` caches only URLs referenced by persisted accounts and stops at 128 URLs. Excess/new non-persisted URLs get disposable agents rather than enlarging the cache; saving account changes calls `pruneProxyAgents()` ... `/api/accounts/proxy-test` always passes `ephemeralProxy: true` ..."
- `quality-guidelines.md:252-253`: account proxy applies to "account-bound Cline chat/probe/validation/test and quota-upstream traffic ... Public catalog/document fetching and ordinary management APIs remain direct." / "A configured proxy failure is a proxy/network attempt failure and never retries the same request without an agent."
- `quality-guidelines.md:250`: proxy Agent options "must **omit** Agent `timeout`"; `keepAlive`, 32 max sockets / 2 max free.
- `.trellis/spec/backend/logging-guidelines.md:13`: ordinary logs "must never become a second storage location for credentials, prompts, sessions, proxy URLs, account notes, or upstream response bodies."
- `logging-guidelines.md:114`: "Before persistence, redaction covers configured account keys, proxy/admin keys, proxy URL/user/password components, every configured custom Header value, and request message text."
- `logging-guidelines.md:118`: Never persist "account Key, proxy URL or proxy authentication".
- `logging-guidelines.md:197`: tests assert "account keys, proxy credentials, custom Header values ... do not occur in serialized log API results or files".
- `.trellis/spec/backend/error-handling.md:59,81,88`: proxy failure never falls back direct; never return proxy URLs unredacted.
- `.trellis/spec/backend/database-guidelines.md:245`: `proxyHealth: { [proxyEndpointKey]: ... } // credential-free scheme://host[:port]`; `:306`: quota/state "never stores keys, Headers, proxy values, credential-bearing URLs"; "Credential/proxy changes clear quota but retain local statistics".
- `database-guidelines.md:80`: "At most 128 persisted proxy URLs enter the cache, with disposable agents for draft tests and cache overflow."
- `database-guidelines.md:11`: use this contract "when adding configuration fields ... or any save path for `config.json`"; startup normalization is permissive for absent legacy fields, strict management saves, persisted canonical invalidity fails startup without rewriting bytes (`:375`, `:350-357` table pattern).
- `.trellis/spec/backend/index.md:31`: "Keep credentials, message bodies, raw sessions, proxy details, and internal owner state out of ordinary projections."
- `.trellis/spec/guides/code-reuse-thinking-guide.md:25,48`: reuse `clineRequest()`/`proxyAgentFor()`; no second `fetch()` path for proxy-honoring work.
- `.trellis/spec/guides/cross-layer-thinking-guide.md:23`: "Because the API replaces the account list, hidden `id`, proxy/Header, note, scheduling, and `perModel` fields must survive every projection and round trip."
- `.trellis/spec/backend/directory-structure.md:47,53`: no new service-class wrappers; Node standard APIs only "unless the existing proxy agents are required"; integration fixtures use temp `DATA_DIR` and "local upstream/proxy servers".

---

## 3. Admin UI (`public/index.html`)

### Account list
- Table header `:333` (14 columns incl. `代理`), body `#accBody`; rows rendered by `renderAccounts()` as template strings with `escapeHtml()` (`:1380-1391`).
- Proxy cell `:1387`: `let proxy='直连'; try { if(a.proxyUrl) proxy=new URL(a.proxyUrl).protocol.replace(':','').toUpperCase(); } catch {}` → badge shows only protocol (`HTTP`/`SOCKS5`), never host/credentials.
- Statistics section has a credential-free proxy table `#statisticsProxyBody` (`:210-213`) rendered by `renderStatisticsProxyHealth()` (`:1883`).

### Drawer
- HTML `:500-511`: `<aside id="accountDrawer" class="drawer" role="dialog" aria-modal="true">`; proxy field `:507`: `<label>出站代理 URL（认证值默认掩码）</label><input id="drawerProxy" type="password" placeholder="http:// / https:// / socks5:// / socks5h://"><button class="ghost" onclick="testDraftProxy()">测试代理连通性</button>`; feedback `#drawerError aria-live="polite"` (`:508`).
- `openAccountDrawer()` `:1827` hydrates `drawerProxy` from `a.proxyUrl`; `drawerValue()` `:1826` dirty snapshot includes it; `saveDrawer()` `:1829` writes `proxyUrl:$('#drawerProxy').value.trim()` into the local draft only; `testDraftProxy()` `:1830` posts `/api/accounts/proxy-test {accountId, proxyUrl}` (requires saved id).
- `addAccountRow()` `:1823` new row default `proxyUrl:''`; `testAccount()` `:1825`.
- `collectAccounts()` `:1790` maps each account to the exact field list `{id,name,note,key,enabled,maxConcurrent,maxRpm,weight,priority,proxyUrl,headers,perModel,clientKeyId}` plus top-level `mode, active, poolFullWaitMs, errorRules, retryRules, accountPipeline, quotaProtection, sessionProviderAffinityEnabled, accountWorkflow?, expectedConfigurationRevision?`. A new account field or top-level pool field must be added here or it is lost on full save.
- `saveAccounts()` `:1791-1815` → `api('/api/accounts', payload)` → `loadAll()` (`:764-772`, sets `ACCS`).
- `reloadConfigFile()` `:1817` → `/api/config/reload`.

### Existing bulk-text editor patterns (for 100+ entries)
- Model alias editor `:484`: `<textarea id="aliasEditor" rows="8" placeholder="每行：别名 = cline-pass/实际模型">`, hydrated `:796` (`join('\n')`), parsed by `parseAliases()` `:1843` (split lines, skip blank, throw on invalid/duplicate line), saved via its own endpoint `saveAliases()` `:1845`.
- JSON textarea editors: advanced errorRules `:346`, retryRules `:361`, raw scheduling `<dialog>` `:393-398` (labelled, `spellcheck="false"`, monospace, `white-space:pre-wrap;overflow-wrap:anywhere`, apply-to-draft button, `aria-live` feedback).
- Error/retry rule body-ANY fields use one-needle-per-line textareas (`:1424`, `:1464`).
- Masking precedent: `#secProxyKey` `type=password` + "显示" checkbox (`:404-406`); drawer key `#drawerShowKey` toggle.

### Frontend spec rules
- `.trellis/spec/frontend/index.md`: plain HTML/JS, no framework/bundler/dependency; "Escape server text before `innerHTML`; use `textContent`/textarea values"; "Confirm no account/configuration write occurs before the existing explicit save action."
- `frontend/quality-guidelines.md:84-95`: drawer "masks account Key and proxy URL by default"; keeps proxy feedback in `aria-live`; saves into local snapshot then requires explicit account save. `:97-103` hidden-field list for `collectAccounts()`.
- `frontend/state-management.md:13`: "account-specific `perModel`, notes, proxy, Header, weight, and priority fields must survive edits, filtering, presets, and drawer round trips"; `:322`: "proxy URLs/authentication ... remain owned by the authenticated drawer and must not be copied into ordinary log rows/details"; `:326`: presets may not mutate proxy; `:435`: malformed proxy → server 400; `:481` round-trip test requirement.
- `frontend/directory-structure.md:31,56`: native elements (`<textarea>`, `<details>`, `<dialog>`), `.table-wrap`; "Do not render raw provider/config objects merely because an authenticated API returned them."
- `frontend/quality-guidelines.md:121-125`: raw-JSON dialog contract (showModal, focus, Escape → dirty confirm).
- Tests: `test/ui-contract.test.js` (static DOM markers), `test/account-draft.test.js` (VM-executed production script), checklist `frontend/directory-structure.md:74`.

---

## 4. Tests

### Runner / deps
`package.json`: `"test": "node --test"`, `"engines": {"node": ">=18"}`, deps only `https-proxy-agent@7.0.6`, `socks-proxy-agent@8.0.5`. No test framework deps. 33 `test/*.test.js` files; `test/admin-fixture.js` helper (not a test).

### Server spin-up pattern
- `test/integration.test.js:87-101` `startSwitcher(config, existingDir, extraEnv)`: `mkdtempSync(os.tmpdir()/cps-test-)`, write `config.json`, `prepareAdminFixture(dir)` (writes 0600 `admin-auth.json` with known password, `admin-fixture.js:32-38`), `keepDirectPipelineFixtures`, `spawn(process.execPath, ['server.js'], { env: {...process.env, ...extraEnv, DATA_DIR: dir, BIND_HOST: '127.0.0.1'} })`, wait for stdout `OpenAI 兼容代理地址`, then `connectAdminFixture(port)` (login → cookie + CSRF stored, `admin-fixture.js:39-47`).
- `installFixtureFetch()` (`admin-fixture.js:55-62`) monkeypatches global `fetch` to auto-add admin Cookie/CSRF for `127.0.0.1` `/api/*`. `rawJson(port, path, body)` (`integration.test.js:24-39`) uses `fixtureHeaders`.
- Free port: create `http.createServer()`, `listen(0)`, close (`integration.test.js:1228`, `proxy-health-stats.test.js:13-17`).
- Test env knobs via `NODE_ENV:'test'` + `CLINE_PASS_TEST_*` (e.g. `CLINE_PASS_TEST_QUOTA_SUCCESS_MS`, `CLINE_PASS_TEST_PROXY_HEALTH_CELL_LIMIT` `server.js:1058`).
- `stop(child)` SIGTERM then SIGKILL after 1s (`integration.test.js:103`). SIGHUP reload tested by `f.child.kill('SIGHUP')` (`test/workflow-integration.test.js:349`); file-edit + `/api/config/reload` tests at `workflow-integration.test.js:312-354`.

### Fake upstream
Plain `http.createServer` (or `https.createServer(tlsOptions)` with `test/fixtures/proxy-cert.pem` / `proxy-key.pem`) as `upstreamBase`; GET = quota endpoint, POST = chat (`integration.test.js:1224`, `proxy-health-stats.test.js:74-82`). HTML 429 fake: `res.writeHead(429, {'Content-Type':'text/html'}); res.end('<html><title>429</title>...')` (`workflow-integration.test.js:356-358`).

### Existing fake proxies (no new deps; `node:net` / `node:http`)
- **HTTP CONNECT**: `integration.test.js:1226-1227`, `:1250`, `:4512`; `proxy-inflight-timeout.test.js:146-155`:
  ```js
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => { connects++; const [host, port] = req.url.split(':');
    const target = net.connect(Number(port), host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head); target.pipe(client); client.pipe(target); });
    target.on('error', () => client.destroy()); });
  ```
  `HttpsProxyAgent` always uses CONNECT, even for `http://` upstreams. HTTPS proxy (TLS to the proxy) at `integration.test.js:1242-1260` uses `https.createServer(tlsOptions)` with the same `connect` handler.
- **SOCKS5 (no-auth)**: `proxy-inflight-timeout.test.js:27-71` `startSocksProxy()` and inline copy `integration.test.js:1266`, `:1286-1329`: greeting → reply `[5,0]`; parse CONNECT request (ATYP 1 IPv4 / 3 domain — `socks5h` sends domain, `socks5` sends resolved IPv4), `net.connect(port, host)`, reply `[5,0,0,1,0,0,0,0,0,0]`, then bidirectional `pipe`.
- **Dead proxy**: a freed/closed port (`proxy-health-stats.test.js:75`, `integration.test.js:1233-1234`).
- Existing assertions on traversal: per-proxy counters (`connects++`, `socksConnections++`) and tunnel-reuse checks (`integration.test.js:1231`, `:1259`, `:1270-1271`, `:4506-4540`); credential absence via `JSON.stringify(logs).includes('password') === false` (`:1238`).

### How to extend (descriptive; all with built-ins)
- SOCKS5 with auth: in the greeting reply choose method `0x02` (`[5,2]`), then read RFC 1929 sub-negotiation `[1, ulen, user, plen, pass]`, reply `[1,0]` (ok) or `[1,1]` (fail). Failure replies for CONNECT: `[5, REP!=0, 0, 1, 0,0,0,0, 0,0]` (e.g. `5` connection refused).
- HTTP CONNECT with auth: check `req.headers['proxy-authorization']` (`Basic base64(user:pass)`) in the `connect` handler; reject with `client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')`; simulate failures with `502`.
- Learning which proxy carried a request (keep-alive tunnels mean CONNECT count ≠ request count):
  1. Per-proxy CONNECT/SOCKS counters (existing pattern) — counts tunnels.
  2. Record the outbound socket's `target.localPort` in a per-proxy Set inside the proxy; the fake upstream looks up `req.socket.remotePort` to attribute every HTTP request (works with tunnel reuse and on any OS).
  3. For plain-HTTP upstreams the tunnel is cleartext, so the proxy can count `client`→`target` chunks starting with `POST ` per proxy (less robust).
  4. `net.connect({ host, port, localAddress: '127.0.0.N' })` per proxy + upstream reads `req.socket.remoteAddress` — Linux loopback /8 works by default; macOS needs aliases (spec notes Node 18 darwin runs, `database-guidelines.md:80`).
- The upstream can return HTML 429 only for traffic attributed to a specific proxy (via method 2) to test "HTML 429 → switch exit".

### Related existing proxy tests
- `test/proxy-health-stats.test.js` (142 lines): proxied 5xx increments `proxyHealth` keyed by endpoint id; direct accounts absent.
- `test/proxy-inflight-timeout.test.js` (185 lines): agent `timeout` omission contract (static source regex on `proxyAgentOptions`, `:93-100`), SOCKS+TLS and CONNECT+TLS deadline behavior, nested socket timeout walk.
- `test/integration.test.js` proxy cases: `:1222` HTTP proxy for chat+quota, no direct fallback, redaction; `:1242` HTTPS proxy; `:1262-1272` socks5/socks5h; `:1285-1355`; `:2407` proxy rotation invalidates quota; `:2714`, `:4267` proxy-test; `:4506` persisted tunnels reuse vs draft tunnels destroyed.
- `test/multi-client-keys.test.js` also contains socks/CONNECT references.

---

## 5. Size concerns

- **config.json**: whole object rewritten pretty-printed on each save (`atomicWriteJson`, `:216`, `:6556`). 100+ URLs ≈ tens of KB; request body limit `MAX_REQUEST_BODY_BYTES = 50 MiB` (`:4914`).
- **metadata.json**: `recordChat` calls `saveMeta()` on **every finalized request** (`server.js:3995`), serializing the whole `META` (`pretty:false`, `:217-223`). `statistics.minuteBuckets[].proxyHealth` keyed by `proxyEndpointKey` with global cap `MAX_PROXY_HEALTH_MINUTE_CELLS = 50000` (`:1058`), pruned oldest-first with `droppedProxyHealthMinuteCells` (`:3624-3630`), startup throws if exceeded (`:1185`). Today the key is derived from the **account's configured** `proxyUrl` at record time (`:3711-3713`), not from the proxy actually used by an attempt. With N distinct endpoints active per minute, cells grow N×1440 (100 proxies → up to 144k → hits the cap and drops coverage).
- **Logs**: `requests` 50,000 records / `errors` 10,000 / 100 MiB total (`:233-240`); records carry only `proxyError` boolean and `errorCategory:'proxy'` (`:3963`, `:3981`); `attempts[]` per request has a fixed bounded field list (`:3943-3958`).
- **Per-request iterations over accounts × secrets**:
  - `redactSecrets()` (`:5201-5210`) rebuilds the seed list from all accounts and does `split/join` per seed per call; `boundedProviderNote()` (`:268-277`) same.
  - `ordinaryFailureReason()` (`:5213-5219`) and detailed capture root (`:6216`) build a `DetailRedactor` from all account keys/proxyUrls/header values; **hard cap 256 secret forms / 64 KiB** (`lib/detailed-log-capture.js:61-64`), after which reasons become `[OMITTED: redaction resource limit]`. Production has ~58 accounts (per `docs/upstream-ip-rate-limit-findings.md` §3.1); current seed count vs. cap not measured.
  - `clineRequest()` (`:4228-4231`): `disposableAgent = !!effectiveProxy && (ephemeralProxy || !config.accounts.some((a) => a.proxyUrl === effectiveProxy) || (!proxyAgents.has(effectiveProxy) && proxyAgents.size >= MAX_CACHED_PROXY_AGENTS))` — a URL not referenced by any account's `proxyUrl` is **always disposable** (new agent per request, no keep-alive reuse). `MAX_CACHED_PROXY_AGENTS = 128` (`:4181`); each proxy agent `maxSockets` 32 / `maxFreeSockets` 2 (`:4166-4168`).
  - `pruneProxyAgents()` (`:4191-4194`) retains only `config.accounts[].proxyUrl`.
  - `proxyHealthProjection()` (`:3850-3858`) maps endpoints → accounts via `account.proxyUrl`.
  - `probeIdentityDigest()` (`:1321-1330`) hashes all accounts incl. `proxyUrl`.
- **HTML 429 handling today**: classified `scope=gateway` (`isGatewayThrottle` `:5301-5303`), backoff keyed by **account id** (`gatewayThrottles`, `:5304-5320`, comment: "not per proxyUrl ... whether upstream keys on egress IP remains unverified"), one retry `GATEWAY_THROTTLE_RETRIES = 1` on the same account/exit (`:5299`, `:5619-5634`). `docs/upstream-ip-rate-limit-findings.md` (untracked) records measurements that the throttle is per egress IP (~70 req / 60 s).
- Per-attempt proxy override already exists in the transport signature: `clineRequest(url, { ..., account, proxyUrl, ephemeralProxy })` with `effectiveProxy = proxyUrl || account?.proxyUrl` (`:4198`, `:4228`). Chat call site `:5663`, account fetch `:3017`, quota `:4462`, probe/validation `:5449`, proxy-test `:6418`.

---

## Caveats / Not Found

- No existing top-level pool concept, no proxy-selection strategy, no per-proxy cooldown or per-proxy RPM in code or spec.
- No test currently runs an authenticated SOCKS5 or CONNECT proxy (all fakes are no-auth); credential redaction tests use a dead proxy with `user:password`.
- No existing test attributes individual HTTP requests to a specific proxy (only tunnel counts).
- Production `metadata.json` size and DetailRedactor seed count were not measured (no data dir in repo).

## Implications for proxy pool design (factual consequences of the above)

1. A new top-level field must be explicitly wired in four places or it is silently lost/ignored: `normalizeConfigAndMeta` (startup), `POST /api/accounts` (strict, omitted → preserve), `reloadConfigFromDisk` pick list (else file edits are ignored or overwritten on reload), and `ACCOUNT_CONFIGURATION_FIELDS` (else not covered by `configurationRevision`/409 handling). A new account-level reference field must be added to `normalizeAccount`, `accountInputError`, `collectAccounts()`, drawer hydrate/save/dirty snapshot, and round-trip tests.
2. `applyAccountConfig` invalidation is keyed on `previous.proxyUrl !== current.proxyUrl`; pool membership edits would not trigger quota/session/circuit/RPM invalidation unless the diff is extended (or deliberately not).
3. Proxy agent caching only recognizes `config.accounts[].proxyUrl`; pool URLs would be disposable per request (no tunnel reuse) unless `clineRequest`'s persisted check, `pruneProxyAgents`, and the 128 cap account for pool entries.
4. Every redaction path seeds from `config.accounts[]`; pool URLs/credentials must be added to `redactSecrets`, `boundedProviderNote`, `ordinaryFailureReason`, detailed root seeds and the generic regex already covers `http(s)/socks5(h)://` text. The `DetailRedactor` 256-form / 64 KiB cap can be exceeded by 100+ credentialed URLs, which turns failure reasons into `[OMITTED: redaction resource limit]`.
5. `GET /api/accounts` currently returns plaintext `proxyUrl` to admins (spec-allowed: "returned only through authenticated account administration"); a pool returned the same way is consistent with the account precedent, while the client-key precedent (list id/name only) is the stricter alternative. Ordinary projections must use only `proxyEndpointKey`-style `scheme://host:port`.
6. `proxyHealth` statistics are attributed by the account's static `proxyUrl` and capped at 50,000 minute cells, with `META` rewritten on every request; per-attempt pool attribution changes both the key source and the cell growth rate.
7. HTML-429 backoff is per account id with one same-exit retry; the per-exit behaviour described in the PRD would change the `gatewayThrottles` key and `gatewayStep` retry logic at `:5299-5320`, `:5619-5634`.
8. UI precedent for bulk lists is a one-entry-per-line `<textarea>` with a strict line parser (`aliasEditor`, `parseAliases`), or a labelled JSON textarea inside `<details>`/`<dialog>`; masking precedent is `type=password` + a "显示" checkbox; tests rely on `ui-contract.test.js` markers and VM-executed `account-draft.test.js`.
9. Tests can stand up N fake CONNECT/SOCKS5 proxies with `http`/`net` only, reusing the existing handlers; per-request attribution is achievable by mapping upstream `req.socket.remotePort` to each proxy's outbound `localPort`.
