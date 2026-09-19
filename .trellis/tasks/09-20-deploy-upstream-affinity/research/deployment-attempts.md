# Deployment attempts

## Attempt 1 — local shell compatibility stop

The first install command used Bash `readarray`, but the local macOS Bash does not provide it. The command exited before SSH preflight, upload, remote release creation, backup, Compose or container mutation. The already-healthy production service was not stopped or restarted. Retry uses Python-generated shell assignments and the same fixed release/archive/hash inputs.

## Attempt 2 — rehearsal random port discovery stop

The first copied-data rehearsal created an isolated container/network, but this Docker did not expose `docker port` metadata for the empty host-port syntax. The script failed before any live Compose/data/container mutation and its `finally` removed the temporary container/network. The old production container remained healthy with zero restarts/OOM. `rehearsal1` is retained as evidence; retry uses a new `rehearsal2` identity and an explicitly selected free loopback port.

## Attempt 3 — rehearsal startup-marker observation stop

The `rehearsal2` composite readiness gate failed after polling because the helper returned only stdout from `docker logs`; Docker log output may be on stderr. The isolated container/network were removed in `finally`, and production remained healthy with zero restarts/OOM and unchanged Compose/config hashes. The rehearsal copy is retained. Retry uses `rehearsal3`, combines bounded stdout+stderr, and records safe per-gate diagnostics before deciding.

## Attempt 4 — rehearsal host-to-internal-network check stop

`rehearsal3` stayed running and emitted the startup marker, but the host could not reach its published port while the container was attached to an internal Docker network; API status remained unobserved. The temporary container/network were removed and production remained healthy/unchanged. `rehearsal4` keeps the internal network but performs bounded `/api/meta` and authenticated log readiness checks with Node inside the candidate container, so no real upstream network is available and no host-port behavior is assumed.
