# DeepSeek official reference rates and scope (read-only 2026-09-25)

Sources read without any account key or paid API calls:

- https://docs.cline.bot/getting-started/clinepass — current ClinePass reference table, USD per 1M tokens, 12 named models; $9.99/month subscription users are **not additionally charged** these individual rates.
- https://api-docs.deepseek.com/quick_start/pricing/ — DeepSeek direct API price page, USD per 1M tokens with peak/off-peak, and direct billing rules. Direct DeepSeek billing is **not** proof of an actual ClinePass invoice/remaining subscription balance.

| ClinePass model ID | Direct DeepSeek model/version | Tier | Input cache miss | Output | Input cache hit | Cached write |
|---|---|---|---:|---:|---:|---|
| `cline-pass/deepseek-v4-pro` | `deepseek-v4-pro` / DeepSeek-V4-Pro-0813 | peak | $1.32 | $3.96 | $0.044 | not listed |
| `cline-pass/deepseek-v4-pro` | `deepseek-v4-pro` / DeepSeek-V4-Pro-0813 | off-peak | $0.66 | $1.98 | $0.022 | not listed |
| `cline-pass/deepseek-v4.1-flash` | `deepseek-flash` / DeepSeek-V4.1-Flash | peak | $0.30 | $1.20 | $0.006 | not listed |
| `cline-pass/deepseek-v4.1-flash` | `deepseek-flash` / DeepSeek-V4.1-Flash | off-peak | $0.15 | $0.60 | $0.003 | not listed |

The ClinePass table currently publishes Pro peak/off-peak and V4.1 Flash peak only. The off-peak V4.1 Flash rates above come from **the user-specified DeepSeek direct official page**, not ClinePass's single Flash row. DeepSeek says peak is 01:00–04:00 and 06:00–10:00 UTC Monday through Friday **excluding Chinese public holidays**; other times are off-peak. The service currently stores no reliable holiday calendar or authoritative upstream billed-tier fact, so request-time valuation should be a labelled lower–upper **reference range**, not a guessed single tier. The direct doc accepts legacy `deepseek-v4-flash` model names but says they are retired and handled as V4.1 Flash **on DeepSeek's own API**; this does not prove `cline-pass/deepseek-v4-flash` is a ClinePass alias. Do not transfer the new Flash tariff to that legacy ClinePass ID without ClinePass evidence.

Current console quota projection (`public/index.html:1323-1347`) is independent: monthly reference remaining per account is `50 * (100 - monthly.percentUsed) / 100`, summed across eligible accounts. The model/Provider page's usage-equivalent amount uses explicit successful request input/output/cached-read tokens and frozen model rates; it must not alter the $50 monthly cap or claim actual billing. Known zero differs from absent usage; Qwen cached-write/context-tier counts remain unknown if not explicitly returned.
