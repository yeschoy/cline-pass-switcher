# Simplify model and Provider statistics page

## Goal

Split the current dense “模型和渠道” view into two sub-tabs with short rows and intelligible terminology, without discarding accuracy/coverage details.

## Existing evidence

`public/index.html:160-168,1356-1405` renders model final-request rows and their Provider-attempt rows in one wide table with long descriptions and per-cell source/version/coverage strings. `/api/statistics` already has separate `model.providerStatistics.finalRequests` and `providers[].health/usage/valuation` projections; model success and Provider attempts have different denominators.

## Requirements

- Keep the top-level “模型和渠道” navigation; add native “模型” and “渠道” child buttons, each with its own table or projection. Default model view. Model rows show `请求成功率` (`xx.x% · N 样本`), channel rows `渠道尝试成功率` (`xx.x% · N 样本`); no sample -> `无数据 · 0 样本`, not 0%.
- Retain useful compact Token/cache/**reference consumption equivalent (USD)** columns with short labels and a scannable no-data state. This amount comes from final successful explicit Token usage × the frozen model reference tariff, **not** from or deducted against the separate account monthly `$50 × remaining-percent` forecast. Move verbose formulas, price versions, source/date, coverage/migration/incomplete explanations to a concise help disclosure and row-level details. Unknown-Provider usage stays marked `未知渠道` and has no invented attempt-success rate. Channel rows retain model ID.
- Search/filter and tab switching do not reload unrelated data unnecessarily, overwrite account drafts or allow an older async fetch to replace newer state; semantic controls, keyboard focus, `aria-live` and narrow-width scrolling remain usable.

## Acceptance criteria

- [x] Same fixture containing a successful model request, failed Provider retry, unknown attribution, known zero and missing usage displays correct but distinct model/Provider rates and usage without duplicated tokens.
- [x] Default table is visibly shorter/less dense; full caveats remain accessible when needed and model source still says non-actual-billing. No result labelled `最终请求` ambiguously in a row.
- [x] Production VM/static tests plus real-browser focus, keyboard, search, tab and narrow-width checks; stale requests and unsaved drafts survive navigation.

## Out of scope

Changing the existing aggregation/health semantics or silently merging all models of one Provider into a single success denominator.
