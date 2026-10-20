# OVH production release: drain tier + LRU roundrobin + no-plan quarantine

## Running release

- User requested commit/push/deploy. Source: clean `main` `58f323828736d63d107b1b1c03fd60f62e4b34a2` (includes `9678fb0` no-plan quarantine), pushed to `origin/main` via SSH (HTTPS had no credentials; remote config unchanged).
- Release `20261020-58f3238-drain-tier` / image `sha256:ba12ddaa17a317e29420504902347e3ed614ffd11dbff947b7c11bf803858528`.
- Allowlisted archive SHA-256 `03428e294cf8e5aae0f9fa680d04f6159c310b60512c37306d9b52846fac9dbd` (23 members). In-image hashes of `server.js`, `public/index.html`, `lib/account-workflow.js` matched HEAD; readable as UID 1000.
- Previous release `20261019-9113356-gateway-multi-only` / `sha256:4c23e77776345a9d95e94f429260102f8e63a541e72c688729d1417f94590573` retained. Compose change: image tag + build context only; switch via `up -d --no-build --no-deps`.

## Migration

- Additive: candidate startup on a private copy added exactly `accountPipeline.{drainEnabled:false, drainThreshold:95, drainMaxConcurrent:2, warmThreshold:80}`; nothing else changed. Config `fe0d202c…` → predicted `faa9d0890c0469002b198e1e4cd6dd44bc9d1022a645570981d1b667f114aeb7`.
- Previous image readback of the migrated copy restored the **original bytes** (`fe0d202c…`): direct image rollback is safe (drops the four fields, drain off, warm back to 80).
- Statistics v6, counters v1 (56 entries), workflow enabled/healthFilter/minimumHealth 0.2, admin-auth unchanged, raw groups excluded.

## Machine verification (post-switch, read-only)

- Container running/healthy, 0 restarts, no OOM, 1 GiB, read-only root, CapDrop ALL, user 1000:1000.
- Live config hash == predicted; compose == candidate; gateway and admin-auth unchanged.
- Local gateway `/api/meta` 200, direct app 200, console 200, internal alias `cline-pass-switcher:3123` 200, public HTTPS `/api/meta` 200.
- Client-key-less protected routes 401 (negative check only). No startup error markers in logs.
- 账号5 auto hard-quarantined after first quota refresh (`ruleId quota-no-plan`, 404).

## Pending

- `ovh-deploy-postcheck.py` (copied from the 2026-10-18 no-migration release) still had `sha(config) == configBeforeSha256` in its policy gate, which is invalid for an additive migration (line 109 already pins the predicted hash). Editing it was blocked by the session's permission classifier, so `deployment.json` was **not** updated and still names the previous release. Needs operator approval to fix the gate and rerun, which records `awaiting-admin-acceptance`.
- Operator console actions: enable drain (95 / cap 2), set warmThreshold 90, switch selector to "轮询：最久未选优先"; authenticated admin view acceptance.
- No paid model request, no cleanup of releases/images.
