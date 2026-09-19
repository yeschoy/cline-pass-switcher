# 2026-09-19 production version boundary

The original cache-pool validation window is not a continuous 24-hour experiment anymore.

Read-only preflight before the 2026-09-19 deployment showed that production had already moved beyond the task's original size-2 / 5000 ms configuration to:

- release `20260918-070946-2e7dc37-empty-content-r3`;
- source commit `2e7dc37355fe9385a44d7de7c2da5015fd391f82`;
- sticky mode, `cachePoolSize=5`, `concurrencyWaitMs=2000`.

A later deployment switched production at `2026-09-19T11:19:10.299253Z` to:

- release `20260919-110817-b2d676d-stats-logs-rules`;
- source commit `b2d676d11e0d4422aef83854670b6bceb89401a0`;
- exact image `sha256:fb5d9de7dc6643201a333ed47e7064464df3615598cd0fb3c91ad3ffc2f91cf2`.

That deployment preserved the then-current size-5 / 2000 ms cache-pool configuration, but restarted the service and migrated statistics v1 to v2. Therefore the task's original baseline/window must not be used to claim a continuous size-2 24-hour result. Any future cache-pool validation should freeze a new baseline and define a new continuous observation window after the latest stable deployment boundary.

The original task evidence is retained unchanged.
