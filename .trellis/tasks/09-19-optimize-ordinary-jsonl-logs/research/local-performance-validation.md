# Local ordinary JSONL performance validation

Date: 2026-09-19

A temporary directory was created and removed in the same command. No production data, credentials or existing operator logs were read.

## Frozen old implementation baseline

- records: 5,000 representative request rows
- append time: 3,607.9 ms
- per record: 721.6 microseconds
- matching first-page query: 8.3 ms

The old implementation also enumerated/stat-ed files on every append and performed a full compact every 100 appends.

## Incremental implementation result

- startup recovery on an empty directory: 1.62 ms
- append time: 70.58 ms
- per record: 14.12 microseconds
- speedup versus frozen baseline: 51.12×
- matching first-page query (50 rows): 18.32 ms
- below-threshold maintenance: 0.06 ms
- measured heap delta: 0.67 MiB
- event-loop delay p99 during the synthetic run: 15.48 ms
- generated segments: 1

The required 10× same-machine improvement gate passed. Focused filesystem-call tests separately prove that, after recovery, append and below-threshold maintenance perform zero `readdir`, historical `readFile`, `stat`, or `lstat` calls; first-page query reads at most the newest required segment.

These local small-corpus numbers do not establish production disk latency, exact RSS or full-100-MiB recovery time. Production deployment/observation is outside this task and requires separate authorization.
