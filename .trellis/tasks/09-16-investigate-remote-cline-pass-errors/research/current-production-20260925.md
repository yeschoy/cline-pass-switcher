# 2026-09-25 production error-log follow-up (read-only)

## Scope / freeze

- Canonical SSH target per backend deployment contract; repository-local identity verified regular/mode 0600/gitignored, never opened or copied. Remote commands used BatchMode, strict host-key checking, bounded timeout and `sudo -n` only for fixed private-file hashes and in-host ordinary-log aggregation.
- Main request/error JSONL audit at **2026-09-25T16:46:39.057Z**; an earlier broad audit ran at 16:44:28Z. Traffic could continue between scans, so all request/attempt arithmetic below uses the 16:46 snapshot rather than mixing the two. Container and file-hash preflight at 16:33:33Z; unchanged-state check at 16:47:11Z. Windows are not an atomic cross-file transaction: the script pins each regular segment's initial size, refuses symlinks/nonregular files, caps input at 128 MiB / 120k rows per stream / 10k segments, and never reads newly appended tail bytes after the scan. It returns only fixed model/provider/category labels, numeric status/counts and UTC timestamps. No original JSONL/body/config bytes left the host; no admin POST/DELETE, paid request, container/config/deployment/data write, restart or cleanup.
- Deployment metadata reports release `20260924-173240-32a150e3-diagnostics`, commit `32a150e3044d40375ac515970267c26a78ec4799`, `deployment.json.status=awaiting-admin-acceptance`; the running container's image ID is recorded below. Metadata and container identity were observed, but this audit did not independently hash code inside the running image to prove commit provenance. This is **not** local HEAD; newly completed price/multi-key code is not assumed deployed. Container started **2026-09-24T17:52:10.625Z**. The retained request range begins 2026-09-24T18:13Z after startup; errors begin 2026-09-25T01:31Z. Both streams are capped by the 16:46:39Z audit time for these window counts (the exact last-row timestamps were not transcribed). Both starts are inside 24h of the freeze, so the retained, container and last-24h aggregates coincide in this snapshot only.

## Health and no-change gate

- Switcher `running/healthy`, restart 0, OOM false; image ID `sha256:0bd1deaefb04b6c2c3f1e3417eddc07b3fc6dd6398212ff98e6a783c3c62100c`. Load 0.01/0.09/0.19; ~58,176 MiB host memory available, root filesystem 12% used. Bounded last-24h container log sample: 2 startup lines, zero `fatal`/`uncaught`/`unhandled`/OOM/ENOSPC/EACCES/metadata/persistence markers. This does not prove every dependency healthy, but does not support host exhaustion or crash loop.
- Before/after container ID, image ID, StartedAt, health, restart/OOM and SHA-256 of private `config.json`, `compose.yml`, `deployment.json` all matched. The hashes were compared as opaque digests; no private content or secret was printed. Runtime metadata hash was not used as a no-change claim because ordinary traffic can update it.
- Ordinary log segments: requests **3 files / 6,181 valid lines**, errors **1 file / 268 valid lines**; malformed/truncated counted lines **0**, deduplicated overlap **0**, no unexpected ordinary-log entries. Input bytes at initial scan 12,294,028 (~11.72 MiB). Older history outside this retention window is unavailable from these ordinary files.

## Final request vs failed-attempt accounting

At the refined audit freeze (6,181 final request rows):

| Window / unit | Count |
|---|---:|
| Final success | **5,910** |
| Final failed | **246** (3.98% of 6,181) |
| Client-cancelled | **25** (499, not failures) |
| Failed real upstream attempts | **268** across **155** request IDs |
| Failed upstream attempts belonging to final failed requests | **259** |
| Failed upstream attempts belonging to later successful requests | **9** |
| Final failures classified as local `capacity` | **100** (`capacity-unavailable`; no upstream attempt under the runtime contract) |
| Final failures classified as `upstream` | **146** (not a separately measured count of distinct failed IDs with error rows) |

The **268 error lines are attempts, not 268 failed client requests**. Their excess over 155 unique IDs includes retries; 9 *attempts* belong to eventual successes, but the 16:46 projection did not count distinct successful IDs with error attempts. The 100 `capacity` final 429s are locally rejected before upstream work under the runtime contract; this snapshot did not separately cross-tabulate their IDs against error rows. Similarly, 146 is the `upstream` final-category count, not an independently established join cardinality (155 − 9 would incorrectly subtract attempt count from distinct ID count). No error request ID lacked a retained final request row in this snapshot; the projection found no suspected old-stream 502 signature and no success≥400/failed<400 conflict. Cancellation/status pairs were not separately cross-tabulated in that run.

Final failed statuses: 429×243, 500×2, 502×1. Failed attempts: status 429×254, 500×10, 502×4; upstream status 429×254, 500×10, 200×1, no HTTP response×3. Final failure model labels, all from the fixed allowlist: `deepseek-v4.1-flash`×246. Safe error categories on final failures: `upstream`×146, `capacity`×100. Other/unknown model and Provider values would be grouped rather than printed; no client credentials or arbitrary model text are emitted.

## Dominant 429 cluster and timing

A follow-up fixed-label projection at 16:49:26Z confirmed all **254** real upstream HTTP 429 attempts targeted Provider `deepseek` and model `deepseek-v4.1-flash` in this retained interval. They had:

- `responseContentType` categorized as **text/html** and bounded response size **1–256 bytes** (content was *not* opened or copied);
- classifier `errorScope=unknown`, `scopeEvidence=ambiguous_rate_limit`, `failureClass=rate_limit` on all 254;
- `accountAction=cooldown` and `ruleAction=cooldown` on all 254; the complete set of **268** failed attempts spans **nine** account ordinals (the 16:46 projection did not separately count distinct accounts within the 254 upstream 429s);
- retry decision `continue` on all 254 attempts. Provider-specific versus shared gateway/IP origin is **not established** by an HTML 429. There is no structured per-account quota proof in these rows.

Hourly upstream-429 attempts in the 16:46 snapshot: 09:00 UTC **46**, 10:00 **155**, 11:00 **53**. The **100** local `capacity-unavailable` final 429s appeared at 10:00 **41**, 11:00 **59**; under the runtime contract these are pre-upstream rejections. This sequence plus account-cooldown actions supports a **high-probability** amplification chain (ambiguous gateway 429 → broad account cooldown → owned pool has no eligible capacity → local 429), but ordinary rows alone do not prove every local 429's exact counterfactual cause. Do not relabel these as account quota exhaustion, or automatically disable cooldown rules.

Final failures by hour: 01:00 **1**, 09:00 **23**, 10:00 **133**, 11:00 **87**, 13:00 **2** UTC. Last final failure **13:54:55.815Z**. In the most recent one-hour window at the refined freeze: **338** requests = 337 success + 1 client cancellation + **0 final failures**; one timeout-class attempt was recovered by a later successful request. This demonstrates a quieter sampled interval, not a proven permanent upstream fix.

## Relation to older findings / evidence limits

The 2026-09-21 analysis found an old single-Provider v4 Pro incompatibility and started-stream DeepSeek gateway terminations. Neither is the dominant **retained** 2026-09-25 cluster; current errors are overwhelmingly short HTTP 429 responses plus local capacity outcomes. The non-429 attempt classes (14 total) and the three non-429 final failures were not broken down by hour in this report. The 2026-09-21 NewAPI channel-71 cross-check cannot be carried forward as a current 2026-09-25 fact: this follow-up did not run a new authenticated NewAPI/channel SQL query or verify a fresh channel mapping. Therefore exact upstream owner (DeepSeek gateway, shared egress/IP, intermediary or per-account account policy) remains **unverified**. No detailed body, private config, Header, session, message or raw reason text was inspected; fixed-class `reasonKinds=other` for most HTML 429s is intentionally non-diagnostic. The service's per-account cooldown rule outcome is visible in safe ordinary fields, not proof that the underlying 429 originated with that account.

## Evidence ranking

| Confidence | Finding / evidence limit |
|---|---|
| Confirmed | Switcher image/container healthy and unchanged during the check; 6,181 final requests include 246 failures, distinct from 268 failed upstream attempts. All 254 upstream HTTP 429 attempts are short HTML responses on the DeepSeek path with `ambiguous_rate_limit`; 100 final local capacity 429s have no native upstream attempt under the runtime contract. |
| High probability | The 09:00–11:00 UTC ambiguous 429 burst and 254 recorded account cooldown actions contributed to the 10:00–11:00 local capacity failures. This is a timing/selection inference, not per-request counterfactual proof. |
| Not established | Exact 429 origin (account quota, Provider gateway, egress/IP or intermediary), the current NewAPI channel correlation, and whether the last quiet hour persists for 24 hours. The recorded `awaiting-admin-acceptance` release state is independent of this traffic result. |

## Minimal next steps (recommendations, not changes performed)

1. Preserve this baseline; if the burst recurs, compare aligned final-failure rate, upstream-429 attempt count and its distinct-account spread (not the nine-account count for *all* error attempts), local `capacity-unavailable` count and hourly sequence. A zero-failure hour is not enough to close a 24h health claim.
2. Independently obtain safe read-only gateway/NewAPI status and validated channel mapping or structured rate-limit attribution before deciding whether the 429 belongs to an account, Provider or shared egress. Never expose raw HTML bodies or authorization material.
3. Review the **ambiguous-429 account cooldown** rule against a copied synthetic config and replay tests before any proposed routing/policy change. Changing production rules, account selection, deployment or detailed logging requires separate explicit authorization and a rollback gate.
4. Keep the 2026-09-24 code release's administrator acceptance status separate from this error investigation. No completion, deployment or raw-body enablement is inferred from healthy container state.
