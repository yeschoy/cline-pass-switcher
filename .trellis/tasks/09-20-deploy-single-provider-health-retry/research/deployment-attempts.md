# Deployment attempts

## Attempt 1 — read-only preflight projection stopped

The first remote Python preflight assumed `metadata.models` was a mapping while one production metadata field resolved to a non-mapping value. It raised `AttributeError` before producing the local evidence file. The command was read-only: no release/upload/verification/backup/candidate path was created, and Compose, data, image, and the running container were not modified or restarted. Retry adds strict type guards to every projected collection.

## Attempt 2 — internal alias probe runtime fallback

The guarded preflight safely captured production state but reported the internal alias as false because it reused the previous release's `docker exec new-api node ...` probe and the current `new-api` image has no `node` executable. DNS resolution inside `new-api` was present. A read-only retry used the container's available `wget`, received `/api/meta` successfully, and found the bounded `configured` field. No production state changed; evidence records the corrected probe tool instead of treating a missing helper as a service failure.

## Attempt 3 — rehearsal comparison used a moving live baseline

The first isolated candidate rehearsal started successfully and reached its loopback APIs, then stopped before any live mutation because the metadata verifier compared the migrated copy with the still-running live metadata path. Production metadata can change while requests/quota/statistics continue, so the verifier correctly observed an out-of-scope difference but could not attribute it. The rehearsal container was removed by its trap. Live Compose/config/image were untouched. `rehearsal2` preserves separate immutable input copies of config, metadata, and ordinary logs and compares the candidate output only against that frozen input.
