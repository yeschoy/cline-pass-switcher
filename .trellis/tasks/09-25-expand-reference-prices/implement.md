# Execution plan (after review/start)

- [ ] Confirm with user whether screenshot/prior 13-model historical tariff or today's changed 12-model official table owns this new snapshot; evidence and difference are in `research/price-source-drift-2026-09-25.md`. Then map exact IDs/units/tier/write conditions and version/provenance. **Do not start implementation while this product decision remains open.**
- [ ] Add focused price/usage/precision/version/unknown tests first; check current `validatePriceSnapshot()` and migration under old v5 data.
- [ ] Add safe new tariff projection and extend only provably complete request-time valuations in `server.js`; preserve all old cells and fail-open model traffic if valuation fails.
- [ ] Adjust UI price source/unsupported notes with the UI child or keep backward-compatible projection; update English backend/frontend specs and operator docs as appropriate.
- [ ] Run `node --test test/integration.test.js`, UI contracts if touched, Node syntax/inline VM, full env-scrubbed `npm test`, `git diff --check`; inspect secret and overflow projections; independent review and commit.

Rollback gate: old metadata + new snapshot roundtrip; do not alter old rate units/version or delete old priced cells.
