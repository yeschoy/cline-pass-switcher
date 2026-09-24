# Deployment attempts

## Attempt 1 — rehearsal mount syntax stopped before container creation

The first copied-data rehearsal used Docker long-form `--mount` with a bare `rw` field. Docker 29.7.2 rejected it because this form requires key/value fields (or read-write by default). No rehearsal container was created or started, and no live Compose/data/image/container state was changed.

The immediate no-op proof matched the frozen baseline exactly for live Compose SHA-256, live config SHA-256 and the running exact image. `cline-pass-console` remained running/healthy with restart count 0 and OOM false. Both intended rehearsal container names were absent. The immutable release and candidate image were retained. Retry uses a new `rehearsal2` path and omits the invalid `rw` field.

## Attempt 2 — verifier assumed the wrong canonical folded order

`rehearsal2` successfully started the exact candidate under the required hardening and stopped it before external work, but the structural verifier expected the legacy four-step order to become `quotaPool, healthSort, sticky`. The implementation correctly preserves the first occurrence when folding `excludeUnhealthy` into `healthSort`, producing `healthSort, quotaPool, sticky` for the frozen production order.

The failure occurred after the stopped copied-data run and before any live mutation. A second no-op proof again matched the original live Compose/config/exact image; production remained running/healthy with restart count 0 and OOM false. Safe diagnostics confirmed all config fields outside canonical rules/mirrors/pipeline were exact, both legacy mirrors were exact, and five canonical rules were created. Retry uses fresh `rehearsal3` copies and derives expected order with the implementation's documented fold/deduplicate rule.

## Attempt 3 — final dynamic metadata freeze moved before mutation

The first switch command included a deliberately strict zero-gap guard requiring live metadata and ordinary logs to remain byte-identical to `backup-final`. Production metadata changed after the backup while the old healthy service continued normal quota/statistics work. The guard stopped before atomic Compose installation. Compose, deployment, config and ordinary logs still matched the backup; only metadata differed. The old exact image remained running/healthy with restart count 0 and OOM false.

This is expected dynamic-state movement rather than unknown operator drift. A new immutable `backup-final2` and copied-data prediction are required. The retry keeps static Compose/deployment/config and ordinary-log drift as hard pre-mutation guards, but treats metadata as a documented moving runtime file after its latest frozen backup; post-switch validation checks the exact schema and safe facts rather than requiring an impossible continuously stable live metadata hash.
