# Model / provider statistics and reference valuation — planning draft

## Data sources and identities

The existing `/api/statistics` has per-resolved-model recent-24h request/explicit usage aggregates; provider-model rolling success samples live in the existing health projection. Extend the *same* statistics finalizer and bounded minute-cell owner for **unambiguously attributed** successful provider usage, without charging failed retries or counting one model request more than once. `auto`/unattributed calls remain unknown, not guessed from a configured preference. Display success sample count and coverage distinct from final model request success; show cache Token ratio and cache-hit request rate with their own known-denominators. Keep missing usage as unknown and explicit zero as zero.

## Official reference prices

Use the ClinePass reference table at https://docs.cline.bot/getting-started/clinepass, identified by date/version/model ID, for per-million input/output/cached-read and, where present, cached-write rates. It is *not* what $9.99/month subscribers are additionally billed. Price lookup must match the actual resolved model, with no arbitrary default for unknown providers/models. Some listed models have peak/off-peak or context-size tiers; if a reliable tier cannot be determined from available facts, report cost unavailable or a clearly labelled bounded range (choose only after reviewing exact source fields). Current normalizeUsage has no cached-write count; never infer it from cached read or total. Calculate from explicit counts and only a contemporaneously identified price version; store safe bounded reference-cost projection in the same statistics owner so historical totals do not silently change when the reference table updates. Do not retain raw messages or credentials.

## UI/API

Add a new read-only top-level section after “详细日志” in the production inline script, reusing `api()` and the section's own generation/controller. Serve bounded model rows with nested provider rows or explicit unknown-provider bucket, 24h window and coverage. Escape every server value; use native table/scrolling/keyboard focus. Money columns must say `参考用量等值（USD），非实际扣费`; missing tariff/usage/tier gives `不可计算` rather than $0. Price source/date shown near data. Account drafts survive navigation.

## Compatibility

Preserve existing `/api/statistics` top-level fields and persisted older statistic versions via explicit migration. First post-upgrade provider history is incomplete and should show coverage; no backfill from ordinary request logs. Model aliases count on resolved model only. No second stats store, billing HTTP fetch, frontend toolchain or dependency.
