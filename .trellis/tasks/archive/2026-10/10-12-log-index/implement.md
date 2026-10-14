# Implementation plan

## Ordered checklist

1. **Filter key contract**
   - `server.js`: extract `REQUEST_LOG_FILTERS` / `ERROR_LOG_FILTERS` constants; use them in the `/api/logs/*` whitelist and pass them as `streams.<prefix>.filters` to `new JsonlLogGroup(...)`.
   - `lib/jsonl-log-store.js`: `FILTER_FIELDS` map + `projectionFor(key, record)`; keep `matches()` unchanged as the semantic source.

2. **SegmentIndex**
   - Builder from parsed entries (recovery / reread) and from `_writeSegments` chunks.
   - Append-row path for active segments; freeze-to-typed-arrays on close.
   - Lazy `order` (newestEntryOrder) + binary search by cursor key.
   - Group-level `requestId -> [{segment,row}]` map maintained on add/delete.

3. **Query rewrite**
   - Per-segment per-key bitmap over dictionary ids; in-memory row scan with periodic yield.
   - Offset reads of hits only (read handle, coalesced ranges), retry-once-from-start on mismatch.
   - Cursor: accept old and new formats; emit format compatible with `server.js` validation.
   - Fallback path for non-indexed keys / degraded index.

4. **Sidecars**
   - Serialize/validate/load; atomic write; delete with segment; orphan + tmp cleanup in recovery; `clear()` deletes them.
   - Write on `_closeSegment` (active), in `_writeSegments`, and post-recovery backfill.

5. **Recovery integration**
   - Use sidecar when valid; otherwise parse segment and build index.
   - Keep `d63c1f4` bounded-memory behavior and all existing retention/dedup semantics.

6. **Fences + health**
   - Indexed-row cap → degraded scan path with a health fact; sidecar size cap.

7. **Tests** (`test/jsonl-log-store.test.js`, new cases)
   - Filter equivalence: randomized corpus × every whitelisted key (exact, substring, case, arrays, booleans, numeric, from/to) → compare against a reference that runs `matches()` over all records in the legacy order.
   - Pagination: walk all pages with/without filters; union equals reference, no dup/miss; old-format cursor still resumes; cursor into a deleted segment restarts.
   - requestId exact lookup reads only the hit segment (counted io).
   - Sparse filter page: `readFile` count 0 and reads limited to hit ranges.
   - Sidecars: created on roll/close/rewrite; restart with all valid sidecars performs no segment `readFile` for closed segments; deleted/truncated/tampered/size-mismatch/foreign-filters sidecar → rebuilt, same results; orphan + tmp cleanup; `clear()` removes sidecars.
   - Maintenance (age, record cap, combined bytes) keeps index consistent (query after maintain equals reference).
   - Degraded index path stays correct.

8. **Benchmark** (temporary script under `.tmp-deploy/`, not committed)
   - 100 MB / ~60k synthetic rows: first page, sparse filter, requestId lookup, page 10, startup with and without sidecars; report time, readFile count, heap peak, resident index size. Compare with `d63c1f4`.

## Validation commands

```bash
node --check lib/jsonl-log-store.js && node --check server.js
node --test test/jsonl-log-store.test.js
npm test
git diff --check
node .tmp-deploy/bench-recovery.mjs ...   # extended benchmark
```

## Risky files / rollback points

- `lib/jsonl-log-store.js` is the only substantial change; keep commits split: (a) filter contract + index + query, (b) sidecars + recovery, so either can be reverted.
- Rollback in production = previous image; sidecar files are ignored by old code.

## Before `task.py start`

- PRD / design / implement reviewed by the user.
- `implement.jsonl` / `check.jsonl` curated.
- Decide with the user whether to restore `.trellis/spec/**` from HEAD (working tree currently holds empty templates), because the check agent and Phase 3.3 need the real logging contract.
