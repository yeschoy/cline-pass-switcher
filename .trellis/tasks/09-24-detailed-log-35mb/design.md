# Production raw-body diagnostics — planning draft, security-sensitive

## Explicit product exception and hard dependency

The operator has authorized **production persistence and remote admin viewing of unredacted request/response bodies**, up to 48h, to reduce body sanitizer work. This does not authorize raw Headers, account configuration values, ordinary JSONL, model client diagnostic responses or secret-bearing list metadata. The body itself may contain secrets and private conversations: this is unavoidable and must be warned about rather than falsely called sanitized. **Do not start implementation before `09-24-separate-console-login` is complete**, client API keys cannot authenticate management APIs, and the administrator has performed first password change. Raw mode is a new explicit default-off choice; an existing enabled `detailedLogging` setting or an older sanitized manifest cannot silently opt into raw.

## Owners and limits

Keep `DetailRoot`/`BodyCapture` as the single observation owner and `DetailedLogStore` as the only publication/retention owner. Proposed cap: 35 MiB per body, 512 MiB shared retained-payload reservation; treat both as **diagnostic** limits, not outbound traffic/RSS caps. Reserve before copying with bounded per-root/account activity and pending publication; do not assume 512 MiB reservation implies <=512 MiB heap/RSS. Re-examine multiple bodies (ingress, upstream attempt input/output, downstream), possible duplication, and streaming backpressure. The existing 1 GiB disk cap remains; new raw groups expire within 48h even if capacity remains, sanitized legacy groups keep seven days. New manifest must distinguish raw versus sanitized and mark body `redacted` accurately, without exposing raw text in list/inventory. Reuse safe same-directory atomic group publication and group-level eviction, same generation/clear fences, no second store or reader that loads all bodies into memory.

Only skip **body** sanitization. Header and list metadata remain protected via bounded allowlisted projections/omission; don't scan 35 MiB raw bodies merely to assert metadata is redacted. Keep configured account keys and downstream authorization out of any proactively projected field. Any metadata value whose safety cannot be established without scanning raw text is omitted rather than leaked. Ordinary JSONL remains a strictly bounded projection. Preserve existing sanitized old groups and the error-only profile's failed-attempt selection. Diagnostic failure is fail-open for chat; auth and management setting persistence are fail-closed.

## Retrieval, retention, and deployment

Raw body API requires admin session/CSRF controls and no-store/nosniff, with on-demand streaming or bounded retrieval rather than eager inventory content; browser must warn and avoid retaining body text after navigation. Directory/file modes stay 0700/0600; ordinary service output contains no raw body. The 48h TTL is not a claim about external operator backups: advise excluding raw diagnostic directory from backups or enforce equivalent backup expiry outside this service. Rollback to the older shared-key server while raw bodies remain would expose them; rollout/rollback must keep raw mode off during transition or use a tested exclusion/invalidation path before starting old versions.

## Open review decisions

- Product wording `35 MB`/`512 MB` vs existing MiB boundaries; tentatively use 35 MiB/512 MiB and display unambiguous units.
- For non-UTF8 body bytes, define whether to store and serve as bytes with explicit type or omit safely; never silently corrupt original data or project it into HTML.
- Choose safe body copy/stream approach and verify resource ceilings in local stress tests before promising production capacity; preserve an explicit budget-failure state if admission is denied.
