# Model / Provider statistics — check report (2026-09-24)

## Contract and review findings

- The authenticated statistics API keeps its prior fields and adds v5 model final outcomes, Provider final-success usage, explicit unknown-Provider bucket, versioned reference valuation and independent tracking/loss coverage. Only the final successful request's explicit usage enters one resolved model and at most one Provider bucket. Named attribution requires observed final Provider to match the successful named attempt; failed retries affect health but not usage. Historical v1–v4 usage and final outcomes are not fabricated.
- A frozen project price snapshot collected 2026-09-24 supports Kimi K3/GLM-5.3 single reference prices and DeepSeek V4 Flash/Pro peak/off-peak **ranges**. It identifies the official source, USD, internal version and unknown official effective date. Input/output/cached-read must each be explicitly valid, `cachedRead <= input`; other models, missing fields and incompatible rates are unpriced, not zero. Fixed-point BigInt picodollar sums freeze the request-time version, and overflow/cell eviction mark incomplete coverage.
- Independent checks repaired prototype-named model/Provider keys, valid Provider slugs containing `/` or `.`, model/Provider/valuation coverage wording and pagehide/pageshow state. `referenceValue()` now uses `Object.hasOwn` so an unpriced `toString` model cannot interrupt statistics finalization. Additional persistence/restart tests exercise prototype names and slashed Provider IDs.

## Executed verification

- Focused model/provider integration 3/3, full `test/integration.test.js` 106/106, UI/VM 52/52, and full `npm test` 277/277 in the final independent check. All use temporary `DATA_DIR`/local mock upstreams.
- `node --check server.js`; `lib/*.js` checks; production inline-script `vm.Script` compilation; `git diff --check`: passed.
- Real local Chrome headless at **390 CSS px** loaded the production HTML from a local file with a synthetic `/api/statistics` response. Keyboard Enter on “模型和渠道” activated its native nav button (`aria-pressed=true`), moved focus to `#modelProvidersTitle`, rendered a DeepSeek Flash peak/off-peak range and frozen price version. The page width was 390px; a 1133px table scrolled inside a 340px wrapper by keyboard ArrowRight. Search changed the rows without another API read; keyboard return to “控制台” preserved an unsaved synthetic account note. An empty response rendered a no-data row. This is real-browser layout/focus/keyboard smoke with mock data, **not** authenticated end-to-end, screen-reader verification or production evidence.

No production data/credential, paid upstream or deployment was used. The live service remains at `c35cd74`; this page is only in local committed code after a separate commit, and needs separate authorization to deploy.
