# Expand ClinePass reference pricing coverage

## Goal

Use the user-provided ClinePass tariff table to show per-model reference rates and calculate more **reliably supported** request-time usage equivalents, not actual subscription charges.

## Source and constraints

The screenshot matches `.trellis/tasks/archive/2026-09/09-24-model-provider-statistics/research/official-pricing-and-usage.md` (USD / 1M tokens; official effective date unknown). `server.js:872-910` prices only four models; `normalizeUsage()` has input/output/total/cached-read but no cached-write/context-band evidence. Existing versioned valuation cells freeze past amounts. The ClinePass subscription does not bill users individually at these listed rates.

## Requirements

- Verify official source before implementation and freeze a new project snapshot/version/collection date. Show all screenshot model rates where mapped to exact official model IDs, including Cached Write prices as **tariff facts**; do not assign `glm-5.3` rates to `glm-5.3-flash` or other names.
- Extend calculated estimates for additional no-Cached-Write single-tier models with complete explicit input/output/cached-read counts. Preserve peak/off-peak range semantics. For Cached-Write or context-banded models, only calculate a complete amount if required count/tier can be proved from upstream; otherwise show the reference rates with `不可计算` explanation. Missing cached-read is unknown, not zero. Do not silently estimate previously unpriced history.
- Continue labelling values `参考用量等值（USD），非实际扣费`; keep old price version, request-time frozen sums, overflow/coverage and effective-date uncertainty.

## Acceptance criteria

- [ ] New price snapshot values/model IDs equal verified official table; old request valuations retain their old version and amount after restart; missing/unpriced models have no invented amount.
- [ ] Explicit zero vs missing usage, cached-read > input, peak/off-peak range, Cached Write model, context tier uncertainty and unexpected model slug each have focused tests.
- [ ] Statistics API/UI can display supported rates, price version/source/collection date, incomplete coverage and non-billing caveat; tests never contact paid upstream or use production data.

## Out of scope

Actual invoice calculation, backdating newly priced models, guessing cached-write from cached-read or guessing context tier from total Token count.
