# Design: 请求日志上游两列 + 用量 Token + 默认浅色

## Boundaries

| Layer | Owner | Change |
|---|---|---|
| Ordinary request projection | `server.js` `record()` | Add bounded usage token fields; keep existing target/actual |
| Logging contract | `.trellis/spec/backend/logging-guidelines.md` | Document new fields; still no bodies/secrets |
| Log filter index | `lib/jsonl-log-store.js` | Only if filters need new keys (MVP: no new filter keys; tokens display-only) |
| Console | `public/index.html` | Light `:root`; log table columns + render; helpers for pin match & token labels |
| Tests | `test/ui-contract.test.js`, focused integration / jsonl tests | Column counts, projection, light tokens presence |

No new `lib/` module. No theme preference store. No dark toggle.

## Data contracts

### Request row usage (new)

```js
{
  inputTokens: number | null,   // safe non-negative integer or null
  outputTokens: number | null,
  cachedTokens: number | null,  // cache-read tokens when field present; else null
}
```

- Source: same `usage` object already passed into `affinityFacts(usage)` / `finalizeStatistics` on success paths (`normalizeUsage` / stream `observed.usage`).
- Project only when values are `Number.isSafeInteger(n) && n >= 0`; otherwise `null`.
- Do **not** invent zeros for missing fields. Keep existing `cacheHit` tri-state derived by `cacheHitOf(usage)`.
- Failed / cancelled / capacity rows: all three `null` unless a future path has trusted usage (MVP: null).
- Filter index: do not add token filters in MVP; `ORDINARY_LOG_FILTERS` unchanged unless a test forces it.

### Target vs actual (existing)

- Plan: `targetProviders: string[]`
- Actual: `actualProvider: string | null`
- Match UI: `!targets.length || actual === targets[0]` when `actual` present; unknown actual → no match styling (neutral / mismatch per test-bench: treat missing actual as non-match message, use dim「未知」).

### Error rows

- Keep `targetProvider` / `providerPath`.
- UI: show target; for actual, prefer correlating is **not** required in MVP if error row lacks actual — show「未知」 unless we already have a field. Optional: if same request’s request-log row is not joined, do not N+1 fetch. Product AC: 「未知」 is acceptable when data unavailable.

## UI layout

### Log table (requests)

Replace single「供应商路径」with:

1. **计划上游** — `targetProviders.join(' → ')` or「自动」
2. **实际上游** — `actualProvider` or「未知」, class `match`/`mismatch` when comparable
3. **用量** —  
   - line1: `fmt(input) / fmt(output)` or「未报告」  
   - line2: `缓存 {cached}` + optional `(ratio%)` when input+cached known and input>0  

Column count increases (was 10 → **12** if replacing one with two and adding usage: remove 1 add 2 net +2 → 12). Current: Time, ID, Model, Protocol, Account, Strategy, Status, **Path**, Affinity, Detail = 10. New: … Status, **Plan**, **Actual**, **Usage**, Affinity, Detail = **12**. Update all `colspan` and `ui-contract` assertions.

Error mode: Plan/Target column + Actual「未知」or omit usage column content as「—」; keep column count stable across request/error toggles for contract simplicity.

### Theme

Replace `:root` dark palette with light equivalents, e.g.:

- `--bg` page off-white, `--card` white, `--card2` light gray
- `--text` near-black, `--dim` muted gray, `--border` light border
- Retune `--accent` / badge backgrounds so green/orange/red badges remain readable on light cards

Hard-coded dark badge backgrounds (e.g. `.badge.green { background: #1d3a2a }`) must be lightened. Prefer variables where cheap; spot-fix remaining dark hex in `<style>`.

No `prefers-color-scheme` dark override in MVP (unique light).

## Compatibility / rollback

- Old JSONL rows without token fields: UI treats missing as null →「未报告」.
- Rollback binary: new fields ignored by old UI; old UI still has conflated path column — acceptable.
- No DATA_DIR migration; no schema version bump beyond logging guidelines text.

## Trade-offs

| Choice | Why |
|---|---|
| Tokens on request row, not only statistics | Per-request ops need row-level evidence |
| No TTFT/t/s | Avoid new timing instrumentation |
| Unique light theme | Matches「默认浅色」without toggle surface area |
| No error↔request join for actual | Avoids log API coupling;「未知」ok |

## Risks

- Light theme miss on hardcoded colors → visual QA via `ui-contract` string checks for new CSS vars + manual glance.
- 12-column table width → keep `min-width` / horizontal scroll (existing `.table-wrap`).
