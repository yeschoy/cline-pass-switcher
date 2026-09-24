# Monthly quota statistics — planning draft

## Source and calculation

The existing validated `accountQuotas.snapshot.limits` contains `five_hour`, `weekly`, `monthly` percentUsed and optional resetsAt; no authoritative dollar balance exists. The user's screenshot supplies *community reference caps* $10/$25/$50 per account, not Cline's guarantee. For a fresh complete eligible account, calculate each reference remaining `cap × (100 - percentUsed)/100`; monthly total is the sum of monthly remains, while currently usable reference total sums `min(5h_remaining, weekly_remaining, monthly_remaining)` per account. Never take min(percent) and multiply by $50. Display original percents, reset times, captured/fetched time, coverage and separately labelled estimates.

Keep known 0 and 100 distinct from missing; stale/partial/error/disabled rows remain diagnostically visible but cannot silently enter a fresh monetary sum or routing. Existing quota job, refresh controller/generation, account list and statistics endpoint own data. Do not add another remote quota endpoint or infer token balances. If account plan/price applicability cannot be established, show that the $ amounts are a community estimate under the same-plan assumption; do not label as actual balance.

## Compatibility

Retain existing three-window quota columns and quota-pool routing semantics; changing aggregate display alone must not make a stale snapshot fresh. Operator wording must distinguish monthly remaining from immediate 3-window bottleneck. Sum only eligible known accounts, show excluded/unknown count and bounded future projection based solely on validated reset times; future values are predictions, not guaranteed usable balance.
