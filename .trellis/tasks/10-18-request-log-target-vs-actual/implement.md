# Implement: 请求日志上游两列 + 用量 Token + 默认浅色

## Order

1. **Backend projection** — In `record()`, map `info.usage` (or pass usage through `recordChat` / `affinityFacts`) into bounded `inputTokens` / `outputTokens` / `cachedTokens`. Ensure stream + non-stream success paths supply the same usage object already used for statistics. Capacity/fail paths leave nulls.
2. **Logging guidelines** — Update Request projection allowlist in `.trellis/spec/backend/logging-guidelines.md` for the three fields and missing≠0 rule.
3. **Tests (projection)** — Extend integration or focused test: successful mock usage appears on request log row; missing usage → null/`cacheHit` unchanged; old-shape rows still queryable.
4. **Log UI columns** — `public/index.html`: header 12 cols; `loadLogs` render plan/actual/usage; helpers `pinMatchClass`, `usageLogLabel`; error rows target + unknown actual + usage「—」; fix colspan on empty/chain rows.
5. **Light theme** — Replace `:root` and hardcoded badge/input dark colors; keep semantic `match`/`mismatch`.
6. **UI contract** — Update `test/ui-contract.test.js` column count, headers, usage/plan/actual render contracts, light CSS var smoke asserts.
7. **Verify** — commands below; fix regressions.

## Validation

```bash
node --check server.js
node --test test/ui-contract.test.js
node --test test/jsonl-log-store.test.js
# focused integration slices that assert request log rows / cacheHit (extend as needed):
node --test test/integration.test.js
npm test
git diff --check
```

## Risky files / rollback

| File | Risk |
|---|---|
| `server.js` `record()` | Projection allowlist drift; fail-open append must remain |
| `public/index.html` | Large inline script; colspan mismatches break layout |
| `logging-guidelines.md` | Must match code before claim complete |

Rollback: revert commit; no DATA_DIR migration. Old logs remain readable.

## Pre-start checklist

- [x] `prd.md` converged; open decisions empty
- [x] `design.md` / `implement.md` present
- [ ] User approves final planning summary
- [ ] Then `task.py start` (not before)
- [ ] Curate `implement.jsonl` / `check.jsonl` before start (sub-agent dispatch)
