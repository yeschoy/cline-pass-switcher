# Implement: Bridge multi-only + actual provider

## Checklist

1. [x] Spec first: update `quality-guidelines.md` (gateway one-shot multi only+order; direct singleton retained; parseRouting/SSE Bridge parity). Update logging + frontend guidelines for error `actualProvider` and order copy.
2. [x] Shared routing observer helper (extract/replace `parseRouting` + SSE apply) with Bridge field priority, stickiness, error-text regex.
3. [x] Fix SSE path so stream successes can record actual (routing observation not starved by content byte-cap; no bare-provider overwrite of sticky final).
4. [x] `injectPrefs`: planner/gateway multi `only`+`order`; fold top-level `provider`; direct unchanged.
5. [x] `runChatChain` / plan selection: gateway multi-list → single HTTP provider attempt; reorder-only for pinMode/health; account hop unchanged.
6. [x] Error log append: store response-evidenced `actualProvider` when known; UI render.
7. [x] Tests: inject body shape, one-POST integration, stream actual, stickiness, error regex, direct regression, UI contract.
8. [x] Full gate `npm test`; curate jsonl already done before start.

## Order

Specs → observer/parseRouting → SSE → injectPrefs → runChatChain → error log/UI → tests → gate.

## Verify

```bash
node --check server.js
node --test test/gateway-multi-only.test.js test/ui-contract.test.js
npm test
git diff --check
```

## Notes

- Do not invent actual from `targetProviders` / attempt.upstream.
- Do not change direct OpenRouter multi-attempt behavior in this task.
- Bridge clone under `.trellis/tasks/_scratch/ClinePassBridge` is reference-only (not shipped).
- Existing local-walk fixtures keep `pipeline: 'direct'` via `keepDirectPipelineFixtures` unless metadata already names a pipeline. Planner and unknown one-shot coverage is `test/gateway-multi-only.test.js`.
