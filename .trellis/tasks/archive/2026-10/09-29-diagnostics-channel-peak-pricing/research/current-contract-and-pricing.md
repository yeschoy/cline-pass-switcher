# Read-only planning evidence (2026-09-29)

## Error-detail contract and migration

- `server.js:52-61,147-148,1197,4720-4734,4851-4860`: both capture switches default false, `loadedConfig` overrides defaults, strict persist-first detail setting toggles. Current startup has no marker distinguishing an old false default from an intentional opt-out. The user explicitly chose a one-time migration of all old false to true, then preserving any subsequent explicit disable. Full still takes precedence; raw is independently default-off/runtime-gated. Admin not initialized suspends capture.
- `lib/detailed-log-capture.js:439-592` and `server.js:3666-3738,4140-4178,2881-2975`: sanitized error-only captures failed upstream response Headers/body and uses outbound request material only for credential discovery; it does not publish ingress request Header/body or outbound failed-attempt request material. Raw-error is a different explicit profile and its Header map is bounded/allowlisted. Request-local UUID/attempt index plus call ID associates ordinary error rows with on-demand details, but a row is not proof that async publication succeeded.
- `.trellis/spec/backend/logging-guidelines.md` forbids body/Header values in ordinary JSONL and metadata, specifies detailed store bounds, auth, sanitation, health drops and fail-open behavior. These instructions describe the **existing** contract and must be updated after a tested change.

## Provider attribution

- `server.js:2297-2310` parses planner routing metadata `finalProvider` or direct top-level `provider`; SSE observer feeds this parser (`server.js:3597-3626`). `server.js:2724-2731` attributes final usage to a named Provider only if it matches the last real successful named attempt, otherwise to unknown (`''`). UI maps null to `未知渠道` (`public/index.html:1563`). The existing 09-28 safe read-only report observed an HTTP 200 target `deepseek` with `actualProvider:null`; it does not establish actual remote channel or authorize a paid request in that task. Do not inspect full production logs or secrets in this planning note.

## Prices, times and provenance

- ClinePass docs, https://docs.cline.bot/getting-started/clinepass (fetched 2026-09-29), explicitly state $9.99/month subscription and that per-model figures are **reference prices**, not individually billed charges. Its DeepSeek V4.1 Flash listing shows only one $0.30/$1.20/$0.006 row, linking to direct DeepSeek documentation.
- DeepSeek pricing, https://api-docs.deepseek.com/quick_start/pricing/ (fetched 2026-09-29), gives UTC Mon–Fri 01:00–04:00 and 06:00–10:00 peak hours and excludes Chinese public holidays. This project was explicitly directed by the user to **ignore holidays** and use weekday/time windows only; that can overestimate holiday usage and is never an upstream bill. The page does not state which instant determines a cross-boundary request's charged tier, so this task uses terminal success time as the user's chosen local reference rule, not a claim about provider billing.
- `server.js:935-996,2687-2732` has immutable v1/v2 reference prices, strict snapshot validation, BigInt picodollar amounts, bounded versioned minute-cell accrual only for final success. Current DeepSeek amount returns lower and upper for every priced request; `public/index.html:1510-1525` displays a range whenever any version's model tier is peak/off-peak. Future selected-tier values and historical intervals need distinct version/read semantics and mixed-window truthfulness, not a rewrite of old cells.

## Pending runtime evidence

No actual paid upstream call, production setting change, production credential read, deployment or browser UI verification was performed during planning. Real response identity and whether it contains a trustworthy final Provider are unverified. The requested one-call check remains conditional on target release, cost/RPM/access controls and separate production-operation guidelines.
