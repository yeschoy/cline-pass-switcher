# FloppyData rotating proxy API — research (2026-10-20)

Sources: https://floppydata.com/docs/guides/rotating-proxy , https://floppydata.com/docs/api-reference/v2/endpoint/rotating-connection.md , https://floppydata.com/docs/proxies/using-proxies.md , https://floppydata.com/docs/llms.txt .
A few live calls were made with the operator's key (API only, no proxy traffic). No key, password or real username is recorded here; placeholders only.

## API

- Base: `https://api.floppydata.net`; auth header `X-Api-Key: <API_KEY>`.
- `POST /v2/proxy/rotating/connections` (JSON, `additionalProperties: false`):
  - `type` (required): `residential` | `mobile` | `datacenter`
  - `country` (required): 2 letters
  - `state` / `city` (optional; state wins), `asn` (digits, optional)
  - `rotation`: one of `-1` (new IP per request), `0` (sticky), `5`, `10`, `15`, `20`, `60` (minutes). Default 15. **No 3-minute value.**
  - `session`: string 1–128 (optional). **If omitted the server generates a random session id.**
  - `protocol`: `http` | `https` | `socks5` (default `http`); `udp` boolean (socks5 + residential/mobile only); `subuserId` optional.
  - No count/quantity field: one call = one connection string. N distinct sessions need N calls.
- 200 response: `{ connection: { protocol, host, port, username, password, connectionString }, parameters: {...echo} }`. Docs call `connectionString` the canonical URL.
- Errors: 400 invalid_request, 401 unauthorized, 402 insufficient_balance, 403 forbidden, 404 not_found, 409 account_not_configured, 500 internal_error, 502 upstream_error (shared enum also lists settings_limit_reached, connection_in_use, session_not_active).
- No documented rate limit; no rate-limit headers observed.
- `GET /v2/account/balances` returns rotating traffic balance (`proxy.rotating.total.traffic.availableBytes`), expiring/non-expiring split. Traffic is billed per byte through the proxy; connection building itself showed no visible cost.

## Live observations

- Username shape: `user-<ACCOUNT>-type-residential-session-<SESSION>-country-US-rotation-<R>`; password is an account-level 16-char secret identical across connections.
- Same `session` value → identical username (deterministic); different `session` → different username.
- Gateway: `<floppydata-gateway-host>`, port `10800` for socks5, `10080` for http.
- Latency ≈ 0.4 s per call sequentially (5 calls ≈ 2 s). 100 calls with concurrency 8 ≈ 5–6 s.
- The account had ~11.8 GB rotating traffic available at probe time (expiring part on 2026-11-04).

## Implications

- "Import 100 proxies" = 100 `connections` calls with `rotation: 0` and either omitted `session` (server random) or a locally generated random session id per call. Locally generated ids (e.g. `cps<refreshEpoch36><index>`) make entries traceable in provider dashboards; omitted session is simpler. Both are documented behaviour.
- Refresh every N minutes = new batch of sessions → new exit IPs. Alternative zero-API option: fixed sessions with `rotation: 5` lets the provider rotate IPs every 5 min (not chosen as default; user asked for active refresh).
- All Cline upstream traffic through residential proxies consumes paid GB (request bodies with long contexts dominate) and adds latency; document in PRD risks.
- Each refresh issues `count` API calls; at 100 / 3 min that is ~2000 calls/hour with no documented limit — implement bounded concurrency, partial-success acceptance and failure backoff.
