# Local performance validation

Recorded at 2026-09-21T05:39:24Z on arm64 with Node v26.8.1. These are same-machine diagnostic measurements, not portable CI timing thresholds.

## Error-only successful 50 MiB ingress

A temporary `DATA_DIR`, local mock upstream and spawned switcher were used with `errorDetailLogging: true`. The request body was valid JSON and exactly 50 MiB. The upstream returned HTTP 200. The temporary directory was removed by the benchmark process.

```json
{"ingressBytes":52428800,"status":200,"wallMs":150.02,"clientHeapDeltaMiB":100.84,"retainedPayloadBytes":0,"detailGroups":0}
```

The measured client heap delta belongs to the one-process benchmark client constructing and sending the 50 MiB string; the acceptance signal is that the switcher exposed zero retained capture payload bytes and published no detail group for successful error-only traffic. Focused production-code coverage also asserts that a 50 MiB error-profile request creates no `BodyCapture` reservation.

## Worst-case 5 MiB sanitizer pass

A `BodyCapture` was filled with a valid JSON body just below 5 MiB, then run through the production learn-before-project redactor and materializer. Event-loop delay used `monitorEventLoopDelay({ resolution: 10 })`.

```json
{"inputBytes":5242858,"capturedBytes":5242876,"state":"complete","wallMs":102.24,"eventLoopP99Ms":118.36,"heapDeltaMiB":15.1,"rssDeltaMiB":63.58,"retainedBeforeRelease":10485752}
{"retainedAfterRelease":0}
```

This confirms the sanitizer remains bounded and releases its reservation, but it also confirms that deferred Promise-queue work is still synchronous CPU on the Node event loop. The implementation therefore makes no claim of true non-blocking sanitization.
