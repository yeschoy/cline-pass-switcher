# Design: ordinary log record index + offset reads

## Boundaries

- All changes live in `lib/jsonl-log-store.js` (`JsonlLogGroup`) plus a small config change in `server.js` (stream filter key lists shared between the route whitelist and the store).
- Public surface stays the same: `append / query / clear / maintain / files / close / ready / status / health`, `GET|DELETE /api/logs/{requests,errors}` params, response shape `{ items, nextCursor }`.
- Detailed logs (`lib/detailed-log-store.js`) are untouched.

## Spec conflict to resolve in Phase 3.3

The committed `logging-guidelines.md` says the group "stores segment names, stream, bytes, record count and timestamp bounds, never request bodies or a second corpus-sized record index" and "Rare filters may inspect the complete bounded corpus". This task deliberately replaces that with: a bounded per-record **filter index** (no bodies, only already-logged filter projections) plus on-disk sidecars. The spec must be updated in the same commit batch.

## Data model

### Per-segment index (`SegmentIndex`)

One per catalogued segment, attached as `segment.index`. Columnar, per-segment local dictionary so deleting a segment frees everything it owns.

```text
count            number of records
ts               Float64Array      record ts (NaN when not finite)
offset           Uint32Array       byte offset of the line in the segment
length           Uint32Array       byte length of the line including '\n'
attemptIndex     Int32Array        -1 when absent
requestId        string[]          '' when absent
idHash           string[] | null   sha256 identity only for rows without requestId (dedup)
dict             string[]          local dictionary of projection JSON strings
cols             { [filterKey]: Uint32Array }   dictionary ids, one column per indexed filter key
order            Uint32Array       row ids sorted by newestEntryOrder (lazy for active segment)
```

- Active segment uses growable plain arrays and converts to typed arrays when closed.
- Memory estimate: ~20 Uint32 columns (80 B) + ts/offset/length/attempt (20 B) + requestId string (~60 B) ≈ 160 B/row → 60k rows ≈ 10 MB. Dictionaries are small (low-cardinality projections).

### Filter projection (the equivalence trick)

`matches()` stays the single source of truth for semantics. For every filter key we define the record fields it reads:

```js
const FILTER_FIELDS = {
  model: ['requestedModel', 'resolvedModel'],
  account: ['accountId', 'accountName'],
  provider: ['actualProvider', 'targetProvider', 'targetProviders', 'providerPath'],
  accountAction: ['accountAction', 'accountActions'],
  // any other key k: [k]
};
```

At index time the projection of key `k` is `JSON.stringify(pick(record, FILTER_FIELDS[k]))`, interned in the segment dictionary. At query time, for each segment and each filter key, evaluate `matches(JSON.parse(dict[id]), { [k]: expected })` once per **distinct** dictionary id and cache a boolean bitmap; a row matches when every filter key's bitmap is true for its id. Results are identical to running `matches()` on the full record by construction, because `matches()` for key `k` only reads `FILTER_FIELDS[k]`.

Special columns instead of projections:
- `from` / `to` → `ts` column.
- `requestId` → `requestId` array (substring semantics preserved by an in-memory `includes` scan; exact lookups hit a group-level `Map<requestId, Array<{segment,row}>>` first and fall back to the scan only when no exact hit exists — see R4).
- Filter keys not in the indexed set (should not happen from the API) fall back to reading the candidate lines and calling `matches()` on the parsed record, so unknown keys stay correct.

Indexed key set = union of the two whitelists in `server.js:5590-5591`, passed per stream through the constructor: `streams: { requests: { maxRecords, filters: [...] }, errors: { maxRecords, filters: [...] } }`. `server.js` keeps one constant per stream and uses it for both the route whitelist and the store config.

## Query algorithm

1. `await this.queue` (same as today), capture `catalogGeneration`.
2. Segments ordered by existing `newestSegmentOrder`. Within a segment, rows in `order` (newestEntryOrder). This reproduces today's result order exactly.
3. Cursor resume: decode `{ ts, requestId, attemptIndex, segment, line }` (old format) or the same plus `v: 2, offset`. Find the segment by name; within it binary-search `order` for the first row strictly after the cursor key under `newestEntryOrder` (key = ts, requestId, attemptIndex, file, line/offset). Missing segment → restart from the first page (same as today's `cursorFound=false` retry).
4. Scan rows using the filter bitmaps until `limit + 1` hits (in-memory only; yield to the event loop every ~5k rows).
5. Read only the hits: group by segment, open a read handle (`io.open(name, 'r')`), `read(buf, 0, length, offset)` per row (coalescing adjacent ranges), `JSON.parse`. A parse failure or short read means the file changed underneath → treat like today's `missing` and retry once from the start; if it still fails, return what is valid and count `health.failures`.
6. `nextCursor` keeps today's fields (`ts, requestId, attemptIndex, segment, line`) so `server.js` cursor validation is unchanged; `line` holds the row's line number (kept in index as `offset`-derived row id; we store `line` implicitly as the row id because rows are appended in line order).

Note: `line` in existing cursors is the raw line index in the file (including blank/malformed lines). The index row id differs from that only when a segment contains malformed lines, which recovery rewrites anyway. Old cursors therefore resume by identity `(ts, requestId, attemptIndex)` via binary search, which is exact.

## Write path

`append()` after a successful write: compute projections from the in-memory `value`, push one row into `segment.index` (offset = previous `segment.bytes`, length = line bytes), update the group requestId map, invalidate the segment's lazy `order`. Cost per append: ~20 small `JSON.stringify` + Map lookups.

## Sidecar files

- Name: for segment `requests-<...>.jsonl` the sidecar is `requests-<...>.jsonl.idx` (does not end in `.jsonl`, so neither old nor new `safeFile()` treats it as a segment; leading-dot names stay reserved for temp files).
- Written atomically (`.<name>.idx.tmp` → rename, mode 0600) whenever a segment becomes immutable: `_closeSegment` of an active segment (roll or shutdown), each segment produced by `_writeSegments` (recovery/maintenance rewrites), and after recovery for any catalogued segment that lacked a valid sidecar.
- Format (JSON, versioned):

```json
{ "v": 1, "segment": "requests-....jsonl", "bytes": 5242880, "records": 1226,
  "filters": ["model", "..."], "dict": ["..."],
  "rows": { "ts": [...], "offset": [...], "length": [...], "attemptIndex": [...],
            "requestId": [...], "idHash": [...] | null, "cols": { "model": [...], ... } } }
```

- Valid only if: `v` matches, `segment` equals the file name, `bytes` equals the current `lstat` size, `filters` equals the configured key set for that stream, all arrays have length `records`, offsets/lengths are monotonic and in range, every dict id is in range, and the file is ≤ a cap (e.g. 8 MiB). Anything else → ignore and rebuild from the segment.
- Deleting/replacing a segment deletes its sidecar. `clear()` deletes sidecars too.
- Recovery deletes orphan `*.jsonl.idx` whose segment is gone, and stray `.*.idx.tmp`.
- Sidecars are not counted in `maxTotalBytes` (≈3% of corpus, ~3 MB at the 100 MB cap); document this.

## Recovery

Same structure as `d63c1f4`, with one change per segment file:

1. `lstat`; if a valid sidecar exists → load index from it (no segment read). Recovery entries for retention/dedup come from the index (`ts`, `length` as bytes, identity from `requestId`/`attemptIndex`/`idHash`).
2. Otherwise read+parse the segment (current path), building the `SegmentIndex` from parsed values instead of keeping only recovery entries.
3. Retention/dedup/dirty decisions unchanged. Clean segments keep their index; dirty segments are rewritten via `_writeSegments` (which builds indexes + sidecars for the replacements).
4. After the catalog is published, write missing sidecars for clean, closed segments (inside the mutate queue, failures fail-open).

Live segments created during recovery (appends while initializing) are indexed on append as usual.

## Maintenance

`_deleteSegment` drops index/map entries + sidecar. `_trimSegment` / combined-byte boundary trim keep today's read-parse-rewrite of one boundary segment; replacements get fresh indexes via `_writeSegments`.

## Memory and safety fences

- Index rows count against the existing `maxRecoveryRecords`-style fence: if total indexed rows would exceed a cap (default 120k), new appends still write to disk but the stream degrades to the legacy scan path for queries (flag `indexDegraded`, health fact). This keeps correctness while bounding memory.
- Sidecar parse is bounded by the 8 MiB file cap.

## Compatibility and rollback

- No change to jsonl content. Old image ignores `*.jsonl.idx`; its `clear()` leaves sidecars behind, which the new image removes as orphans (or, if the segment survives, revalidates by size).
- Rollback = deploy previous image; no data migration.

## Trade-offs

- Per-segment dictionaries duplicate a few strings across segments but make deletion trivial and keep the dictionary bounded.
- Projection-JSON dictionary + `matches()` reuse avoids re-implementing filter semantics (the main correctness risk).
- Sidecars are JSON instead of a binary format: simpler, debuggable, and their size is already small.
