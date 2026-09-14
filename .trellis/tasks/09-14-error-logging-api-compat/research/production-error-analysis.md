# Production error analysis (2026-09-14)

## Scope

Read-only inspection of the production host and the NewAPI channel that targets `http://cline-pass-console:3123`. No remote data or configuration was changed.

## Host and container health

- `cline-pass-console` was healthy, had zero restarts, was not OOM-killed, and emitted only normal startup output.
- Host load was low, roughly 55 GiB memory remained available, and the root filesystem was 29% used.
- The observed errors therefore were not caused by host resource exhaustion or a crash loop.

## Switcher durable logs

The retained JSONL range was 2026-09-13 12:37 UTC through 2026-09-14 06:16 UTC.

- 1,588 request records: 46 status 200, 1,416 status 502, and 126 status 500.
- 939 of the 502 request records were streaming records whose projected provider attempts were all status 200. This is the signature of the downstream-close path setting a request error while leaving the upstream attempt successful.
- Excluding those 939 records leaves 603 actual final failures.
- 801 error records belonged to those 603 failed request IDs because the error stream records each failed provider attempt, not each final request.
- Actual failures were concentrated in the DeepSeek v4 flash aliases: 477 final 502 responses and 126 final 500 responses.
- Attempt reasons included 614 generic/truncated Cline/Vercel stream-initialization failures, 60 explicit `user message must have content` failures, 126 `empty response content` failures, and one aborted transport.

## NewAPI correlation

For the corresponding NewAPI channel during the same 24-hour window:

- 627 channel errors: 477 status 502, 126 status 500, and 24 status 404.
- The 24 status 404 records were `no route: POST /v1/responses`.
- Consume logs recorded 944 streaming `done/ok` outcomes and only 3 `client_gone` outcomes.
- After the new switcher container started, all 28 channel consume records were `done/ok`, while the switcher projected the corresponding close-driven stream records as 502.
- Two NewAPI connection failures occurred at the exact container replacement/start boundary; they were deployment-window failures rather than ongoing runtime failures.

## Root causes

1. The SSE observer does not remember `[DONE]`. If NewAPI closes after consuming `[DONE]` but before the upstream stream object flushes, the downstream close handler passes `client disconnected` to finalization. `record()` then defaults any truthy error to status 502.
2. Request and error views use different counting units but the console does not explain that distinction.
3. `/v1/responses` has no deliberate route and falls through to the generic 404 handler.
4. Empty message content crosses the local trust boundary and is rejected later by the Cline/Vercel path.
5. Historical JSONL is intentionally retained across release deployments, so the visible total is not a post-deployment-only count.

## Local baseline

Before implementation, `node --check server.js`, `git diff --check`, and the full `npm test` suite passed. The suite reported 27/27 passing tests in approximately 9.8 seconds.
