# New API Chat Keep-Alive — Verification Record

## Result

Implementation and independent check accepted. Scope is the existing New API → Switcher → Cline **HTTP/1.1 Chat Completions** path; no New API source, production service, operator data, HTTP/2/h2c, WebSocket Realtime, or Responses API was changed.

## Observable contract evidence

| AC | Verification |
|---|---|
| 1 Inbound keep-alive across the old 5s window | Local HTTP/1.1 client reuses the same connection across that interval. |
| 2 Outbound reuse and proxy boundary | Local direct HTTP/HTTPS and HTTP/HTTPS CONNECT, SOCKS5/SOCKS5H socket/tunnel counters; draft proxy agent destroyed after use; bad proxy never falls back direct. |
| 3 Post-first-data SSE heartbeat and New API equivalent scanner | Standard `: PING\n\n` observed in a silent interval; scanner resets idle but does not emit model chunks. Test corrected to distinguish upstream prelude comments from Switcher heartbeat. |
| 4 Independent deadlines | First-data wall deadline, post-start upstream socket idle, and heartbeat tested independently; mutating disabled heartbeat or shortened stream idle fails the focused tests. |
| 5 SSE prelude / errors / bounds | Comment/empty/event/id prelude retained, first data error classified before exposure, same-chunk later bytes retained in order, 64KiB comment-only overflow rejected even if upstream never finishes. Reviewer fixed rejection path to destroy the upstream response instead of reading an unbounded tail. |
| 6 Backpressure/lifecycle | A real `write(false)→drain` completes without invented 499; DONE, error, cancellation and SIGTERM finalize once. Reviewer removed stale `drain` listeners on finalization. |
| 7 Node>=18 and full gate | Node 26 integration 101/101 and full 241/241; server/lib syntax, production inline `vm.Script`, `git diff --check` pass. Official Node 18.20.8 `darwin-arm64` archive downloaded into `/tmp/cps-node18-check`; its SHA256 matched the official SHASUMS256.txt. Under Node 18: server/lib syntax, inline `vm.Script`, **full `node --test`: 241/241 pass, 0 fail**. |

## Residual limits

- Real New API, Cline, Docker container and production deployment were not exercised; all transport tests use local mock endpoints and temporary DATA_DIR.
- New API's ordinary Chat request before upstream response headers does not inherit its original client request context (documented upstream fact). Switcher cannot immediately observe that end-client cancellation; the first-event deadline bounds the residual work.
- Runtime knobs are environment-only, not operator `config.json` fields. This task updates README and five English backend specs; no browser-console code was changed.
